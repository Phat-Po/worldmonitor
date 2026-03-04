#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
  const eqIdx = normalized.indexOf('=');
  if (eqIdx <= 0) return null;

  const key = normalized.slice(0, eqIdx).trim();
  let value = normalized.slice(eqIdx + 1).trim();

  if (!key) return null;

  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (quoted && value.length >= 2) {
    value = value.slice(1, -1);
  } else {
    const commentIdx = value.indexOf(' #');
    if (commentIdx >= 0) value = value.slice(0, commentIdx).trim();
  }

  return { key, value };
}

export function loadEnvLocal(projectRoot = process.cwd()) {
  const envLocalPath = path.join(projectRoot, '.env.local');
  if (!existsSync(envLocalPath)) {
    return { loaded: false, path: envLocalPath, count: 0 };
  }

  let count = 0;
  const lines = readFileSync(envLocalPath, 'utf8').split('\n');
  for (const rawLine of lines) {
    const entry = parseEnvLine(rawLine);
    if (!entry) continue;
    const { key, value } = entry;

    // Keep explicit shell env precedence (CI/operators can override via export).
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    count += 1;
  }

  return { loaded: true, path: envLocalPath, count };
}
