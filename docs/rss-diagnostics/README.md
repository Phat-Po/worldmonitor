# RSS Diagnostics (CN Compatibility)

This project now supports runtime tuning for RSS connectivity and better feed failure attribution.

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
