#!/usr/bin/env node
/**
 * check-freshness.mjs
 *
 * Decides how much of the committed map can still be trusted.
 *
 * The useful answer is rarely "fresh" or "stale". It is usually "correct except
 * for these six files", and acting on that is what keeps the token savings real:
 * read the six, trust the rest. A binary stale flag throws away a good map
 * because one file changed, which pushes the agent back to reading everything.
 *
 * Exit codes:
 *   0  FRESH    map matches the working tree
 *   1  DRIFTED  map valid except for the listed files
 *   2  STALE    too much has changed, or the map cannot be located in history
 *
 * Usage:
 *   node check-freshness.mjs [--repo <path>] [--json] [--threshold 0.15]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { hashSource } from './hash.mjs';

function parseArgs(argv) {
  const a = { repo: process.cwd(), json: false, threshold: 0.15 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--repo') a.repo = path.resolve(argv[++i]);
    else if (k === '--json') a.json = true;
    else if (k === '--threshold') a.threshold = parseFloat(argv[++i]);
  }
  return a;
}

const args = parseArgs(process.argv);
const snapPath = path.join(args.repo, '.codemap', 'snapshot.json');

function git(cmd) {
  try {
    return execSync(cmd, { cwd: args.repo, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 })
      .toString().trim();
  } catch { return null; }
}

function emit(result) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(render(result));
  }
  process.exit(result.status === 'FRESH' ? 0 : result.status === 'DRIFTED' ? 1 : 2);
}

function render(r) {
  const lines = [];
  lines.push(`MAP FRESHNESS: ${r.status}`);
  lines.push(r.summary);
  if (r.drifted?.length) {
    lines.push('');
    lines.push(`Files changed since the map was built (${r.drifted.length}). Read these from disk;`);
    lines.push('the map remains accurate for everything else.');
    for (const f of r.drifted.slice(0, 40)) lines.push(`  ${f.status}  ${f.path}`);
    if (r.drifted.length > 40) lines.push(`  ...and ${r.drifted.length - 40} more`);
  }
  if (r.advice) { lines.push(''); lines.push(r.advice); }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

if (!fs.existsSync(snapPath)) {
  emit({
    status: 'STALE',
    summary: 'No .codemap/snapshot.json found. There is no map to trust.',
    advice: 'Run: npx repo-map all',
    drifted: [],
  });
}

let snap;
try { snap = JSON.parse(fs.readFileSync(snapPath, 'utf8')); }
catch {
  emit({ status: 'STALE', summary: 'snapshot.json is unreadable or corrupt.', advice: 'Rebuild the map.', drifted: [] });
}

const mapSha = snap.git?.sha;
const headSha = git('git rev-parse HEAD');
const currentBranch = git('git rev-parse --abbrev-ref HEAD');
const totalFiles = snap.totals?.files || Object.keys(snap.files || {}).length || 1;

if (!headSha) {
  emit({
    status: 'STALE',
    summary: 'Not a git repository, so drift cannot be measured.',
    advice: 'Rebuild the map before relying on it, or verify against source directly.',
    drifted: [],
  });
}

if (!mapSha) {
  emit({
    status: 'STALE',
    summary: 'The map records no commit, so there is nothing to compare against.',
    advice: 'Rebuild the map.',
    drifted: [],
  });
}

// Is the map's commit even in this history? On a fresh branch or after a rebase
// it may not be, and diffing against a commit git cannot reach is meaningless.
const mapCommitReachable = git(`git merge-base --is-ancestor ${mapSha} HEAD && echo yes`) === 'yes';

const SOURCE_RX = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const drifted = new Map();

function add(p, status) {
  if (!SOURCE_RX.test(p)) return;
  if (!drifted.has(p)) drifted.set(p, { path: p, status });
}

if (mapSha !== headSha) {
  if (mapCommitReachable) {
    const diff = git(`git diff --name-status ${mapSha} HEAD`) || '';
    for (const line of diff.split('\n').filter(Boolean)) {
      const [code, ...rest] = line.split(/\s+/);
      const p = rest[rest.length - 1];
      add(p, code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified');
    }
  } else {
    emit({
      status: 'STALE',
      summary: `The map was built at ${snap.git.shortSha}, which is not an ancestor of HEAD (branch \`${currentBranch}\`). It likely came from a different branch or a rebased history.`,
      advice: 'Rebuild the map on this branch before trusting it.',
      drifted: [],
      mapCommit: snap.git.shortSha,
      headCommit: headSha.slice(0, 7),
    });
  }
}

// Uncommitted work counts as drift too, and is the most common cause in practice.
// Read this untrimmed: porcelain's first column is a significant space for
// unstaged changes, and trimming it shifts every path by one character.
let porcelain = '';
try {
  porcelain = execSync('git status --porcelain', {
    cwd: args.repo, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024,
  }).toString();
} catch { /* handled above */ }

