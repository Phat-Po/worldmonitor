/**
 * Shared helpers, types, and constants for the market service handler RPCs.
 */
import { CHROME_UA, yahooGate } from '../../../_shared/constants';

// ========================================================================
// Relay helpers (Railway proxy for Yahoo when Vercel IPs are rate-limited)
// ========================================================================

function getRelayBaseUrl(): string | null {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) return null;
  return relayUrl
    .replace(/^ws(s?):\/\//, 'http$1://')
    .replace(/\/$/, '');
}

function getRelayHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': CHROME_UA };
  const relaySecret = process.env.RELAY_SHARED_SECRET;
  if (relaySecret) {
    const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    headers[relayHeader] = relaySecret;
  }
  return headers;
}

function isNoRelayLocalMode(): boolean {
  const env = String(process.env.VERCEL_ENV || process.env.NODE_ENV || '').toLowerCase();
  return !getRelayBaseUrl() && (env === 'development' || env === 'dev' || env === '' || env === 'local');
}

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 10_000;
const STOOQ_TIMEOUT_MS = 8_000;

const STOOQ_SYMBOL_MAP: Record<string, string> = {
  '^GSPC': '^spx',
  '^DJI': '^dji',
  '^IXIC': '^ndq',
  '^VIX': '^vix',
  'GC=F': 'gc.f',
  'CL=F': 'cl.f',
  'NG=F': 'ng.f',
  'SI=F': 'si.f',
  'HG=F': 'hg.f',
  'BZ=F': 'brent.f',
  '^TASI.SR': '^tasi',
  'DFMGI.AE': 'dfm.ae',
  '^MSM': '^msm',
  'UAE': 'uae.us',
  'QAT': 'qat.us',
  'GULF': 'gulf.us',
  'IBIT': 'ibit.us',
  'FBTC': 'fbtc.us',
  'ARKB': 'arkb.us',
  'BITB': 'bitb.us',
  'GBTC': 'gbtc.us',
  'HODL': 'hodl.us',
  'BRRR': 'brrr.us',
  'EZBC': 'ezbc.us',
  'BTCO': 'btco.us',
  'BTCW': 'btcw.us',
  'QQQ': 'qqq.us',
  'XLP': 'xlp.us',
  'XLK': 'xlk.us',
  'XLF': 'xlf.us',
  'XLE': 'xle.us',
  'XLV': 'xlv.us',
  'XLY': 'xly.us',
  'BTC-USD': 'btcusd',
  'JPY=X': 'jpyusd',
};

/**
 * Defensive parser for repeated-string query params.
 * The sebuf codegen assigns `params.get("symbols")` (a string) to a field
 * typed as `string[]`.  At runtime `req.symbols` may therefore be a
 * comma-separated string rather than an actual array.
 */
export function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === 'string' && raw.length > 0) return raw.split(',').filter(Boolean);
  return [];
}

export async function fetchYahooQuotesBatch(
  symbols: string[],
): Promise<{ results: Map<string, { price: number; change: number; sparkline: number[] }>; rateLimited: boolean }> {
  const results = new Map<string, { price: number; change: number; sparkline: number[] }>();
  if (!symbols.length) return { results, rateLimited: false };

  let misses = 0;
  const concurrency = Math.max(2, Math.min(6, symbols.length));
  let cursor = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= symbols.length) break;
      const symbol = symbols[idx]!;
      const q = await fetchYahooQuote(symbol);
      if (q) results.set(symbol, q);
      else misses++;
    }
  });

  await Promise.all(workers);
  return { results, rateLimited: misses > symbols.length / 2 };
}

// Yahoo-only symbols: indices and futures not on Finnhub free tier
export const YAHOO_ONLY_SYMBOLS = new Set([
  '^GSPC', '^DJI', '^IXIC', '^VIX',
  'GC=F', 'CL=F', 'NG=F', 'SI=F', 'HG=F',
]);

// Known crypto IDs and their metadata
export const CRYPTO_META: Record<string, { name: string; symbol: string }> = {
  bitcoin: { name: 'Bitcoin', symbol: 'BTC' },
  ethereum: { name: 'Ethereum', symbol: 'ETH' },
  solana: { name: 'Solana', symbol: 'SOL' },
  ripple: { name: 'XRP', symbol: 'XRP' },
};

// ========================================================================
// Types
// ========================================================================

