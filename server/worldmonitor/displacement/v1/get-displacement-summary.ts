/**
 * GetDisplacementSummary RPC -- paginates through the UNHCR Population API,
 * aggregates raw records into per-country displacement metrics from origin and
 * asylum perspectives, computes refugee flow corridors, and attaches geographic
 * coordinates from hardcoded centroids.
 */

import type {
  ServerContext,
  GetDisplacementSummaryRequest,
  GetDisplacementSummaryResponse,
  GeoCoordinates,
} from '../../../../src/generated/server/worldmonitor/displacement/v1/service_server';

import { CHROME_UA } from '../../../_shared/constants';
import { cachedFetchJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'displacement:summary:v1';
const REDIS_CACHE_TTL = 43200; // 12 hr — annual UNHCR data, very slow-moving

function isNoRelayLocalMode(): boolean {
  const env = String(process.env.VERCEL_ENV || process.env.NODE_ENV || '').toLowerCase();
  return !process.env.WS_RELAY_URL && (env === 'development' || env === 'dev' || env === '' || env === 'local');
}

const localNoRelayMode = isNoRelayLocalMode();
const UNHCR_PAGE_LIMIT = localNoRelayMode ? 300 : 3000;
const UNHCR_MAX_PAGES = localNoRelayMode ? 5 : 6;
const UNHCR_TIMEOUT_MS = localNoRelayMode ? 6_000 : 8_000;

// ---------- Country centroids (ISO3 -> [lat, lon]) ----------

const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  AFG: [33.9, 67.7], SYR: [35.0, 38.0], UKR: [48.4, 31.2], SDN: [15.5, 32.5],
  SSD: [6.9, 31.3], SOM: [5.2, 46.2], COD: [-4.0, 21.8], MMR: [19.8, 96.7],
  YEM: [15.6, 48.5], ETH: [9.1, 40.5], VEN: [6.4, -66.6], IRQ: [33.2, 43.7],
  COL: [4.6, -74.1], NGA: [9.1, 7.5], PSE: [31.9, 35.2], TUR: [39.9, 32.9],
  DEU: [51.2, 10.4], PAK: [30.4, 69.3], UGA: [1.4, 32.3], BGD: [23.7, 90.4],
  KEN: [0.0, 38.0], TCD: [15.5, 19.0], JOR: [31.0, 36.0], LBN: [33.9, 35.5],
  EGY: [26.8, 30.8], IRN: [32.4, 53.7], TZA: [-6.4, 34.9], RWA: [-1.9, 29.9],
  CMR: [7.4, 12.4], MLI: [17.6, -4.0], BFA: [12.3, -1.6], NER: [17.6, 8.1],
  CAF: [6.6, 20.9], MOZ: [-18.7, 35.5], USA: [37.1, -95.7], FRA: [46.2, 2.2],
  GBR: [55.4, -3.4], IND: [20.6, 79.0], CHN: [35.9, 104.2], RUS: [61.5, 105.3],
};

// ---------- Internal UNHCR API types ----------

interface UnhcrRawItem {
  coo_iso?: string;
  coo_name?: string;
  coa_iso?: string;
  coa_name?: string;
  refugees?: number;
  asylum_seekers?: number;
  idps?: number;
  stateless?: number;
}

// ---------- Helpers ----------

/** Paginate through all UNHCR Population API pages for a given year. */
async function fetchUnhcrPage(year: number, limit: number, page: number): Promise<{ items: UnhcrRawItem[]; maxPages: number | null } | null> {
  const response = await fetch(
    `https://api.unhcr.org/population/v1/population/?year=${year}&limit=${limit}&page=${page}&coo_all=true&coa_all=true`,
    { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(UNHCR_TIMEOUT_MS) },
  );
  if (!response.ok) return null;
  const data = await response.json();
  const items: UnhcrRawItem[] = Array.isArray(data.items) ? data.items : [];
  const parsedMaxPages = Number(data.maxPages);
  return {
    items,
    maxPages: Number.isFinite(parsedMaxPages) && parsedMaxPages > 0 ? parsedMaxPages : null,
  };
}

