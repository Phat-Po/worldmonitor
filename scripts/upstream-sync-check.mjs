#!/usr/bin/env node
/**
 * upstream-sync-check.mjs
 * Shows what's new on upstream/main since our fork baseline.
 * Run: npm run sync:check
 */

import { execSync } from 'node:child_process';
import process from 'node:process';

// Files our fork has customized — flag if upstream also touched them
const OUR_FILES = [
  'src/main.ts',
  'src/config/variant-meta.ts',
  'src/services/runtime.ts',
  'src/services/story-share.ts',
  'src/app/panel-layout.ts',
  'src/components/LiveNewsPanel.ts',
  'src/components/ServiceStatusPanel.ts',
  'src/styles/main.css',
  'vercel.json',
];

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function tryRun(cmd, fallback = '') {
  try {
    return run(cmd);
  } catch {
    return fallback;
  }
}

function fetchUpstream() {
  console.log('Fetching upstream...');
  try {
    execSync('git fetch upstream --quiet', { stdio: ['ignore', 'ignore', 'pipe'] });
    console.log('ok upstream fetched\n');
  } catch {
    console.error('FAIL Could not fetch upstream. Check network or remote config.');
    console.error('  git remote -v   ->  verify "upstream" is set');
    process.exit(1);
  }
}

function getNewCommits() {
  const raw = tryRun('git log HEAD..upstream/main --oneline --no-merges');
  if (!raw) return [];
  return raw.split('\n').filter(Boolean);
}

function getChangedFilesForCommit(hash) {
  return tryRun(`git diff-tree --no-commit-id -r --name-only ${hash}`).split('\n').filter(Boolean);
}

function categorize(subject) {
  if (/^feat/.test(subject)) return 'feat';
  if (/^fix/.test(subject)) return 'fix';
  if (/^perf/.test(subject)) return 'perf';
  if (/^refactor/.test(subject)) return 'refactor';
  if (/^chore/.test(subject)) return 'chore';
  if (/^docs/.test(subject)) return 'docs';
  if (/^test/.test(subject)) return 'test';
  return 'other';
}

function main() {
  fetchUpstream();

  const commits = getNewCommits();

  if (commits.length === 0) {
    console.log('ok You are up to date with upstream/main. Nothing new.');
    return;
  }

  console.log(`${commits.length} new commit(s) on upstream/main:\n`);

  const groups = { feat: [], fix: [], perf: [], refactor: [], chore: [], docs: [], test: [], other: [] };
  const conflicts = [];

  for (const line of commits) {
    const [hash, ...rest] = line.split(' ');
    const subject = rest.join(' ');
    const cat = categorize(subject);
    groups[cat].push({ hash, subject });

    const changed = getChangedFilesForCommit(hash);
    const overlap = changed.filter(f => OUR_FILES.includes(f));
    if (overlap.length > 0) {
      conflicts.push({ hash, subject, overlap });
    }
  }

  const order = ['feat', 'fix', 'perf', 'refactor', 'chore', 'docs', 'test', 'other'];
  for (const cat of order) {
    const items = groups[cat];
    if (items.length === 0) continue;
    console.log(`-- ${cat.toUpperCase()} (${items.length}) --`);
    for (const { hash, subject } of items) {
      console.log(`  ${hash.slice(0, 8)}  ${subject}`);
    }
    console.log('');
  }

  if (conflicts.length > 0) {
    console.log('WARN  upstream touched files we customized:');
    for (const { hash, subject, overlap } of conflicts) {
      console.log(`  ${hash.slice(0, 8)}  ${subject}`);
      for (const f of overlap) {
        console.log(`             -> ${f}`);
      }
    }
    console.log('');
    console.log('Review these commits carefully before cherry-picking.');
  } else {
    console.log('ok No overlap with our customized files. Safe to cherry-pick.');
  }

  console.log('\nTo cherry-pick a specific commit:');
  console.log('  git cherry-pick <hash>');
  console.log('\nTo see full diff of a commit:');
  console.log('  git show <hash>');
}

main();
