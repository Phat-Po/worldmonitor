import type {
  ServerContext,
  ListFeedDigestRequest,
  ListFeedDigestResponse,
  CategoryBucket,
  NewsItem as ProtoNewsItem,
  ThreatLevel as ProtoThreatLevel,
} from '../../../../src/generated/server/worldmonitor/news/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';
import { VARIANT_FEEDS, INTEL_SOURCES, type ServerFeed } from './_feeds';
import { classifyByKeyword, type ThreatLevel } from './_classifier';

function getRelayBaseUrl(): string | null {
  const relayUrl = process.env.WS_RELAY_URL;
  if (!relayUrl) return null;
  return relayUrl
    .replace(/^ws(s?):\/\//, 'http$1://')
    .replace(/\/$/, '');
}

function getRelayHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': CHROME_UA,
    Accept: 'application/rss+xml, application/xml, text/xml, */*',
  };
  const relaySecret = process.env.RELAY_SHARED_SECRET;
  if (relaySecret) {
    const relayHeader = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
    headers[relayHeader] = relaySecret;
  }
  return headers;
}

const VALID_VARIANTS = new Set(['full', 'tech', 'finance', 'happy']);
const fallbackDigestCache = new Map<string, { data: ListFeedDigestResponse; ts: number }>();
const ITEMS_PER_FEED = 5;
const MAX_ITEMS_PER_CATEGORY = 20;

function readPositiveIntEnv(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  const parsed = Number.parseInt(String(raw || ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

const relayAvailable = Boolean(getRelayBaseUrl());
const FEED_TIMEOUT_MS = readPositiveIntEnv('RSS_DIGEST_FEED_TIMEOUT_MS', relayAvailable ? 10_000 : 8_000, 3_000, 30_000);
const OVERALL_DEADLINE_MS = readPositiveIntEnv('RSS_DIGEST_OVERALL_DEADLINE_MS', relayAvailable ? 40_000 : 55_000, 8_000, 120_000);
const BATCH_CONCURRENCY = readPositiveIntEnv('RSS_DIGEST_BATCH_CONCURRENCY', relayAvailable ? 10 : 12, 1, 24);

const LEVEL_TO_PROTO: Record<ThreatLevel, ProtoThreatLevel> = {
  critical: 'THREAT_LEVEL_CRITICAL',
  high: 'THREAT_LEVEL_HIGH',
  medium: 'THREAT_LEVEL_MEDIUM',
  low: 'THREAT_LEVEL_LOW',
  info: 'THREAT_LEVEL_UNSPECIFIED',
};

interface ParsedItem {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
  isAlert: boolean;
  level: ThreatLevel;
  category: string;
  confidence: number;
  classSource: 'keyword';
}

type FeedHealthStatus = 'ok' | 'empty' | 'timeout' | 'failed';
type FeedFetchChannel = 'direct' | 'relay' | 'none';

interface FeedStatusDetail {
  status: FeedHealthStatus;
  reason: string;
  statusCode?: number;
  errorType?: string;
  message?: string;
  fetchedVia: FeedFetchChannel;
  url: string;
  category: string;
  updatedAt: string;
}

interface FeedFetchResult {
  items: ParsedItem[];
  status: FeedHealthStatus;
  reason: string;
  statusCode?: number;
  errorType?: string;
  message?: string;
  fetchedVia: FeedFetchChannel;
}

interface FetchTextResult {
  ok: boolean;
  text?: string;
  statusCode?: number;
  errorType?: string;
  message?: string;
  timedOut?: boolean;
}

interface FeedFetchErrorState extends FetchTextResult {
  source: 'direct' | 'relay';
}

type ListFeedDigestExtendedResponse = ListFeedDigestResponse & {
  feedStatusDetails?: Record<string, FeedStatusDetail>;
};

function buildEmptyDigestResponse(): ListFeedDigestResponse {
  return {
    categories: {},
    feedStatuses: {},
    generatedAt: new Date().toISOString(),
  };
}

function attachFeedStatusDetails(
  response: ListFeedDigestResponse,
  details: Record<string, FeedStatusDetail>,
): ListFeedDigestResponse {
  if (Object.keys(details).length === 0) return response;
  (response as ListFeedDigestExtendedResponse).feedStatusDetails = details;
  return response;
}

async function fetchRssText(
  url: string,
  signal: AbortSignal,
): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': CHROME_UA,
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      return {
        ok: false,
        statusCode: resp.status,
        errorType: 'upstream_http_error',
        message: `HTTP ${resp.status}`,
      };
    }
    return {
      ok: true,
      text,
      statusCode: resp.status,
    };
  } catch (error: any) {
    const isTimeout =
      error?.name === 'AbortError' ||
      /timed? ?out|timeout/i.test(String(error?.message || ''));
    return {
      ok: false,
      timedOut: isTimeout,
      errorType: isTimeout ? 'feed_timeout' : 'network_error',
      message: String(error?.message || ''),
    };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', onAbort);
  }
}

