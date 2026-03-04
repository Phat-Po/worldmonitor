import type {
  ServerContext,
  ListUcdpEventsRequest,
  ListUcdpEventsResponse,
  UcdpViolenceEvent,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';
import { getCachedJson } from '../../../_shared/redis';
import { CHROME_UA } from '../../../_shared/constants';

const CACHE_KEY = 'conflict:ucdp-events:v1';
const MAX_AGE_MS = 25 * 60 * 60 * 1000; // 25h — reject if cron hasn't refreshed
const FALLBACK_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const UCDP_FETCH_TIMEOUT_MS = 6_000;
const UCDP_MAX_PAGES = 3;
const UCDP_MAX_EVENTS = 2000;
const UCDP_TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

const VIOLENCE_TYPE_MAP: Record<number, UcdpViolenceEvent['violenceType']> = {
  1: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
  2: 'UCDP_VIOLENCE_TYPE_NON_STATE',
  3: 'UCDP_VIOLENCE_TYPE_ONE_SIDED',
};

interface UcdpRawEvent {
  id?: string | number;
  date_start?: string;
  date_end?: string;
  latitude?: string | number;
  longitude?: string | number;
  country?: string;
  side_a?: string;
  side_b?: string;
  best?: string | number;
  low?: string | number;
  high?: string | number;
  type_of_violence?: number;
  source_original?: string;
}

interface GedPageResponse {
  Result?: UcdpRawEvent[];
  TotalPages?: number;
}

let fallback: { events: UcdpViolenceEvent[]; ts: number } | null = null;
let liveInflight: Promise<UcdpViolenceEvent[] | null> | null = null;

function parseDateMs(value: unknown): number {
  if (!value) return 0;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function parseNum(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function buildVersionCandidates(): string[] {
  const year = new Date().getFullYear() - 2000;
  return [...new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1'])];
}

async function fetchGedPage(version: string, page: number, token: string): Promise<GedPageResponse> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': CHROME_UA };
  if (token) headers['x-ucdp-access-token'] = token;
  const url = `https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=1000&page=${page}`;
  const resp = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(UCDP_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`UCDP ${version} page ${page}: HTTP ${resp.status}`);
  return (await resp.json()) as GedPageResponse;
}

async function discoverGedVersion(token: string): Promise<{ version: string; page0: GedPageResponse } | null> {
  const candidates = buildVersionCandidates();
  const settled = await Promise.allSettled(candidates.map(async (version) => {
    const page0 = await fetchGedPage(version, 0, token);
    if (!Array.isArray(page0?.Result)) throw new Error('Invalid response');
    return { version, page0 };
  }));
  for (const item of settled) {
    if (item.status === 'fulfilled') return item.value;
  }
  return null;
}

async function fetchLiveUcdpEvents(): Promise<UcdpViolenceEvent[] | null> {
  const token = (process.env.UCDP_ACCESS_TOKEN || process.env.UC_DP_KEY || '').trim();
  const discovered = await discoverGedVersion(token);
  if (!discovered) return null;

  const totalPages = Math.max(1, Number(discovered.page0?.TotalPages || 1));
  const newestPage = totalPages - 1;

  const pages: GedPageResponse[] = [];
  for (let offset = 0; offset < UCDP_MAX_PAGES && (newestPage - offset) >= 0; offset++) {
    const page = newestPage - offset;
    try {
      const data = page === 0 ? discovered.page0 : await fetchGedPage(discovered.version, page, token);
      pages.push(data);
    } catch {
      // ignore single-page failures and continue
    }
  }
  if (pages.length === 0) return null;

  const rawEvents: UcdpRawEvent[] = [];
  let latestMs = 0;
  for (const page of pages) {
    const events = Array.isArray(page?.Result) ? page.Result : [];
    rawEvents.push(...events);
    for (const e of events) {
      latestMs = Math.max(latestMs, parseDateMs(e.date_start));
    }
  }
  if (rawEvents.length === 0) return null;

  const mapped = rawEvents
    .filter((e) => {
      if (!latestMs) return true;
      const ms = parseDateMs(e.date_start);
      return ms >= (latestMs - UCDP_TRAILING_WINDOW_MS);
    })
    .map((e): UcdpViolenceEvent => ({
      id: String(e.id || ''),
      dateStart: parseDateMs(e.date_start),
      dateEnd: parseDateMs(e.date_end),
      location: {
        latitude: parseNum(e.latitude),
        longitude: parseNum(e.longitude),
      },
      country: String(e.country || ''),
      sideA: String(e.side_a || '').slice(0, 200),
      sideB: String(e.side_b || '').slice(0, 200),
      deathsBest: parseNum(e.best),
      deathsLow: parseNum(e.low),
      deathsHigh: parseNum(e.high),
      violenceType: VIOLENCE_TYPE_MAP[Number(e.type_of_violence)] || 'UCDP_VIOLENCE_TYPE_UNSPECIFIED',
      sourceOriginal: String(e.source_original || '').slice(0, 300),
    }))
    .filter((e) => e.dateStart > 0 && !!e.country)
    .sort((a, b) => b.dateStart - a.dateStart)
    .slice(0, UCDP_MAX_EVENTS);

  return mapped.length > 0 ? mapped : null;
}

function applyCountryFilter(events: UcdpViolenceEvent[], country: string): UcdpViolenceEvent[] {
  if (!country) return events;
  return events.filter((e) => e.country === country);
}

export async function listUcdpEvents(
  _ctx: ServerContext,
  req: ListUcdpEventsRequest,
): Promise<ListUcdpEventsResponse> {
  try {
    const raw = await getCachedJson(CACHE_KEY, true) as { events?: UcdpViolenceEvent[]; fetchedAt?: number } | null;
    if (raw?.events?.length && (!raw.fetchedAt || (Date.now() - raw.fetchedAt) < MAX_AGE_MS)) {
      fallback = { events: raw.events, ts: Date.now() };
      return { events: applyCountryFilter(raw.events, req.country), pagination: undefined };
    }
  } catch { /* fall through */ }

  if (fallback && (Date.now() - fallback.ts) < FALLBACK_MAX_AGE_MS) {
    return { events: applyCountryFilter(fallback.events, req.country), pagination: undefined };
  }

  // Final fallback: fetch live UCDP pages when Redis seed is unavailable.
  try {
    if (!liveInflight) {
      liveInflight = fetchLiveUcdpEvents().finally(() => { liveInflight = null; });
    }
    const liveEvents = await liveInflight;
    if (liveEvents?.length) {
      fallback = { events: liveEvents, ts: Date.now() };
      return { events: applyCountryFilter(liveEvents, req.country), pagination: undefined };
    }
  } catch {
    // swallow and return empty payload
  }

  return { events: [], pagination: undefined };
}
