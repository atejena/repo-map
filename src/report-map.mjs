#!/usr/bin/env node
/**
 * report-map.mjs
 *
 * Diffs the current snapshot against the previously committed one and renders:
 *   docs/codemap/MAP.md        human readable map + audit + delta
 *   docs/codemap/map.mmd       Mermaid module graph, new/changed/removed marked
 *   docs/codemap/map-files.mmd Mermaid file graph for changed modules only
 *   .codemap/report.json       machine readable, for gating in CI
 *
 * The previous snapshot is read, in order of preference, from:
 *   1. --prev <path>
 *   2. git show HEAD:.codemap/snapshot.json
 *   3. .codemap/snapshot.prev.json
 * If none exist the run is treated as a baseline (everything is "new" but
 * nothing is flagged as a regression).
 *
 * Usage:
 *   node report-map.mjs [--repo <path>] [--snapshot <path>] [--prev <path>]
 *                       [--out-dir docs/codemap] [--fail-on <level>]
 *
 * --fail-on none|regression|any   exit 1 when thresholds are crossed (for CI)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

function parseArgs(argv) {
  const a = {
    repo: process.cwd(), snapshot: null, prev: null,
    outDir: null, failOn: 'none',
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--repo') a.repo = path.resolve(argv[++i]);
    else if (k === '--snapshot') a.snapshot = path.resolve(argv[++i]);
    else if (k === '--prev') a.prev = path.resolve(argv[++i]);
    else if (k === '--out-dir') a.outDir = argv[++i];
    else if (k === '--fail-on') a.failOn = argv[++i];
  }
  if (!a.snapshot) a.snapshot = path.join(a.repo, '.codemap', 'snapshot.json');
  if (!a.outDir) a.outDir = path.join(a.repo, 'docs', 'codemap');
  else a.outDir = path.resolve(a.repo, a.outDir);
  return a;
}

const args = parseArgs(process.argv);

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

const current = readJson(args.snapshot);
if (!current) {
  console.error(`Cannot read snapshot at ${args.snapshot}. Run build-map.mjs first.`);
  process.exit(2);
}

function loadPrevious() {
  if (args.prev) return { source: args.prev, data: readJson(args.prev) };
  try {
    const out = execSync('git show HEAD:.codemap/snapshot.json', {
      cwd: args.repo, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 128 * 1024 * 1024,
    }).toString();
    return { source: 'git HEAD:.codemap/snapshot.json', data: JSON.parse(out) };
  } catch { /* fall through */ }
  const sidecar = path.join(args.repo, '.codemap', 'snapshot.prev.json');
  if (fs.existsSync(sidecar)) return { source: sidecar, data: readJson(sidecar) };
  return { source: null, data: null };
}

const prevLoaded = loadPrevious();
const previous = prevLoaded.data;
const isBaseline = !previous;

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function keysOf(o) { return new Set(Object.keys(o || {})); }

const curFiles = keysOf(current.files);
const prevFiles = keysOf(previous?.files);

const addedFiles = [...curFiles].filter((f) => !prevFiles.has(f)).sort();
const removedFiles = [...prevFiles].filter((f) => !curFiles.has(f)).sort();
const changedFiles = [...curFiles]
  .filter((f) => prevFiles.has(f) && current.files[f].hash !== previous.files[f].hash)
  .sort();

const edgeKey = (e) => `${e.from}\u0000${e.to}`;
const curEdges = new Set((current.edges || []).map(edgeKey));
const prevEdges = new Set((previous?.edges || []).map(edgeKey));
const addedEdges = [...curEdges].filter((e) => !prevEdges.has(e)).map(splitEdge);
const removedEdges = [...prevEdges].filter((e) => !curEdges.has(e)).map(splitEdge);
function splitEdge(k) { const [from, to] = k.split('\u0000'); return { from, to }; }

const curModules = keysOf(current.modules);
const prevModules = keysOf(previous?.modules);
const addedModules = [...curModules].filter((m) => !prevModules.has(m)).sort();
const removedModules = [...prevModules].filter((m) => !curModules.has(m)).sort();