async function fetchAndParseRss(
  feed: ServerFeed,
  variant: string,
  signal: AbortSignal,
): Promise<FeedFetchResult> {
  const direct = await fetchRssText(feed.url, signal);
  if (direct.ok && direct.text) {
    const parsed = parseRssXml(direct.text, feed, variant);
    if (parsed && parsed.length > 0) {
      return {
        items: parsed,
        status: 'ok',
        reason: 'ok',
        statusCode: direct.statusCode,
        fetchedVia: 'direct',
      };
    }
    return {
      items: [],
      status: 'empty',
      reason: 'no_items_in_feed',
      statusCode: direct.statusCode,
      fetchedVia: 'direct',
    };
  }

  let finalError: FeedFetchErrorState = { ...direct, source: 'direct' };
  const relayBase = getRelayBaseUrl();
  if (relayBase && !signal.aborted) {
    const relayUrl = `${relayBase}/rss?url=${encodeURIComponent(feed.url)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const resp = await fetch(relayUrl, {
        headers: getRelayHeaders(),
        signal: controller.signal,
      });
      const relayText = await resp.text();
      if (resp.ok) {
        const parsed = parseRssXml(relayText, feed, variant);
        if (parsed && parsed.length > 0) {
          return {
            items: parsed,
            status: 'ok',
            reason: 'ok',
            statusCode: resp.status,
            fetchedVia: 'relay',
          };
        }
        return {
          items: [],
          status: 'empty',
          reason: 'no_items_in_feed',
          statusCode: resp.status,
          fetchedVia: 'relay',
        };
      }
      finalError = {
        ok: false,
        statusCode: resp.status,
        errorType: 'upstream_http_error',
        message: `HTTP ${resp.status}`,
        source: 'relay',
      };
    } catch (error: any) {
      const isTimeout =
        error?.name === 'AbortError' ||
        /timed? ?out|timeout/i.test(String(error?.message || ''));
      finalError = {
        ok: false,
        timedOut: isTimeout,
        errorType: isTimeout ? 'feed_timeout' : 'network_error',
        message: String(error?.message || ''),
        source: 'relay',
      };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
    }
  }

  const timedOut = signal.aborted || finalError.timedOut;
  return {
    items: [],
    status: timedOut ? 'timeout' : 'failed',
    reason: finalError.errorType || (timedOut ? 'feed_timeout' : 'fetch_failed'),
    statusCode: finalError.statusCode,
    errorType: finalError.errorType,
    message: finalError.message,
    fetchedVia: finalError.source,
  };
}

function parseRssXml(xml: string, feed: ServerFeed, variant: string): ParsedItem[] | null {
  const items: ParsedItem[] = [];

  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;

  let matches = [...xml.matchAll(itemRegex)];
  const isAtom = matches.length === 0;
  if (isAtom) matches = [...xml.matchAll(entryRegex)];

  for (const match of matches.slice(0, ITEMS_PER_FEED)) {
    const block = match[1]!;

    const title = extractTag(block, 'title');
    if (!title) continue;

    let link: string;
    if (isAtom) {
      const hrefMatch = block.match(/<link[^>]+href=["']([^"']+)["']/);
      link = hrefMatch?.[1] ?? '';
    } else {
      link = extractTag(block, 'link');
    }

    const pubDateStr = isAtom
      ? (extractTag(block, 'published') || extractTag(block, 'updated'))
      : extractTag(block, 'pubDate');
    const parsedDate = pubDateStr ? new Date(pubDateStr) : new Date();
    const publishedAt = Number.isNaN(parsedDate.getTime()) ? Date.now() : parsedDate.getTime();

    const threat = classifyByKeyword(title, variant);
    const isAlert = threat.level === 'critical' || threat.level === 'high';

    items.push({
      source: feed.name,
      title,
      link,
      publishedAt,
      isAlert,
      level: threat.level,
      category: threat.category,
      confidence: threat.confidence,
      classSource: 'keyword',
    });
  }

  return items.length > 0 ? items : null;
}

const TAG_REGEX_CACHE = new Map<string, { cdata: RegExp; plain: RegExp }>();
const KNOWN_TAGS = ['title', 'link', 'pubDate', 'published', 'updated'] as const;
for (const tag of KNOWN_TAGS) {
  TAG_REGEX_CACHE.set(tag, {
    cdata: new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'),
    plain: new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'),
  });
}

function extractTag(xml: string, tag: string): string {
  const cached = TAG_REGEX_CACHE.get(tag);
  const cdataRe = cached?.cdata ?? new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
  const plainRe = cached?.plain ?? new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');

  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1]!.trim();

  const match = xml.match(plainRe);
  return match ? decodeXmlEntities(match[1]!.trim()) : '';
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function toProtoItem(item: ParsedItem): ProtoNewsItem {
  return {
    source: item.source,
    title: item.title,
    link: item.link,
    publishedAt: item.publishedAt,
    isAlert: item.isAlert,
    threat: {
      level: LEVEL_TO_PROTO[item.level],
      category: item.category,
      confidence: item.confidence,
      source: item.classSource,
    },
    locationName: '',
  };
}

export async function listFeedDigest(
  _ctx: ServerContext,
  req: ListFeedDigestRequest,
): Promise<ListFeedDigestResponse> {
  const variant = VALID_VARIANTS.has(req.variant) ? req.variant : 'full';
  const lang = req.lang || 'en';

  const digestCacheKey = `news:digest:v1:${variant}:${lang}`;

  const fallbackKey = `${variant}:${lang}`;
  try {
    const cached = await cachedFetchJson<ListFeedDigestResponse>(digestCacheKey, 900, async () => {
      return buildDigest(variant, lang);
    });
    if (cached) {
      if (fallbackDigestCache.size > 50) fallbackDigestCache.clear();
      fallbackDigestCache.set(fallbackKey, { data: cached, ts: Date.now() });
    }
    return cached ?? fallbackDigestCache.get(fallbackKey)?.data ?? buildEmptyDigestResponse();
  } catch {
    return fallbackDigestCache.get(fallbackKey)?.data ?? buildEmptyDigestResponse();
  }
}

async function buildDigest(variant: string, lang: string): Promise<ListFeedDigestResponse> {
  const feedsByCategory = VARIANT_FEEDS[variant] ?? {};
  const feedStatuses: Record<string, string> = {};
  const feedStatusDetails: Record<string, FeedStatusDetail> = {};
  const categories: Record<string, CategoryBucket> = {};

  const deadlineController = new AbortController();
  const deadlineTimeout = setTimeout(() => deadlineController.abort(), OVERALL_DEADLINE_MS);

  try {
    const allEntries: Array<{ category: string; feed: ServerFeed }> = [];

    for (const [category, feeds] of Object.entries(feedsByCategory)) {
      const filtered = feeds.filter(f => !f.lang || f.lang === lang);
      for (const feed of filtered) {
        allEntries.push({ category, feed });
      }
    }

    if (variant === 'full') {
      const filteredIntel = INTEL_SOURCES.filter(f => !f.lang || f.lang === lang);
      for (const feed of filteredIntel) {
        allEntries.push({ category: 'intel', feed });
      }
    }

    const results = new Map<string, ParsedItem[]>();

    for (let i = 0; i < allEntries.length; i += BATCH_CONCURRENCY) {
      if (deadlineController.signal.aborted) break;

      const batch = allEntries.slice(i, i + BATCH_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async ({ category, feed }) => {
          const result = await fetchAndParseRss(feed, variant, deadlineController.signal);
          feedStatuses[feed.name] = result.status;
          feedStatusDetails[feed.name] = {
            status: result.status,
            reason: result.reason,
            statusCode: result.statusCode,
            errorType: result.errorType,
            message: result.message,
            fetchedVia: result.fetchedVia,
            url: feed.url,
            category,
            updatedAt: new Date().toISOString(),
          };
          return { category, items: result.items };
        }),
      );

      for (const result of settled) {
        if (result.status === 'fulfilled') {
          const { category, items } = result.value;
          const existing = results.get(category) ?? [];
          existing.push(...items);
          results.set(category, existing);
        }
      }
    }

    for (const entry of allEntries) {
      if (!(entry.feed.name in feedStatuses)) {
        feedStatuses[entry.feed.name] = 'timeout';
        feedStatusDetails[entry.feed.name] = {
          status: 'timeout',
          reason: 'overall_deadline_exceeded',
          fetchedVia: 'none',
          url: entry.feed.url,
          category: entry.category,
          updatedAt: new Date().toISOString(),
        };
      }
    }

    for (const [category, items] of results) {
      items.sort((a, b) => b.publishedAt - a.publishedAt);
      categories[category] = {
        items: items.slice(0, MAX_ITEMS_PER_CATEGORY).map(toProtoItem),
      };
    }

    return attachFeedStatusDetails({
      categories,
      feedStatuses,
      generatedAt: new Date().toISOString(),
    }, feedStatusDetails);
  } finally {
    clearTimeout(deadlineTimeout);
  }
}