async function fetchUnhcrYearItems(year: number): Promise<UnhcrRawItem[] | null> {
  const limit = UNHCR_PAGE_LIMIT;
  const maxPageGuard = UNHCR_MAX_PAGES;
  const items: UnhcrRawItem[] = [];

  const firstPage = await fetchUnhcrPage(year, limit, 1);
  if (!firstPage) return null;
  if (firstPage.items.length === 0) return [];
  items.push(...firstPage.items);

  const cappedMaxPages = firstPage.maxPages
    ? Math.min(maxPageGuard, firstPage.maxPages)
    : maxPageGuard;
  if (cappedMaxPages <= 1) return items;

  const remainingPages = Array.from({ length: cappedMaxPages - 1 }, (_, idx) => idx + 2);
  const settled = await Promise.allSettled(
    remainingPages.map((page) => fetchUnhcrPage(year, limit, page)),
  );

  for (const pageResult of settled) {
    if (pageResult.status !== 'fulfilled') continue;
    const payload = pageResult.value;
    if (!payload || payload.items.length === 0) continue;
    items.push(...payload.items);
  }

  return items.length > 0 ? items : null;
}

/** Look up centroid coordinates for an ISO3 country code. */
function getCoordinates(code: string): GeoCoordinates | undefined {
  const centroid = COUNTRY_CENTROIDS[code];
  if (!centroid) return undefined;
  return { latitude: centroid[0], longitude: centroid[1] };
}

// ---------- Aggregation types ----------

interface OriginAgg {
  name: string;
  refugees: number;
  asylumSeekers: number;
  idps: number;
  stateless: number;
}

interface AsylumAgg {
  name: string;
  refugees: number;
  asylumSeekers: number;
}

interface FlowAgg {
  originCode: string;
  originName: string;
  asylumCode: string;
  asylumName: string;
  refugees: number;
}

interface MergedCountry {
  code: string;
  name: string;
  refugees: number;
  asylumSeekers: number;
  idps: number;
  stateless: number;
  totalDisplaced: number;
  hostRefugees: number;
  hostAsylumSeekers: number;
  hostTotal: number;
}

// ---------- RPC handler ----------