export interface YahooChartResponse {
  chart: {
    result: Array<{
      meta: {
        regularMarketPrice: number;
        chartPreviousClose?: number;
        previousClose?: number;
      };
      indicators?: {
        quote?: Array<{ close?: (number | null)[]; volume?: (number | null)[] }>;
      };
    }>;
  };
}

export interface CoinGeckoMarketItem {
  id: string;
  current_price: number;
  price_change_percentage_24h: number;
  sparkline_in_7d?: { price: number[] };
}

export interface CryptoCompareQuote {
  PRICE?: number;
  CHANGEPCT24HOUR?: number;
  TOTALVOLUME24HTO?: number;
  VOLUME24HOURTO?: number;
  MKTCAP?: number;
}

// ========================================================================
// Finnhub quote fetcher
// ========================================================================

export async function fetchFinnhubQuote(
  symbol: string,
  apiKey: string,
): Promise<{ symbol: string; price: number; changePercent: number } | null> {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA, 'X-Finnhub-Token': apiKey },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[Finnhub] ${symbol} HTTP ${resp.status}`);
      return null;
    }

    const data = await resp.json() as { c: number; d: number; dp: number; h: number; l: number; o: number; pc: number; t: number };
    if (data.c === 0 && data.h === 0 && data.l === 0) {
      console.warn(`[Finnhub] ${symbol} returned zeros (market closed or invalid)`);
      return null;
    }

    return { symbol, price: data.c, changePercent: data.dp };
  } catch (err) {
    console.warn(`[Finnhub] ${symbol} error:`, (err as Error).message);
    return null;
  }
}

// ========================================================================
// Yahoo Finance quote fetcher
// ========================================================================
// TODO: Add Financial Modeling Prep (FMP) as Yahoo Finance fallback.
//
// FMP API docs: https://site.financialmodelingprep.com/developer/docs
// Auth: API key required — env var FMP_API_KEY
// Free tier: 250 requests/day (paid tiers for higher volume)
//
// Endpoint mapping (Yahoo → FMP):
//   Quote:      /stable/quote?symbol=AAPL           (batch: comma-separated)
//   Indices:    /stable/quote?symbol=^GSPC           (^GSPC, ^DJI, ^IXIC supported)
//   Commodities:/stable/quote?symbol=GCUSD           (gold=GCUSD, oil=CLUSD, etc.)
//   Forex:      /stable/batch-forex-quotes            (JPY/USD pairs)
//   Crypto:     /stable/batch-crypto-quotes           (BTC, ETH, etc.)
//   Sparkline:  /stable/historical-price-eod/light?symbol=AAPL  (daily close)
//   Intraday:   /stable/historical-chart/1min?symbol=AAPL
//
// Symbol mapping needed:
//   ^GSPC → ^GSPC (same), ^VIX → ^VIX (same)
//   GC=F → GCUSD, CL=F → CLUSD, NG=F → NGUSD, SI=F → SIUSD, HG=F → HGUSD
//   JPY=X → JPYUSD (forex pair format differs)
//   BTC-USD → BTCUSD
//
// Implementation plan:
//   1. Add FMP_API_KEY to SUPPORTED_SECRET_KEYS in main.rs + settings UI
//   2. Create fetchFMPQuote() here returning same shape as fetchYahooQuote()
//   3. fetchYahooQuote() tries Yahoo first → on 429/failure, tries FMP if key exists
//   4. economic/_shared.ts fetchJSON() same fallback for Yahoo chart URLs
//   5. get-macro-signals.ts needs chart data (1y range) — use /stable/historical-price-eod/light
// ========================================================================

function parseYahooChartResponse(data: YahooChartResponse): { price: number; change: number; sparkline: number[] } | null {
  const result = data.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) return null;

  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose || price;
  const change = ((price - prevClose) / prevClose) * 100;

  const closes = result.indicators?.quote?.[0]?.close;
  const sparkline = closes?.filter((v): v is number => v != null) || [];

  return { price, change, sparkline };
}

function parseCsvNumber(raw?: string): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'N/D') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function toStooqSymbol(symbol: string): string | null {
  const mapped = STOOQ_SYMBOL_MAP[symbol];
  if (mapped) return mapped;

  const forexMatch = symbol.match(/^([A-Z]{3})([A-Z]{3})=X$/);
  if (forexMatch) {
    return `${forexMatch[1]!.toLowerCase()}${forexMatch[2]!.toLowerCase()}`;
  }

  if (/^[A-Z]{1,6}$/.test(symbol)) {
    return `${symbol.toLowerCase()}.us`;
  }

  return null;
}

export async function fetchStooqQuote(
  symbol: string,
): Promise<{ price: number; change: number; sparkline: number[] } | null> {
  const stooqSymbol = toStooqSymbol(symbol);
  if (!stooqSymbol) return null;

  try {
    const quoteUrl = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol)}&f=sd2t2ohlcv&h&e=csv`;
    const resp = await fetch(quoteUrl, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv' },
      signal: AbortSignal.timeout(STOOQ_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[Stooq] ${symbol} HTTP ${resp.status}`);
      return null;
    }

    const csv = (await resp.text()).trim();
    const rows = csv.split('\n').filter(Boolean);
    if (rows.length < 2) return null;

    const cols = rows[1]!.split(',');
    if (cols.length < 7) return null;

    const open = parseCsvNumber(cols[3]);
    const close = parseCsvNumber(cols[6]);
    if (close == null) return null;

    const change = open && open > 0 ? ((close - open) / open) * 100 : 0;
    return { price: close, change, sparkline: [] };
  } catch (err) {
    console.warn(`[Stooq] ${symbol} error:`, (err as Error).message);
    return null;
  }
}

export async function fetchYahooQuote(
  symbol: string,
): Promise<{ price: number; change: number; sparkline: number[] } | null> {
  // Local dev without relay: Yahoo often 403s from CN paths.
  // Go directly to Stooq first to avoid repeated Yahoo gate delays.
  if (isNoRelayLocalMode()) {
    const stooqFirst = await fetchStooqQuote(symbol);
    if (stooqFirst) return stooqFirst;
  }

  // Try direct Yahoo first
  try {
    await yahooGate();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (resp.ok) {
      const data: YahooChartResponse = await resp.json();
      const parsed = parseYahooChartResponse(data);
      if (parsed) return parsed;
    } else {
      console.warn(`[Yahoo] ${symbol} direct HTTP ${resp.status}`);
    }
  } catch (err) {
    console.warn(`[Yahoo] ${symbol} direct error:`, (err as Error).message);
  }

  // Fallback: Railway relay (different IP, not rate-limited by Yahoo)
  const relayBase = getRelayBaseUrl();
  if (relayBase) {
    try {
      const relayUrl = `${relayBase}/yahoo-chart?symbol=${encodeURIComponent(symbol)}`;
      const resp = await fetch(relayUrl, {
        headers: getRelayHeaders(),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!resp.ok) {
        console.warn(`[Yahoo] ${symbol} relay HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
      } else {
        const data: YahooChartResponse = await resp.json();
        const parsed = parseYahooChartResponse(data);
        if (parsed) return parsed;
      }
    } catch (err) {
      console.warn(`[Yahoo] ${symbol} relay error:`, (err as Error).message);
    }
  } else {
    console.warn(`[Yahoo] ${symbol} relay skipped: WS_RELAY_URL not set`);
  }

  // Final fallback: Stooq public quotes (works in many Yahoo-blocked regions)
  const stooq = await fetchStooqQuote(symbol);
  if (stooq) return stooq;

  return null;
}

// ========================================================================
// CoinGecko fetcher
// ========================================================================

export async function fetchCoinGeckoMarkets(
  ids: string[],
): Promise<CoinGeckoMarketItem[]> {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(',')}&order=market_cap_desc&sparkline=true&price_change_percentage=24h`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`CoinGecko HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  if (!Array.isArray(data)) {
    throw new Error(`CoinGecko returned non-array: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

export async function fetchCryptoCompareQuotes(
  symbols: string[],
): Promise<Record<string, CryptoCompareQuote>> {
  const normalized = [...new Set(symbols.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean))];
  if (!normalized.length) return {};

  const url = `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${encodeURIComponent(normalized.join(','))}&tsyms=USD`;
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`CryptoCompare HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const payload = await resp.json() as { RAW?: Record<string, { USD?: CryptoCompareQuote }> };
  const raw = payload?.RAW || {};
  const out: Record<string, CryptoCompareQuote> = {};
  for (const sym of normalized) {
    const quote = raw[sym]?.USD;
    if (quote && typeof quote === 'object') out[sym] = quote;
  }
  return out;
}
