# Round-3 Panel Triage (2026-03-05)

Date baseline: 2026-03-05 (Asia/Shanghai)

## Objective

Prioritize panel recovery in this order:

1. `可无 key 本地可修`
2. `需要 relay`
3. `需要 key`

## What changed in round-3

- Improved wildfire no-key fallback:
  - EONET fallback now parses non-Point geometries and returns map-ready detections.
  - File: `server/worldmonitor/wildfire/v1/list-fire-detections.ts`
- Improved UNHCR no-key local behavior:
  - Smaller pages + concurrent page fetch in local no-relay mode to reduce timeout-induced empty results.
  - File: `server/worldmonitor/displacement/v1/get-displacement-summary.ts`
- Added live-intelligence local fallback:
  - When GDELT is unavailable/rate-limited, topic panel falls back to digest headlines by mapped categories.
  - File: `src/services/gdelt-intel.ts`
- Added relay/key operator checks:
  - `npm run relay:smoke`
  - `npm run keys:check`

## Probe snapshot (local vercel dev)

- `/api/wildfire/v1/list-fire-detections` => `fires: 120`
- `/api/displacement/v1/get-displacement-summary` => `countries: 169`, `flows: 50`
- `/api/prediction/v1/list-prediction-markets` => `markets: 35`
- `/api/market/v1/list-market-quotes?...` => quotes present
- `/api/market/v1/get-sector-summary` => sectors present
- `/api/market/v1/list-etf-flows` => etfs present
- `/api/market/v1/list-stablecoin-markets` => stablecoins present
- `/api/telegram-feed` => `503` without relay
- `/api/oref-alerts` => `503` without relay
- `/api/conflict/v1/list-ucdp-events` => `events: 0` without token/seed

### Follow-up snapshot (same day, after round-3.1 tuning)

- `/api/news/v1/list-feed-digest?variant=full&lang=en` => `feeds:85`, `ok:42`, `failed:43` (previously `ok:23-24`)
- Category coverage improved:
  - `asia` items: `15` (previously `0`)
  - `thinktanks` items: `10` (previously `0`)
- `keys:check` now auto-loads `.env.local`:
  - `FRED_API_KEY`: `OK`
  - `UCDP_ACCESS_TOKEN`: `MISSING`
- `relay:smoke` now auto-loads `.env.local` and confirms:
  - `WS_RELAY_URL`: `MISSING`

## Bucket classification

### A) 可无 key 本地可修

- AI Strategic Posture
- Government
- Predictions
- Commodities
- Markets
- Economic indicators (non-FRED subset; panel available)
- Crypto
- Sector heatmap
- Fires
- BTC ETF tracker
- Stablecoins
- UNHCR displacement
- Population exposure (depends on upstream event inputs)
- Live intelligence (with digest fallback path)

### B) 需要 relay

- Asia-Pacific RSS reliability (many upstream timeout paths)
- Telegram Intel (`/api/telegram-feed` relay-backed)
- Israel Sirens (`/api/oref-alerts` relay-backed)

### C) 需要 key

- Armed conflict events (UCDP event-level stability)
  - Key: `UCDP_ACCESS_TOKEN`
- Economic indicators (FRED full indicators)
  - Key: `FRED_API_KEY`

## Operator runbook

```bash
# 1) Start local edge + proxy path
npm run dev:vercel:proxy -- --listen 3100

# 2) Check relay if configured
npm run relay:smoke

# 3) Check key readiness
npm run keys:check
```

## Follow-up

- If relay is configured and healthy, re-run digest scan and compare category-level timeout ratios.
- After adding `UCDP_ACCESS_TOKEN` + `FRED_API_KEY`, re-check:
  - Armed conflict events panel
  - Economic indicators panel