const touchedModules = new Set([
  ...addedModules,
  ...addedFiles.map((f) => current.files[f].module),
  ...changedFiles.map((f) => current.files[f].module),
  ...removedFiles.map((f) => previous?.files[f]?.module).filter(Boolean),
]);

const moduleEdgeKey = (e) => `${e.from}\u0000${e.to}`;
const curModEdges = new Map((current.moduleEdges || []).map((e) => [moduleEdgeKey(e), e]));
const prevModEdges = new Map((previous?.moduleEdges || []).map((e) => [moduleEdgeKey(e), e]));
const newModuleEdges = [...curModEdges.keys()].filter((k) => !prevModEdges.has(k)).map(splitEdge);
const droppedModuleEdges = [...prevModEdges.keys()].filter((k) => !curModEdges.has(k)).map(splitEdge);

// Findings deltas: what got worse, which is the thing worth gating on.
function delta(name, pick) {
  const cur = pick(current) || [];
  const prv = previous ? (pick(previous) || []) : [];
  const id = (x) => (typeof x === 'string' ? x : JSON.stringify(x));
  const prvSet = new Set(prv.map(id));
  const curSet = new Set(cur.map(id));
  return {
    name,
    count: cur.length,
    previousCount: prv.length,
    introduced: cur.filter((x) => !prvSet.has(id(x))),
    resolved: prv.filter((x) => !curSet.has(id(x))),
  };
}

const deltas = [
  delta('orphans', (s) => s.findings.orphans),
  delta('testOnly', (s) => s.findings.testOnly),
  delta('cycles', (s) => s.findings.cycles),
  delta('unresolved', (s) => s.findings.unresolved),
  delta('unusedDeps', (s) => s.findings.unusedDeps),
  delta('undeclaredDeps', (s) => s.findings.undeclaredDeps),
  delta('depsOnlyUsedInTests', (s) => s.findings.depsOnlyUsedInTests),
  delta('junkFiles', (s) => s.findings.junkFiles),
  delta('identicalFiles', (s) => s.findings.identicalFiles),
];

// ---------------------------------------------------------------------------
// Excess scoring: what is "excessive" in this codebase
// ---------------------------------------------------------------------------

const locs = Object.values(current.files).map((f) => f.loc).sort((a, b) => a - b);
function percentile(arr, p) {
  if (!arr.length) return 0;
  const i = Math.min(arr.length - 1, Math.floor((p / 100) * arr.length));
  return arr[i];
}
const p90Loc = percentile(locs, 90);
const locThreshold = Math.max(300, p90Loc);

const godFiles = Object.values(current.files)
  .filter((f) => !f.isTest && (f.loc > locThreshold || f.exports.length > 15))
  .map((f) => ({
    path: f.path, loc: f.loc, exports: f.exports.length, fanIn: f.fanIn, module: f.module,
    reason: [
      f.loc > locThreshold ? `${f.loc} LOC (p90 is ${p90Loc})` : null,
      f.exports.length > 15 ? `${f.exports.length} exports` : null,
    ].filter(Boolean).join(', '),
  }))
  .sort((a, b) => b.loc - a.loc);

const hubFiles = Object.values(current.files)
  .filter((f) => f.fanIn >= 12)
  .map((f) => ({ path: f.path, fanIn: f.fanIn, module: f.module }))
  .sort((a, b) => b.fanIn - a.fanIn);

const leakyModules = Object.values(current.modules)
  .filter((m) => m.fileCount >= 3 && m.cohesion < 0.5)
  .map((m) => ({ name: m.name, cohesion: m.cohesion, files: m.fileCount, outgoing: m.outgoingEdges }))
  .sort((a, b) => a.cohesion - b.cohesion);

const deadWeight = Object.values(current.files)
  .filter((f) => f.commentedOutCode >= 10)
  .map((f) => ({ path: f.path, commentedOutCode: f.commentedOutCode }))
  .sort((a, b) => b.commentedOutCode - a.commentedOutCode);

// ---------------------------------------------------------------------------
// Mermaid rendering
// ---------------------------------------------------------------------------

function nodeId(name) {
  return 'n' + Buffer.from(name).toString('hex').slice(0, 40);
}

