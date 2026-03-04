/**
 * ListPredictionMarkets RPC -- proxies the Gamma API for Polymarket prediction markets.
 *
 * Critical constraint: Gamma API is behind Cloudflare JA3 fingerprint detection
 * that blocks server-side TLS connections. The handler tries the fetch and
 * gracefully returns empty on failure -- identical to the existing api/polymarket.js
 * behavior. This is expected, not an error.
 */

import type {
  PredictionServiceHandler,
  ServerContext,
  ListPredictionMarketsRequest,
  ListPredictionMarketsResponse,
  PredictionMarket,
} from '../../../../src/generated/server/worldmonitor/prediction/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'prediction:markets:v1';
const REDIS_CACHE_TTL = 600; // 10 min

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const MANIFOLD_BASE = 'https://api.manifold.markets/v0';
const FETCH_TIMEOUT = 8000;

// ---------- Internal Gamma API types ----------

interface GammaMarket {
  question: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string;
  volumeNum?: number;
  closed?: boolean;
  slug?: string;
  endDate?: string;
}

interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  volume?: number;
  markets?: GammaMarket[];
  closed?: boolean;
  endDate?: string;
}

interface ManifoldMarket {
  id?: string;
  question?: string;
  probability?: number;
  p?: number;
  volume?: number;
  closeTime?: number;
  url?: string;
  slug?: string;
  outcomeType?: string;
  isResolved?: boolean;
}

// ---------- Helpers ----------

/** Parse the yes-side price from a Gamma market's outcomePrices JSON string (0-1 scale). */
function parseYesPrice(market: GammaMarket): number {
  try {
    const pricesStr = market.outcomePrices;
    if (pricesStr) {
      const prices: string[] = JSON.parse(pricesStr);
      if (prices.length >= 1) {
        const parsed = parseFloat(prices[0]!);
        if (!isNaN(parsed)) return parsed; // 0-1 scale for proto
      }
    }
  } catch {
    /* keep default */
  }
  return 0.5;
}

/** Map a GammaEvent to a proto PredictionMarket (picks top market by volume). */
function mapEvent(event: GammaEvent, category: string): PredictionMarket {
  const topMarket = event.markets?.[0];
  const endDateStr = topMarket?.endDate ?? event.endDate;
  const closesAtMs = endDateStr ? Date.parse(endDateStr) : 0;

  return {
    id: event.id || '',
    title: topMarket?.question || event.title,
    yesPrice: topMarket ? parseYesPrice(topMarket) : 0.5,
    volume: event.volume ?? 0,
    url: `https://polymarket.com/event/${event.slug}`,
    closesAt: Number.isFinite(closesAtMs) ? closesAtMs : 0,
    category: category || '',
  };
}

/** Map a GammaMarket to a proto PredictionMarket. */
function mapMarket(market: GammaMarket): PredictionMarket {
  const closesAtMs = market.endDate ? Date.parse(market.endDate) : 0;
  return {
    id: market.slug || '',
    title: market.question,
    yesPrice: parseYesPrice(market),
    volume: (market.volumeNum ?? (market.volume ? parseFloat(market.volume) : 0)) || 0,
    url: `https://polymarket.com/market/${market.slug}`,
    closesAt: Number.isFinite(closesAtMs) ? closesAtMs : 0,
    category: '',
  };
}

function mapManifoldMarket(market: ManifoldMarket, category: string): PredictionMarket | null {
  const title = String(market.question || '').trim();
  if (!title) return null;

  const rawProbability = typeof market.probability === 'number'
    ? market.probability
    : (typeof market.p === 'number' ? market.p : 0.5);
  const yesPrice = Number.isFinite(rawProbability) ? Math.max(0, Math.min(1, rawProbability)) : 0.5;
  const volume = Number.isFinite(market.volume) ? Number(market.volume) : 0;
  const closesAt = Number.isFinite(market.closeTime) ? Number(market.closeTime) : 0;

  return {
    id: String(market.id || market.slug || title),
    title,
    yesPrice,
    volume,
    url: String(market.url || (market.slug ? `https://manifold.markets/market/${market.slug}` : 'https://manifold.markets')),
    closesAt,
    category: category || 'manifold',
  };
}

async function fetchFromManifold(
  req: ListPredictionMarketsRequest,
  limit: number,
): Promise<PredictionMarket[]> {
  const term = (req.query || req.category || '').trim();
  const endpoint = term
    ? `${MANIFOLD_BASE}/search-markets?term=${encodeURIComponent(term)}&limit=${limit}`
    : `${MANIFOLD_BASE}/markets?limit=${limit}`;

  const response = await fetch(endpoint, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!response.ok) return [];

  const data: unknown = await response.json();
  if (!Array.isArray(data)) return [];

  let markets = (data as ManifoldMarket[])
    .filter((m) => m?.outcomeType === 'BINARY' && !m?.isResolved)
    .map((m) => mapManifoldMarket(m, req.category))
    .filter((m): m is PredictionMarket => !!m);

  if (req.query) {
    const q = req.query.toLowerCase();
    markets = markets.filter((m) => m.title.toLowerCase().includes(q));
  }
  return markets.slice(0, limit);
}

// ---------- RPC ----------

export const listPredictionMarkets: PredictionServiceHandler['listPredictionMarkets'] = async (
  _ctx: ServerContext,
  req: ListPredictionMarketsRequest,
): Promise<ListPredictionMarketsResponse> => {
  try {
    const cacheKey = `${REDIS_CACHE_KEY}:${req.category || 'all'}:${req.query || ''}:${req.pageSize || 50}`;
    const result = await cachedFetchJson<ListPredictionMarketsResponse>(
      cacheKey,
      REDIS_CACHE_TTL,
      async () => {
        const useEvents = !!req.category;
        const endpoint = useEvents ? 'events' : 'markets';
        const limit = Math.max(1, Math.min(100, req.pageSize || 50));
        const params = new URLSearchParams({
          closed: 'false',
          active: 'true',
          archived: 'false',
          end_date_min: new Date().toISOString(),
          order: 'volume',
          ascending: 'false',
          limit: String(limit),
        });
        if (useEvents) {
          params.set('tag_slug', req.category);
        }

        let markets: PredictionMarket[] = [];
        try {
          const response = await fetch(
            `${GAMMA_BASE}/${endpoint}?${params}`,
            {
              headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
              signal: AbortSignal.timeout(FETCH_TIMEOUT),
            },
          );
          if (response.ok) {
            const data: unknown = await response.json();
            markets = useEvents
              ? (data as GammaEvent[]).map((e) => mapEvent(e, req.category))
              : (data as GammaMarket[]).map(mapMarket);
          }
        } catch {
          // fall through to manifold fallback
        }

        if (markets.length === 0) {
          const manifoldMarkets = await fetchFromManifold(req, limit);
          if (manifoldMarkets.length > 0) {
            return { markets: manifoldMarkets, pagination: undefined };
          }
        }

        if (req.query) {
          const q = req.query.toLowerCase();
          markets = markets.filter((m) => m.title.toLowerCase().includes(q));
        }

        return markets.length > 0 ? { markets, pagination: undefined } : null;
      },
    );
    return result || { markets: [], pagination: undefined };
  } catch {
    return { markets: [], pagination: undefined };
  }
};
