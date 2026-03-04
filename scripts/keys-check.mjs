#!/usr/bin/env node

import process from 'node:process';

const keyGroups = [
  {
    name: 'Round-2 Required (for currently failing panels)',
    keys: ['UCDP_ACCESS_TOKEN', 'FRED_API_KEY'],
    panels: ['Armed Conflict Events', 'Economic Indicators (FRED)'],
  },
  {
    name: 'Relay-backed (for Telegram/Sirens/RSS relay)',
    keys: ['WS_RELAY_URL'],
    panels: ['Telegram Intel', 'Israel Sirens', 'RSS relay fallback'],
  },
  {
    name: 'Recommended Market/Data quality',
    keys: ['FINNHUB_API_KEY', 'EIA_API_KEY'],
    panels: ['Markets/Heatmap quality', 'Oil analytics'],
  },
];

function hasValue(key) {
  return String(process.env[key] || '').trim().length > 0;
}

function mark(ok) {
  return ok ? 'OK' : 'MISSING';
}

function printGroup(group) {
  console.log(`\n[${group.name}]`);
  for (const key of group.keys) {
    const ok = hasValue(key);
    console.log(`- ${key.padEnd(24)} ${mark(ok)}`);
  }
  console.log(`  panels: ${group.panels.join(', ')}`);
}

function main() {
  console.log('[keys-check] environment readiness summary');
  keyGroups.forEach(printGroup);

  const requiredKeys = keyGroups[0].keys;
  const missingRequired = requiredKeys.filter((k) => !hasValue(k));
  if (missingRequired.length > 0) {
    console.error(`\n[keys-check] required keys missing: ${missingRequired.join(', ')}`);
    process.exit(2);
  }

  console.log('\n[keys-check] required round-2 keys are present.');
}

main();

