#!/usr/bin/env node

import process from 'node:process';

function toHttpBase(raw) {
  if (!raw) return '';
  return raw
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/\/+$/, '');
}

function relayHeaders() {
  const headers = {
    'User-Agent': 'worldmonitor-relay-smoke/1.0',
    'Accept': 'application/json, text/plain, */*',
  };
  const secret = String(process.env.RELAY_SHARED_SECRET || '').trim();
  if (secret) {
    const headerName = String(process.env.RELAY_AUTH_HEADER || 'x-relay-key').trim() || 'x-relay-key';
    headers[headerName] = secret;
    headers.authorization = `Bearer ${secret}`;
  }
  return headers;
}

async function checkEndpoint(name, url, timeoutMs = 12000) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: relayHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const elapsed = Date.now() - started;
    const body = await response.text();
    return {
      name,
      ok: response.ok,
      status: response.status,
      elapsed,
      sample: body.slice(0, 120).replace(/\s+/g, ' ').trim(),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      status: 'ERR',
      elapsed: Date.now() - started,
      sample: String(error).slice(0, 120),
    };
  }
}

async function main() {
  const relayBase = toHttpBase(process.env.WS_RELAY_URL);
  if (!relayBase) {
    console.error('[relay-smoke] WS_RELAY_URL is not set.');
    process.exit(1);
  }

  const checks = await Promise.all([
    checkEndpoint('rss', `${relayBase}/rss?url=${encodeURIComponent('https://feeds.bbci.co.uk/news/world/rss.xml')}`),
    checkEndpoint('telegram', `${relayBase}/telegram/feed?limit=1`, 18000),
    checkEndpoint('oref', `${relayBase}/oref/alerts`, 18000),
    checkEndpoint('yahoo', `${relayBase}/yahoo-chart?symbol=${encodeURIComponent('^GSPC')}`),
    checkEndpoint('opensky', `${relayBase}/opensky?lamin=31&lamax=33&lomin=34&lomax=36`, 18000),
  ]);

  console.log(`[relay-smoke] relay base: ${relayBase}`);
  for (const row of checks) {
    const mark = row.ok ? 'OK' : 'FAIL';
    console.log(`- ${row.name.padEnd(8)} ${mark} status=${row.status} time=${row.elapsed}ms sample="${row.sample}"`);
  }

  const failed = checks.filter((x) => !x.ok);
  if (failed.length > 0) {
    console.error(`[relay-smoke] ${failed.length} checks failed.`);
    process.exit(2);
  }
  console.log('[relay-smoke] all checks passed.');
}

main().catch((error) => {
  console.error('[relay-smoke] fatal error:', error);
  process.exit(3);
});

