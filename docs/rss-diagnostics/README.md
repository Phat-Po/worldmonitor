# RSS Diagnostics (CN Compatibility)

This project now supports runtime tuning for RSS connectivity and better feed failure attribution.

## Round-3 panel strategy (2026-03-05)

Execution order used in this fork:

1. Relay-backed panel recovery
2. `.env.local` CN template / operator setup
3. Key-backed panel recovery

Use these scripts:

```bash
# check relay reachability (rss/telegram/oref/yahoo/opensky)
npm run relay:smoke

# check key readiness for round-2 panels
npm run keys:check
```

Template for operators:

```bash
cp .env.local.cn.example .env.local
```

## New environment variables

- `RSS_PROXY_EXTRA_DOMAINS`
  - Comma/space-separated extra hostnames added to Vite dev RSS allowlist.
  - Example: `RSS_PROXY_EXTRA_DOMAINS=rsshub.app,feeds.example.com`

- `RSS_APNEWS_FALLBACK`
  - Set to `1` to enable AP News fallback when Google News RSS is blocked/unusable.
  - Works in both Vite dev RSS proxy and desktop sidecar RSS proxy.
  - Desktop sidecar supports runtime updates through `/api/local-env-update` (`key=RSS_APNEWS_FALLBACK`).

- `RSS_APNEWS_FALLBACK_URL`
  - Optional fallback feed URL for AP News (default: `https://rsshub.app/apnews`).
  - Also used by server feed source selection in `server/worldmonitor/news/v1/_feeds.ts`.
  - Desktop sidecar supports runtime updates through `/api/local-env-update` (`key=RSS_APNEWS_FALLBACK_URL`).

- `RSS_DIGEST_FEED_TIMEOUT_MS`
  - Server-side digest per-feed timeout in milliseconds.
  - Default: `9000` without relay, `10000` with relay.

- `RSS_DIGEST_OVERALL_DEADLINE_MS`
  - Server-side digest total deadline in milliseconds.
  - Default: `32000` without relay, `40000` with relay.

- `RSS_DIGEST_BATCH_CONCURRENCY`
  - Server-side digest feed concurrency (`1-20`).
  - Default: `12` without relay, `10` with relay.

## New response field (news digest)

Endpoint: `/api/news/v1/list-feed-digest?variant=<...>&lang=<...>`

In addition to existing `feedStatuses`, response now includes:

- `feedStatusDetails` (optional object map by feed name)
  - `status`: `ok | empty | timeout | failed`
  - `reason`: e.g. `ok`, `no_items_in_feed`, `upstream_http_error`, `feed_timeout`, `network_error`, `overall_deadline_exceeded`
  - `statusCode` (if upstream HTTP returned)
  - `errorType`
  - `message`
  - `fetchedVia`: `direct | relay | none`
  - `url`, `category`, `updatedAt`

Compatibility note:

- Existing `feedStatuses` is preserved.
- Existing clients that only read `feedStatuses` do not need to change.

## Current triage buckets (CN local)

See:

- `docs/rss-diagnostics/2026-03-05-round3-panel-triage.md`

Buckets:

- `可无 key 本地可修`
- `需要 relay`
- `需要 key`