export async function getDisplacementSummary(
  _ctx: ServerContext,
  req: GetDisplacementSummaryRequest,
): Promise<GetDisplacementSummaryResponse> {
  const emptyResponse: GetDisplacementSummaryResponse = {
    summary: {
      year: req.year > 0 ? req.year : new Date().getFullYear(),
      globalTotals: { refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0, total: 0 },
      countries: [],
      topFlows: [],
    },
  };

  try {
    // Redis shared cache (keyed by year)
    const year = req.year > 0 ? req.year : new Date().getFullYear();
    const cacheKey = `${REDIS_CACHE_KEY}:${year}`;

    const result = await cachedFetchJson<GetDisplacementSummaryResponse>(cacheKey, REDIS_CACHE_TTL, async () => {
      // 1. Determine year with fallback
      const currentYear = new Date().getFullYear();
      const requestYear = req.year > 0 ? req.year : 0;
      let rawItems: UnhcrRawItem[] = [];
      let dataYearUsed = currentYear;

      if (requestYear > 0) {
        let items: UnhcrRawItem[] | null = null;
        try {
          items = await fetchUnhcrYearItems(requestYear);
        } catch {
          items = null;
        }
        if (items && items.length > 0) {
          rawItems = items;
          dataYearUsed = requestYear;
        }
      } else {
        for (let y = currentYear; y >= currentYear - 2; y--) {
          let items: UnhcrRawItem[] | null = null;
          try {
            items = await fetchUnhcrYearItems(y);
          } catch {
            items = null;
          }
          if (!items) continue;
          if (items.length > 0) {
            rawItems = items;
            dataYearUsed = y;
            break;
          }
        }
      }

      if (rawItems.length === 0) return null;

      // 2. Aggregate by origin and asylum
      const byOrigin: Record<string, OriginAgg> = {};
      const byAsylum: Record<string, AsylumAgg> = {};
      const flowMap: Record<string, FlowAgg> = {};
      let totalRefugees = 0;
      let totalAsylumSeekers = 0;
      let totalIdps = 0;
      let totalStateless = 0;

      for (const item of rawItems) {
        const originCode = item.coo_iso || '';
        const asylumCode = item.coa_iso || '';
        const refugees = Number(item.refugees) || 0;
        const asylumSeekers = Number(item.asylum_seekers) || 0;
        const idps = Number(item.idps) || 0;
        const stateless = Number(item.stateless) || 0;

        totalRefugees += refugees;
        totalAsylumSeekers += asylumSeekers;
        totalIdps += idps;
        totalStateless += stateless;

        if (originCode) {
          if (!byOrigin[originCode]) {
            byOrigin[originCode] = {
              name: item.coo_name || originCode,
              refugees: 0, asylumSeekers: 0, idps: 0, stateless: 0,
            };
          }
          byOrigin[originCode].refugees += refugees;
          byOrigin[originCode].asylumSeekers += asylumSeekers;
          byOrigin[originCode].idps += idps;
          byOrigin[originCode].stateless += stateless;
        }

        if (asylumCode) {
          if (!byAsylum[asylumCode]) {
            byAsylum[asylumCode] = {
              name: item.coa_name || asylumCode,
              refugees: 0, asylumSeekers: 0,
            };
          }
          byAsylum[asylumCode].refugees += refugees;
          byAsylum[asylumCode].asylumSeekers += asylumSeekers;
        }

        if (originCode && asylumCode && refugees > 0) {
          const flowKey = `${originCode}->${asylumCode}`;
          if (!flowMap[flowKey]) {
            flowMap[flowKey] = {
              originCode,
              originName: item.coo_name || originCode,
              asylumCode,
              asylumName: item.coa_name || asylumCode,
              refugees: 0,
            };
          }
          flowMap[flowKey].refugees += refugees;
        }
      }

      // 3. Merge into unified country records
      const countries: Record<string, MergedCountry> = {};

      for (const [code, data] of Object.entries(byOrigin)) {
        countries[code] = {
          code,
          name: data.name,
          refugees: data.refugees,
          asylumSeekers: data.asylumSeekers,
          idps: data.idps,
          stateless: data.stateless,
          totalDisplaced: data.refugees + data.asylumSeekers + data.idps + data.stateless,
          hostRefugees: 0,
          hostAsylumSeekers: 0,
          hostTotal: 0,
        };
      }

      for (const [code, data] of Object.entries(byAsylum)) {
        const hostRefugees = data.refugees;
        const hostAsylumSeekers = data.asylumSeekers;
        const hostTotal = hostRefugees + hostAsylumSeekers;

        if (!countries[code]) {
          countries[code] = {
            code,
            name: data.name,
            refugees: 0,
            asylumSeekers: 0,
            idps: 0,
            stateless: 0,
            totalDisplaced: 0,
            hostRefugees,
            hostAsylumSeekers,
            hostTotal,
          };
        } else {
          countries[code].hostRefugees = hostRefugees;
          countries[code].hostAsylumSeekers = hostAsylumSeekers;
          countries[code].hostTotal = hostTotal;
        }
      }

      // 4. Sort countries by max(totalDisplaced, hostTotal) descending
      const sortedCountries = Object.values(countries).sort((a, b) => {
        const aSize = Math.max(a.totalDisplaced, a.hostTotal);
        const bSize = Math.max(b.totalDisplaced, b.hostTotal);
        return bSize - aSize;
      });

      // 5. Build proto-shaped countries with GeoCoordinates (cache ALL — limits applied post-cache)
      const protoCountries = sortedCountries.map((d) => ({
        code: d.code,
        name: d.name,
        refugees: d.refugees,
        asylumSeekers: d.asylumSeekers,
        idps: d.idps,
        stateless: d.stateless,
        totalDisplaced: d.totalDisplaced,
        hostRefugees: d.hostRefugees,
        hostAsylumSeekers: d.hostAsylumSeekers,
        hostTotal: d.hostTotal,
        location: getCoordinates(d.code),
      }));

      // 6. Build flows sorted by refugees descending (cache ALL — limits applied post-cache)
      const protoFlows = Object.values(flowMap)
        .sort((a, b) => b.refugees - a.refugees)
        .map((f) => ({
          originCode: f.originCode,
          originName: f.originName,
          asylumCode: f.asylumCode,
          asylumName: f.asylumName,
          refugees: f.refugees,
          originLocation: getCoordinates(f.originCode),
          asylumLocation: getCoordinates(f.asylumCode),
        }));

      return {
        summary: {
          year: dataYearUsed,
          globalTotals: {
            refugees: totalRefugees,
            asylumSeekers: totalAsylumSeekers,
            idps: totalIdps,
            stateless: totalStateless,
            total: totalRefugees + totalAsylumSeekers + totalIdps + totalStateless,
          },
          countries: protoCountries,
          topFlows: protoFlows,
        },
      };
    });

    if (result?.summary) {
      const summary = { ...result.summary };
      if (req.countryLimit > 0) {
        summary.countries = summary.countries.slice(0, req.countryLimit);
      }
      const flowLimit = req.flowLimit > 0 ? req.flowLimit : 50;
      summary.topFlows = summary.topFlows.slice(0, flowLimit);
      return { summary };
    }
    return result || emptyResponse;
  } catch {
    // Graceful degradation: return empty summary on ANY failure
    return emptyResponse;
  }
}