for (const line of porcelain.split('\n')) {
  if (line.length < 4) continue;
  const code = line.slice(0, 2);
  const p = line.slice(3).split(' -> ').pop().replace(/^"|"$/g, '').trim();
  if (!p) continue;
  add(p, code.includes('D') ? 'deleted' : code.includes('?') ? 'untracked' : 'uncommitted');
}

// A file git reports as changed may still match the map exactly. The common
// case is the normal workflow itself: you build the map, then commit the map
// together with your code, so the snapshot records the *previous* HEAD and
// every file in that commit looks changed. Verifying content hashes turns that
// false positive into the FRESH result it should be. It also absorbs reverted
// edits and whitespace-only churn.
const confirmed = [];
for (const d of drifted.values()) {
  const known = snap.files?.[d.path];
  if (d.status === 'deleted') {
    // Only real if the map knew about it and it is genuinely gone.
    if (known && !fs.existsSync(path.join(args.repo, d.path))) confirmed.push(d);
    continue;
  }
  if (!known) { confirmed.push(d); continue; }   // new file the map has never seen
  try {
    const raw = fs.readFileSync(path.join(args.repo, d.path), 'utf8');
    if (hashSource(raw) !== known.hash) confirmed.push(d);
  } catch {
    confirmed.push(d);
  }
}

const driftedList = confirmed.sort((a, b) => a.path.localeCompare(b.path));
const ratio = driftedList.length / totalFiles;

// Structural changes matter more than their file count suggests: a new or deleted
// file changes the shape of the graph, while an edit to an existing file usually
// does not. Weight them accordingly when deciding whether the map still holds.
const structural = driftedList.filter((d) => d.status === 'added' || d.status === 'deleted' || d.status === 'untracked');

const base = {
  mapCommit: snap.git.shortSha,
  headCommit: headSha.slice(0, 7),
  branch: currentBranch,
  generatedAt: snap.generatedAt,
  totalFiles,
  driftedCount: driftedList.length,
  structuralCount: structural.length,
  driftRatio: Number(ratio.toFixed(3)),
  drifted: driftedList,
};

if (driftedList.length === 0) {
  emit({
    ...base,
    status: 'FRESH',
    summary: `Map matches the working tree at ${base.headCommit}. Covers ${totalFiles} files. Use it as the source of truth for structure.`,
    advice: 'Query specifics with: npx repo-map query --impact <file>',
  });
}

if (ratio > args.threshold || structural.length > 20) {
  emit({
    ...base,
    status: 'STALE',
    summary: `${driftedList.length} of ${totalFiles} source files (${Math.round(ratio * 100)}%) changed since the map was built, ${structural.length} of them structurally. Too much has moved for the map to be a reliable guide.`,
    advice: 'Rebuild with: npx repo-map all. If you cannot rebuild, fall back to reading source for the areas you touch.',
  });
}

emit({
  ...base,
  status: 'DRIFTED',
  summary: `${driftedList.length} of ${totalFiles} source files changed since ${base.mapCommit}${structural.length ? `, ${structural.length} structurally` : ''}. The map is still accurate for the other ${totalFiles - driftedList.length}.`,
  advice: structural.length
    ? 'Read the added and deleted files from disk, since they change the graph shape. Trust the map elsewhere. Rebuild when convenient.'
    : 'These are edits to files the map already knows about, so module structure is very likely unchanged. Read them only if your task touches them.',
});
