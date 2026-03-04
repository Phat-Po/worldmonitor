/**
 * RPC: ListEtfFlows
 * Estimates BTC spot ETF flow direction from Yahoo Finance volume/price data.
 */

import type {
  ServerContext,
  ListEtfFlowsRequest,
  ListEtfFlowsResponse,
  EtfFlow,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { UPSTREAM_TIMEOUT_MS, type YahooChartResponse } from './_shared';
import { CHROME_UA, yahooGate } from '../../../_shared/constants';
import { cachedFetchJson } from '../../../_shared/redis';

// ========================================================================
// Constants and cache
// ========================================================================

const REDIS_CACHE_KEY = 'market:etf-flows:v1';
const REDIS_CACHE_TTL = 600; // 10 min — daily volume data, slow-moving

const ETF_LIST = [
  { ticker: 'IBIT', issuer: 'BlackRock' },
  { ticker: 'FBTC', issuer: 'Fidelity' },
  { ticker: 'ARKB', issuer: 'ARK/21Shares' },
  { ticker: 'BITB', issuer: 'Bitwise' },
  { ticker: 'GBTC', issuer: 'Grayscale' },
  { ticker: 'HODL', issuer: 'VanEck' },
  { ticker: 'BRRR', issuer: 'Valkyrie' },
  { ticker: 'EZBC', issuer: 'Franklin' },
  { ticker: 'BTCO', issuer: 'Invesco' },
  { ticker: 'BTCW', issuer: 'WisdomTree' },
];

let etfCache: ListEtfFlowsResponse | null = null;
let etfCacheTimestamp = 0;
const ETF_CACHE_TTL = 900_000; // 15 minutes (in-memory fallback)

function shouldPreferStooqInLocalDev(): boolean {
  const env = String(process.env.VERCEL_ENV || process.env.NODE_ENV || '').toLowerCase();
  return !process.env.WS_RELAY_URL && (env === 'development' || env === 'dev' || env === '' || env === 'local');
}

// ========================================================================
// Helpers
// ========================================================================

async function fetchEtfChart(ticker: string): Promise<YahooChartResponse | null> {
  if (!shouldPreferStooqInLocalDev()) {
    try {
      await yahooGate();
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=5d&interval=1d`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': CHROME_UA,
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (resp.ok) {
        return (await resp.json()) as YahooChartResponse;
      }
    } catch {
      // fall through to Stooq
    }
  }

  // Fallback for regions where Yahoo blocks/ratelimits: Stooq daily CSV.
  try {
    const stooqSymbol = `${ticker.toLowerCase()}.us`;
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const csv = (await resp.text()).trim();
    const rows = csv.split('\n').slice(1).filter(Boolean);
    if (rows.length < 2) return null;

    const closes: number[] = [];
    const volumes: number[] = [];
    for (const row of rows) {
      const cols = row.split(',');
      if (cols.length < 6) continue;
      const close = Number(cols[4]);
      const volume = Number(cols[5]);
      if (Number.isFinite(close)) closes.push(close);
      if (Number.isFinite(volume)) volumes.push(volume);
    }
    if (closes.length < 2) return null;

    const tailCloses = closes.slice(-5);
    const tailVolumes = volumes.slice(-5);
    const latest = tailCloses[tailCloses.length - 1]!;
    const prev = tailCloses[tailCloses.length - 2] ?? latest;

    return {
      chart: {
        result: [{
          meta: {
            regularMarketPrice: latest,
            previousClose: prev,
          },
          indicators: {
            quote: [{
              close: tailCloses,
              volume: tailVolumes,
            }],
          },
        }],
      },
    };
  } catch {
    return null;
  }
}

function parseEtfChartData(chart: YahooChartResponse, ticker: string, issuer: string): EtfFlow | null {
  try {
    const result = chart?.chart?.result?.[0];
    if (!result) return null;

    const quote = result.indicators?.quote?.[0];
    const closes = (quote as { close?: (number | null)[] })?.close || [];
    const volumes = (quote as { volume?: (number | null)[] })?.volume || [];

    const validCloses = closes.filter((p): p is number => p != null);
    const validVolumes = volumes.filter((v): v is number => v != null);

    if (validCloses.length < 2) return null;

    const latestPrice = validCloses[validCloses.length - 1]!;
    const prevPrice = validCloses[validCloses.length - 2]!;
    const priceChange = prevPrice ? ((latestPrice - prevPrice) / prevPrice * 100) : 0;

    const latestVolume = validVolumes.length > 0 ? validVolumes[validVolumes.length - 1]! : 0;
    const avgVolume = validVolumes.length > 1
      ? validVolumes.slice(0, -1).reduce((a, b) => a + b, 0) / (validVolumes.length - 1)
      : latestVolume;

    const volumeRatio = avgVolume > 0 ? latestVolume / avgVolume : 1;
    const direction = priceChange > 0.1 ? 'inflow' : priceChange < -0.1 ? 'outflow' : 'neutral';
    const estFlowMagnitude = latestVolume * latestPrice * (priceChange > 0 ? 1 : -1) * 0.1;

    return {
      ticker,
      issuer,
      price: +latestPrice.toFixed(2),
      priceChange: +priceChange.toFixed(2),
      volume: latestVolume,
      avgVolume: Math.round(avgVolume),
      volumeRatio: +volumeRatio.toFixed(2),
      direction,
      estFlow: Math.round(estFlowMagnitude),
    };
  } catch {
    return null;
  }
}

// ========================================================================
// Handler
// ========================================================================

export async function listEtfFlows(
  _ctx: ServerContext,
  _req: ListEtfFlowsRequest,
): Promise<ListEtfFlowsResponse> {
  const now = Date.now();
  if (etfCache && now - etfCacheTimestamp < ETF_CACHE_TTL) {
    return etfCache;
  }

  try {
  const result = await cachedFetchJson<ListEtfFlowsResponse>(REDIS_CACHE_KEY, REDIS_CACHE_TTL, async () => {
    const settled = await Promise.allSettled(
      ETF_LIST.map(async (etf) => {
        const chart = await fetchEtfChart(etf.ticker);
        if (!chart) return null;
        return parseEtfChartData(chart, etf.ticker, etf.issuer);
      }),
    );

    const etfs: EtfFlow[] = settled
      .filter((r): r is PromiseFulfilledResult<EtfFlow | null> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((r): r is EtfFlow => !!r);
    const misses = ETF_LIST.length - etfs.length;

    // If Yahoo rate-limited all calls, return null — outer handler serves stale
    if (etfs.length === 0 && etfCache) {
      return null;
    }

    if (etfs.length === 0) {
      return misses >= 3
        ? { timestamp: new Date().toISOString(), etfs: [], rateLimited: true }
        : null;
    }

    const totalVolume = etfs.reduce((sum, e) => sum + e.volume, 0);
    const totalEstFlow = etfs.reduce((sum, e) => sum + e.estFlow, 0);
    const inflowCount = etfs.filter(e => e.direction === 'inflow').length;
    const outflowCount = etfs.filter(e => e.direction === 'outflow').length;

    etfs.sort((a, b) => b.volume - a.volume);

    return {
      timestamp: new Date().toISOString(),
      summary: {
        etfCount: etfs.length,
        totalVolume,
        totalEstFlow,
        netDirection: totalEstFlow > 0 ? 'NET INFLOW' : totalEstFlow < 0 ? 'NET OUTFLOW' : 'NEUTRAL',
        inflowCount,
        outflowCount,
      },
      etfs,
      rateLimited: false,
    };
  });

  if (result) {
    etfCache = result;
    etfCacheTimestamp = now;
  }

  return result || etfCache || {
    timestamp: new Date().toISOString(),
    summary: {
      etfCount: 0,
      totalVolume: 0,
      totalEstFlow: 0,
      netDirection: 'UNAVAILABLE',
      inflowCount: 0,
      outflowCount: 0,
    },
    etfs: [],
    rateLimited: false,
  };
  } catch {
    return etfCache || {
      timestamp: new Date().toISOString(),
      summary: {
        etfCount: 0,
        totalVolume: 0,
        totalEstFlow: 0,
        netDirection: 'UNAVAILABLE',
        inflowCount: 0,
        outflowCount: 0,
      },
      etfs: [],
      rateLimited: false,
    };
  }
}