function esc(s) { return String(s).replace(/"/g, '&quot;'); }

function renderModuleGraph() {
  const lines = [];
  lines.push('%% Generated by codebase-cartographer. Do not edit by hand.');
  lines.push(`%% commit ${current.git.shortSha || 'unknown'} on ${current.git.branch || 'unknown'} at ${current.generatedAt}`);
  lines.push('flowchart LR');

  const statusOf = (m) => {
    if (addedModules.includes(m)) return 'added';
    if (touchedModules.has(m)) return 'changed';
    return 'stable';
  };

  const allModules = [...curModules].sort();
  for (const m of allModules) {
    const mod = current.modules[m];
    const st = statusOf(m);
    const marker = st === 'added' ? 'NEW ' : st === 'changed' ? 'MOD ' : '';
    const label = `${marker}${m}<br/>${mod.fileCount} files - ${mod.loc} LOC<br/>cohesion ${mod.cohesion}`;
    lines.push(`  ${nodeId(m)}["${esc(label)}"]:::${st}`);
  }
  for (const m of removedModules) {
    lines.push(`  ${nodeId('gone:' + m)}["${esc('DELETED ' + m)}"]:::removed`);
  }

  const newEdgeSet = new Set(newModuleEdges.map(moduleEdgeKey));
  for (const e of current.moduleEdges || []) {
    const isNew = newEdgeSet.has(moduleEdgeKey(e));
    const arrow = isNew ? '==>' : '-->';
    lines.push(`  ${nodeId(e.from)} ${arrow}|${e.count}${isNew ? ' NEW' : ''}| ${nodeId(e.to)}`);
  }
  for (const e of droppedModuleEdges) {
    if (!curModules.has(e.from) || !curModules.has(e.to)) continue;
    lines.push(`  ${nodeId(e.from)} -.->|removed| ${nodeId(e.to)}`);
  }

  lines.push('');
  lines.push('  classDef added fill:#dcfce7,stroke:#16a34a,stroke-width:3px,color:#14532d');
  lines.push('  classDef changed fill:#fef9c3,stroke:#ca8a04,stroke-width:2px,color:#713f12');
  lines.push('  classDef stable fill:#f1f5f9,stroke:#94a3b8,color:#334155');
  lines.push('  classDef removed fill:#fee2e2,stroke:#dc2626,stroke-width:2px,color:#7f1d1d,stroke-dasharray: 5 4');
  return lines.join('\n') + '\n';
}

function renderFileGraph() {
  // Only the modules that moved, otherwise this is unreadable on any real repo.
  const scope = new Set(
    Object.values(current.files)
      .filter((f) => touchedModules.has(f.module))
      .map((f) => f.path)
  );
  if (!scope.size) return '%% No modules changed in this commit.\nflowchart LR\n  none["no changes"]\n';

  const lines = [];
  lines.push('%% Generated by codebase-cartographer. File level view of changed modules only.');
  lines.push('flowchart LR');

  const byModule = {};
  for (const f of scope) (byModule[current.files[f].module] ||= []).push(f);

  for (const [mod, list] of Object.entries(byModule)) {
    lines.push(`  subgraph ${nodeId('sg' + mod)}["${esc(mod)}"]`);
    for (const f of list.sort()) {
      const st = addedFiles.includes(f) ? 'added' : changedFiles.includes(f) ? 'changed' : 'stable';
      const marker = st === 'added' ? 'NEW ' : st === 'changed' ? 'MOD ' : '';
      const short = f.split('/').slice(-2).join('/');
      const orphan = current.findings.orphans.includes(f) ? ' [ORPHAN]' : '';
      lines.push(`    ${nodeId(f)}["${esc(marker + short + orphan)}"]:::${orphan ? 'orphan' : st}`);
    }
    lines.push('  end');
  }
  for (const f of removedFiles) {
    lines.push(`  ${nodeId('gone:' + f)}["${esc('DELETED ' + f.split('/').slice(-2).join('/'))}"]:::removed`);
  }

  const drawn = new Set();
  for (const e of current.edges) {
    if (!scope.has(e.from) || !scope.has(e.to)) continue;
    const k = edgeKey(e);
    if (drawn.has(k)) continue;
    drawn.add(k);
    const isNew = !prevEdges.has(k);
    lines.push(`  ${nodeId(e.from)} ${isNew ? '==>' : '-->'} ${nodeId(e.to)}`);
  }

  lines.push('');
  lines.push('  classDef added fill:#dcfce7,stroke:#16a34a,stroke-width:3px,color:#14532d');
  lines.push('  classDef changed fill:#fef9c3,stroke:#ca8a04,stroke-width:2px,color:#713f12');
  lines.push('  classDef stable fill:#f1f5f9,stroke:#94a3b8,color:#334155');
  lines.push('  classDef orphan fill:#fae8ff,stroke:#a21caf,stroke-width:2px,color:#701a75');
  lines.push('  classDef removed fill:#fee2e2,stroke:#dc2626,stroke-width:2px,color:#7f1d1d,stroke-dasharray: 5 4');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// MAP.md
// ---------------------------------------------------------------------------

function bullets(list, fmt, limit = 20) {
  if (!list.length) return '_none_\n';
  const shown = list.slice(0, limit).map((x) => '- ' + fmt(x)).join('\n');
  const more = list.length > limit ? `\n- _...and ${list.length - limit} more_` : '';
  return shown + more + '\n';
}

function renderMarkdown() {
  const g = current.git || {};
  const t = current.totals;
  const out = [];

  out.push(`# Codebase map`);
  out.push('');
  out.push(`Generated ${current.generatedAt} from commit \`${g.shortSha || 'unknown'}\` on \`${g.branch || 'unknown'}\`.`);
  if (g.subject) out.push(`Last commit: ${g.subject}`);
  out.push('');
  out.push(isBaseline
    ? '> **Baseline run.** No previous snapshot found, so everything is marked new and nothing is flagged as a regression. Commit `.codemap/snapshot.json` so the next run can diff against it.'
    : `> Compared against \`${prevLoaded.source}\` (commit \`${previous.git?.shortSha || 'unknown'}\`).`);
  out.push('');

  out.push('## At a glance');
  out.push('');
  out.push('| Metric | Now | Before | Delta |');
  out.push('|---|---:|---:|---:|');
  const pt = previous?.totals || {};
  const row = (label, key) => {
    const now = t[key] ?? 0;
    const before = pt[key];
    const d = before === undefined ? '' : signed(now - before);
    out.push(`| ${label} | ${now} | ${before ?? ''} | ${d} |`);
  };
  row('Source files', 'files');
  row('Test files', 'testFiles');
  row('Lines of code', 'loc');
  row('Internal imports', 'edges');
  row('Modules', 'modules');
  row('Entry points', 'entries');
  row('External packages', 'externalPackages');
  out.push('');

  out.push('## What changed in this commit');
  out.push('');
  out.push(`**New files (${addedFiles.length})**`);
  out.push('');
  out.push(bullets(addedFiles, (f) => `\`${f}\` — ${current.files[f].loc} LOC, module \`${current.files[f].module}\``));
  out.push(`**Modified files (${changedFiles.length})**`);
  out.push('');
  out.push(bullets(changedFiles, (f) => {
    const d = current.files[f].loc - previous.files[f].loc;
    return `\`${f}\` — ${signed(d)} LOC`;
  }));
  out.push(`**Deleted files (${removedFiles.length})**`);
  out.push('');
  out.push(bullets(removedFiles, (f) => `\`${f}\``));
  out.push(`**New module boundaries crossed (${newModuleEdges.length})**`);
  out.push('');
  out.push(bullets(newModuleEdges, (e) => `\`${e.from}\` now imports from \`${e.to}\``));

  out.push('## Module map');
  out.push('');
  out.push('Green is new in this commit, yellow was modified, dashed red was deleted. Thick arrows are dependency edges that did not exist before.');
  out.push('');
  out.push('```mermaid');
  out.push(renderModuleGraph().trimEnd());
  out.push('```');
  out.push('');

  out.push('## File map for changed modules');
  out.push('');
  out.push('```mermaid');
  out.push(renderFileGraph().trimEnd());
  out.push('```');
  out.push('');

  out.push('## Modules');
  out.push('');
  out.push('Cohesion is the share of a module\'s outbound imports that stay inside the module. Low cohesion means the module leans on the rest of the app and is a poor candidate for extraction as it stands.');
  out.push('');
  out.push('| Module | Files | LOC | Exports | Cohesion | In | Out |');
  out.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const m of Object.values(current.modules).sort((a, b) => b.loc - a.loc)) {
    const mark = addedModules.includes(m.name) ? ' **(new)**' : touchedModules.has(m.name) ? ' *(changed)*' : '';
    out.push(`| \`${m.name}\`${mark} | ${m.fileCount} | ${m.loc} | ${m.exports} | ${m.cohesion} | ${m.incomingEdges} | ${m.outgoingEdges} |`);
  }
  out.push('');

  out.push('## Excess and dead weight');
  out.push('');
  out.push(`### Unreachable files (${current.findings.orphans.length})`);
  out.push('');
  out.push('Not reachable from any detected entry point, including tests. Strong deletion candidates, but confirm the entry point list first.');
  out.push('');
  out.push(bullets(current.findings.orphans, (f) => `\`${f}\` — ${current.files[f].loc} LOC`, 40));

  out.push(`### Reachable only from tests (${current.findings.testOnly.length})`);
  out.push('');
  out.push('Product code that nothing in production imports. Usually a feature that got backed out and left its tests behind.');
  out.push('');
  out.push(bullets(current.findings.testOnly, (f) => `\`${f}\``, 30));

  out.push(`### Oversized files (${godFiles.length})`);
  out.push('');
  out.push(bullets(godFiles, (f) => `\`${f.path}\` — ${f.reason}`, 25));

  out.push(`### Import cycles (${current.findings.cycles.length})`);
  out.push('');
  out.push(bullets(current.findings.cycles, (c) => `${c.length} files: ${c.map((x) => `\`${x}\``).join(' -> ')}`, 15));

  out.push(`### Identical files (${current.findings.identicalFiles.length} groups)`);
  out.push('');
  out.push(bullets(current.findings.identicalFiles, (g) => g.map((x) => `\`${x}\``).join(' == '), 15));

  out.push(`### Commented out code (${deadWeight.length} files)`);
  out.push('');
  out.push(bullets(deadWeight, (f) => `\`${f.path}\` — ${f.commentedOutCode} commented statements`, 20));

  out.push(`### Low cohesion modules (${leakyModules.length})`);
  out.push('');
  out.push(bullets(leakyModules, (m) => `\`${m.name}\` — cohesion ${m.cohesion} across ${m.files} files, ${m.outgoing} outbound edges`, 15));

  out.push(`### Hub files (${hubFiles.length})`);
  out.push('');
  out.push('High fan in. Changing these has wide blast radius, so they need the most test coverage before any refactor.');
  out.push('');
  out.push(bullets(hubFiles, (f) => `\`${f.path}\` — imported by ${f.fanIn} files`, 20));

  out.push('## Dependency hygiene');
  out.push('');
  out.push(`**Declared but never imported (${current.findings.unusedDeps.length})**`);
  out.push('');
  out.push(bullets(current.findings.unusedDeps, (d) => `\`${d}\``, 40));
  out.push(`**Imported but not declared (${current.findings.undeclaredDeps.length})**`);
  out.push('');
  out.push(bullets(current.findings.undeclaredDeps, (d) => `\`${d}\` — used in ${current.externalUsage[d]?.length || 0} files`, 40));
  out.push(`**Runtime deps only used by tests (${current.findings.depsOnlyUsedInTests.length})**`);
  out.push('');
  out.push(bullets(current.findings.depsOnlyUsedInTests, (d) => `\`${d}\` — likely belongs in devDependencies`, 30));
  out.push(`**Unresolved imports (${current.findings.unresolved.length})**`);
  out.push('');
  out.push(bullets(current.findings.unresolved, (u) => `\`${u.from}\` imports \`${u.specifier}\` which did not resolve`, 25));

  out.push('## Repo hygiene');
  out.push('');
  out.push(`**Junk files (${current.findings.junkFiles.length})**`);
  out.push('');
  out.push(bullets(current.findings.junkFiles, (j) => `\`${j.path}\` — ${j.reason}`, 40));
  out.push(`**Large files (${current.findings.largeFiles.length})**`);
  out.push('');
  out.push(bullets(current.findings.largeFiles, (f) => `\`${f.path}\` — ${(f.bytes / 1048576).toFixed(1)} MB`, 20));

  out.push('## Regression check');
  out.push('');
  if (isBaseline) {
    out.push('_Baseline run, nothing to compare._');
  } else {
    out.push('| Finding | Now | Before | Introduced | Resolved |');
    out.push('|---|---:|---:|---:|---:|');
    for (const d of deltas) {
      out.push(`| ${d.name} | ${d.count} | ${d.previousCount} | ${d.introduced.length} | ${d.resolved.length} |`);
    }
    out.push('');
    const regressions = deltas.filter((d) => d.introduced.length > 0);
    if (regressions.length) {
      out.push('**Introduced by this commit:**');
      out.push('');
      for (const d of regressions) {
        const shown = d.introduced.slice(0, 8).map(describeFinding).join(', ');
        const more = d.introduced.length > 8 ? ` and ${d.introduced.length - 8} more` : '';
        out.push(`- **${d.name}**: ${shown}${more}`);
      }
    } else {
      out.push('No new findings introduced by this commit.');
    }
  }
  out.push('');
  out.push('---');
  out.push('');
  out.push('Regenerate with `node scripts/build-map.mjs && node scripts/report-map.mjs`. Commit `.codemap/snapshot.json` together with your code so the next run has something to diff against.');
  out.push('');
  return out.join('\n');
}

function signed(n) { return n > 0 ? `+${n}` : String(n); }

/**
 * Findings are a mix of shapes: plain paths, {path, reason} for junk,
 * {from, specifier} for unresolved imports, and arrays for cycles and
 * duplicate groups. Render each in a way a human can act on.
 */
function describeFinding(x) {
  if (typeof x === 'string') return '`' + x + '`';
  if (Array.isArray(x)) return x.map((i) => '`' + i + '`').join(' <-> ');
  if (x && x.path) return '`' + x.path + '`' + (x.reason ? ` (${x.reason})` : '');
  if (x && x.from && x.specifier) return '`' + x.from + '` -> `' + x.specifier + '`';
  return '`' + JSON.stringify(x) + '`';
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

fs.mkdirSync(args.outDir, { recursive: true });
fs.writeFileSync(path.join(args.outDir, 'MAP.md'), renderMarkdown());
fs.writeFileSync(path.join(args.outDir, 'map.mmd'), renderModuleGraph());
fs.writeFileSync(path.join(args.outDir, 'map-files.mmd'), renderFileGraph());

const report = {
  schema: 'codemap-report/1',
  generatedAt: new Date().toISOString(),
  baseline: isBaseline,
  comparedAgainst: prevLoaded.source,
  git: current.git,
  totals: current.totals,
  changed: {
    addedFiles, removedFiles, changedFiles,
    addedModules, removedModules,
    newModuleEdges, droppedModuleEdges,
    addedEdges: addedEdges.length, removedEdges: removedEdges.length,
  },
  excess: { godFiles, hubFiles, leakyModules, deadWeight },
  deltas,
};
fs.mkdirSync(path.join(args.repo, '.codemap'), { recursive: true });
fs.writeFileSync(path.join(args.repo, '.codemap', 'report.json'), JSON.stringify(report, null, 2) + '\n');

const introduced = isBaseline ? 0 : deltas.reduce((a, d) => a + d.introduced.length, 0);
const totalFindings = deltas.reduce((a, d) => a + d.count, 0);

console.error(`Wrote ${path.relative(args.repo, path.join(args.outDir, 'MAP.md'))}`);
console.error(`  ${addedFiles.length} new, ${changedFiles.length} modified, ${removedFiles.length} deleted files`);
console.error(isBaseline
  ? `  baseline run, ${totalFindings} findings recorded as the starting line`
  : `  ${introduced} findings introduced, ${totalFindings} total`);

if (args.failOn === 'regression' && !isBaseline && introduced > 0) {
  console.error(`FAIL: this commit introduced ${introduced} new findings.`);
  process.exit(1);
}
if (args.failOn === 'any' && totalFindings > 0) {
  console.error(`FAIL: ${totalFindings} findings outstanding.`);
  process.exit(1);
}
