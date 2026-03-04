/**
 * RPC: ListCryptoQuotes
 * Fetches cryptocurrency quotes from CoinGecko markets API.
 */

import type {
  ServerContext,
  ListCryptoQuotesRequest,
  ListCryptoQuotesResponse,
  CryptoQuote,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { CRYPTO_META, fetchCoinGeckoMarkets, fetchCryptoCompareQuotes, parseStringArray } from './_shared';
import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'market:crypto:v1';
const REDIS_CACHE_TTL = 600; // 10 min — CoinGecko rate-limited

const fallbackCryptoCache = new Map<string, { data: ListCryptoQuotesResponse; ts: number }>();

export async function listCryptoQuotes(
  _ctx: ServerContext,
  req: ListCryptoQuotesRequest,
): Promise<ListCryptoQuotesResponse> {
  const parsedIds = parseStringArray(req.ids);
  const ids = parsedIds.length > 0 ? parsedIds : Object.keys(CRYPTO_META);

  const cacheKey = `${REDIS_CACHE_KEY}:${[...ids].sort().join(',')}`;

  try {
  const result = await cachedFetchJson<ListCryptoQuotesResponse>(cacheKey, REDIS_CACHE_TTL, async () => {
    const quotes: CryptoQuote[] = [];
    try {
      const items = await fetchCoinGeckoMarkets(ids);
      const byId = new Map(items.map((c) => [c.id, c]));

      for (const id of ids) {
        const coin = byId.get(id);
        if (!coin) continue;
        const meta = CRYPTO_META[id];
        const prices = coin.sparkline_in_7d?.price;
        const sparkline = prices && prices.length > 24 ? prices.slice(-48) : (prices || []);

        quotes.push({
          name: meta?.name || id,
          symbol: meta?.symbol || id.toUpperCase(),
          price: coin.current_price ?? 0,
          change: coin.price_change_percentage_24h ?? 0,
          sparkline,
        });
      }
    } catch {
      // fall through to CryptoCompare fallback
    }

    if (quotes.length === 0 || quotes.every(q => q.price === 0)) {
      const symbols = ids.map((id) => (CRYPTO_META[id]?.symbol || id).toUpperCase());
      const cc = await fetchCryptoCompareQuotes(symbols);
      for (const id of ids) {
        const symbol = (CRYPTO_META[id]?.symbol || id).toUpperCase();
        const quote = cc[symbol];
        if (!quote || !Number.isFinite(quote.PRICE) || Number(quote.PRICE) <= 0) continue;
        quotes.push({
          name: CRYPTO_META[id]?.name || id,
          symbol,
          price: Number(quote.PRICE),
          change: Number(quote.CHANGEPCT24HOUR || 0),
          sparkline: [],
        });
      }
    }

    return quotes.length > 0 ? { quotes } : null;
  });

  if (result) {
    if (fallbackCryptoCache.size > 50) fallbackCryptoCache.clear();
    fallbackCryptoCache.set(cacheKey, { data: result, ts: Date.now() });
  }
  return result || fallbackCryptoCache.get(cacheKey)?.data || { quotes: [] };
  } catch {
    return fallbackCryptoCache.get(cacheKey)?.data || { quotes: [] };
  }
}
