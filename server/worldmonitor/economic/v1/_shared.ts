/**
 * Shared helpers for the economic domain RPCs.
 */

import { CHROME_UA, yahooGate } from '../../../_shared/constants';

const STOOQ_TIMEOUT_MS = 10_000;
const STOOQ_SYMBOL_MAP: Record<string, string> = {
  'JPY=X': 'jpyusd',
  'BTC-USD': 'btcusd',
  'QQQ': 'qqq.us',
  'XLP': 'xlp.us',
};

function parseCsvNum(raw?: string): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'N/D') return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

function toStooqSymbol(yahooSymbol: string): string | null {
  const mapped = STOOQ_SYMBOL_MAP[yahooSymbol];
  if (mapped) return mapped;
  if (/^[A-Z]{1,6}$/.test(yahooSymbol)) return `${yahooSymbol.toLowerCase()}.us`;
  return null;
}

function rangeToPoints(range: string): number {
  if (range === '1d') return 1;
  if (range === '5d') return 5;
  if (range === '1mo') return 22;
  if (range === '3mo') return 66;
  if (range === '6mo') return 132;
  if (range === '1y') return 252;
  if (range === '2y') return 504;
  if (range === '5y') return 1260;
  return 252;
}

function shouldPreferStooqInLocalDev(): boolean {
  const env = String(process.env.VERCEL_ENV || process.env.NODE_ENV || '').toLowerCase();
  return !process.env.WS_RELAY_URL && (env === 'development' || env === 'dev' || env === '' || env === 'local');
}

async function fetchYahooChartViaStooq(yahooUrl: string): Promise<any | null> {
  try {
    const parsed = new URL(yahooUrl);
    const chartPathMatch = parsed.pathname.match(/\/v8\/finance\/chart\/(.+)$/);
    if (!chartPathMatch) return null;

    const yahooSymbol = decodeURIComponent(chartPathMatch[1]!);
    const stooqSymbol = toStooqSymbol(yahooSymbol);
    if (!stooqSymbol) return null;

    const historyUrl = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`;
    const resp = await fetch(historyUrl, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv' },
      signal: AbortSignal.timeout(STOOQ_TIMEOUT_MS),
    });
    if (!resp.ok) return null;

    const csv = (await resp.text()).trim();
    const rows = csv.split('\n').slice(1).filter(Boolean);
    if (rows.length < 2) return null;

    const targetPoints = rangeToPoints(parsed.searchParams.get('range') || '1y');
    const clipped = rows.slice(-targetPoints);
    const closes: number[] = [];
    const volumes: number[] = [];
    for (const row of clipped) {
      const cols = row.split(',');
      if (cols.length < 6) continue;
      const close = parseCsvNum(cols[4]);
      const volume = parseCsvNum(cols[5]);
      if (close != null) closes.push(close);
      if (volume != null) volumes.push(volume);
    }
    if (closes.length < 2) return null;

    const latest = closes[closes.length - 1]!;
    const prev = closes[closes.length - 2] ?? latest;
    return {
      chart: {
        result: [{
          meta: {
            regularMarketPrice: latest,
            previousClose: prev,
            chartPreviousClose: prev,
          },
          indicators: {
            quote: [{
              close: closes,
              volume: volumes,
            }],
          },
        }],
      },
    };
  } catch {
    return null;
  }
}

/**
 * Fetch JSON from a URL with a configurable timeout.
 * Rejects on non-2xx status.
 */
export async function fetchJSON(url: string, timeout = 8000): Promise<any> {
  const isYahooChart = url.includes('finance.yahoo.com/v8/finance/chart');
  if (isYahooChart && shouldPreferStooqInLocalDev()) {
    const fallback = await fetchYahooChartViaStooq(url);
    if (fallback) return fallback;
  }
  if (url.includes('yahoo.com')) await yahooGate();
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': CHROME_UA }, signal: controller.signal });
    if (!res.ok) {
      if (isYahooChart) {
        const fallback = await fetchYahooChartViaStooq(url);
        if (fallback) return fallback;
      }
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (isYahooChart) {
      const fallback = await fetchYahooChartViaStooq(url);
      if (fallback) return fallback;
    }
    throw err;
  } finally {
    clearTimeout(id);
  }
}

/**
 * Rate of change between the most recent price and the price `days` ago.
 * Returns null if there is insufficient data.
 */
export function rateOfChange(prices: number[], days: number): number | null {
  if (!prices || prices.length < days + 1) return null;
  const recent = prices[prices.length - 1];
  const past = prices[prices.length - 1 - days];
  if (!past || past === 0) return null;
  return ((recent! - past) / past) * 100;
}

/**
 * Simple moving average over the last `period` entries.
 */
export function smaCalc(prices: number[], period: number): number | null {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

/**
 * Extract closing prices from a Yahoo Finance v8 chart response.
 */
export function extractClosePrices(chart: any): number[] {
  try {
    const result = chart?.chart?.result?.[0];
    return result?.indicators?.quote?.[0]?.close?.filter((p: any) => p != null) || [];
  } catch {
    return [];
  }
}

/**
 * Extract volumes from a Yahoo Finance v8 chart response.
 */
export function extractVolumes(chart: any): number[] {
  try {
    const result = chart?.chart?.result?.[0];
    return result?.indicators?.quote?.[0]?.volume?.filter((v: any) => v != null) || [];
  } catch {
    return [];
  }
}

/**
 * Extract aligned price/volume pairs from a Yahoo Finance v8 chart response.
 * Only includes entries where both price and volume are non-null.
 */
export function extractAlignedPriceVolume(chart: any): Array<{ price: number; volume: number }> {
  try {
    const result = chart?.chart?.result?.[0];
    const closes: any[] = result?.indicators?.quote?.[0]?.close || [];
    const volumes: any[] = result?.indicators?.quote?.[0]?.volume || [];
    const pairs: Array<{ price: number; volume: number }> = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] != null && volumes[i] != null) {
        pairs.push({ price: closes[i], volume: volumes[i] });
      }
    }
    return pairs;
  } catch {
    return [];
  }
}
