#!/usr/bin/env node
/**
 * write-context.mjs
 *
 * Derives docs/codemap/CONTEXT.md from .codemap/snapshot.json: a compact
 * orientation brief for an agent about to work in this repo.
 *
 * The snapshot itself is far too large to load as context on a real codebase.
 * This produces a fixed-budget summary instead, so the cost of orienting stays
 * roughly constant as the repo grows.
 *
 * Hand written notes inside <!-- codemap:notes --> ... <!-- /codemap:notes -->
 * are preserved across regeneration. Anything a human knows that the graph
 * cannot show belongs there.
 *
 * Usage:
 *   node write-context.mjs [--repo <path>] [--budget 24000] [--out <path>]
 */

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const a = { repo: process.cwd(), budget: 24000, out: null, snapshot: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--repo') a.repo = path.resolve(argv[++i]);
    else if (k === '--budget') a.budget = parseInt(argv[++i], 10);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--snapshot') a.snapshot = path.resolve(argv[++i]);
  }
  if (!a.snapshot) a.snapshot = path.join(a.repo, '.codemap', 'snapshot.json');
  if (!a.out) a.out = path.join(a.repo, 'docs', 'codemap', 'CONTEXT.md');
  else a.out = path.resolve(a.repo, a.out);
  return a;
}

const args = parseArgs(process.argv);

let snap;
try { snap = JSON.parse(fs.readFileSync(args.snapshot, 'utf8')); }
catch { console.error(`Cannot read ${args.snapshot}. Run build-map.mjs first.`); process.exit(2); }

const NOTES_OPEN = '<!-- codemap:notes -->';
const NOTES_CLOSE = '<!-- /codemap:notes -->';

function preservedNotes() {
  try {
    const prev = fs.readFileSync(args.out, 'utf8');
    const start = prev.indexOf(NOTES_OPEN);
    const end = prev.indexOf(NOTES_CLOSE);
    if (start !== -1 && end > start) return prev.slice(start + NOTES_OPEN.length, end).trim();
  } catch { /* first run */ }
  return null;
}

const notes = preservedNotes();

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

const files = snap.files;
const modules = snap.modules;
const outAdj = {};
const inAdj = {};
for (const f of Object.keys(files)) { outAdj[f] = []; inAdj[f] = []; }
for (const e of snap.edges) { outAdj[e.from].push(e.to); inAdj[e.to].push(e.from); }

/** Classify an entry point so the flow section reads like the app, not a file list. */
function classifyEntry(p) {
  if (/\/app\/.*\/route\.[tj]s/.test('/' + p)) return 'HTTP route';
  if (/\/app\/.*\/page\.[tj]sx/.test('/' + p)) return 'Page';
  if (/\/pages\/api\//.test('/' + p)) return 'API route';
  if (/\/pages\//.test('/' + p)) return 'Page';
  if (/supabase\/functions\//.test(p)) return 'Edge function';
  if (/middleware\./.test(p)) return 'Middleware';
  if (/\.(test|spec)\./.test(p)) return 'Test';
  if (/\/scripts\//.test(p)) return 'Script';
  if (/(server|main|index|app|worker|cli)\./.test(p)) return 'Process entry';
  return 'Entry';
}

/** Human readable route name for Next.js style file conventions. */
function routeLabel(p) {
  const m = p.match(/\/app\/(.*)\/(route|page)\.[tj]sx?$/);
  if (m) return '/' + m[1].replace(/\(.*?\)\//g, '');
  const s = p.match(/supabase\/functions\/([^/]+)\//);
  if (s) return s[1];
  return p;
}

/** Downstream modules an entry point reaches, which is what a flow really is. */
function reachedModules(entry, maxDepth = 6) {
  const seen = new Set([entry]);
  const mods = new Set();
  let frontier = [entry];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const to of outAdj[cur] || []) {
        if (seen.has(to)) continue;
        seen.add(to);
        mods.add(files[to].module);
        next.push(to);
      }
    }
    frontier = next;
  }
  return { modules: [...mods], fileCount: seen.size - 1 };
}

/** Infer what a module is for from its file and export names. Heuristic, labelled as such. */
const ROLE_HINTS = [
  [/auth|session|login|token|jwt|permission|rbac/i, 'auth'],
  [/db|database|repo|repository|query|schema|migration|prisma|supabase|sql/i, 'data access'],
  [/api|route|handler|controller|endpoint|webhook/i, 'HTTP surface'],
  [/component|ui|view|page|layout|widget|render/i, 'UI'],
  [/util|helper|format|parse|convert|shared|common/i, 'utilities'],
  [/service|usecase|domain|workflow|orchestrat/i, 'business logic'],
  [/mail|email|notif|sms|push|send/i, 'notifications'],
  [/pay|billing|invoice|stripe|charge|subscription|checkout/i, 'billing'],
  [/config|env|setting|constant/i, 'configuration'],
  [/test|mock|fixture|stub/i, 'test support'],
  [/type|model|entity|interface|dto/i, 'types and models'],
  [/log|metric|trace|monitor|telemetry|analytic/i, 'observability'],
  [/job|queue|worker|cron|task|scheduler/i, 'background work'],
  [/storage|upload|file|s3|blob|asset/i, 'file storage'],
];

function inferRole(moduleName, fileList) {
  const corpus = moduleName + ' ' + fileList.slice(0, 40).map((f) =>
    path.basename(f, path.extname(f)) + ' ' + (files[f].exports || []).slice(0, 8).join(' ')
  ).join(' ');
  const hits = [];
  for (const [rx, label] of ROLE_HINTS) if (rx.test(corpus)) hits.push(label);
  return hits.slice(0, 3);
}

/** The exports most worth knowing: widely imported, from widely imported files. */
function keyExports(moduleName, limit = 6) {
  return modules[moduleName].files
    .filter((f) => !files[f].isTest && files[f].exports.length)
    .sort((a, b) => (inAdj[b].length - inAdj[a].length))
    .slice(0, 4)
    .flatMap((f) => files[f].exports.slice(0, 3).map((e) => `${e} (${path.basename(f)})`))
    .slice(0, limit);
}

const moduleDeps = {};
for (const m of Object.keys(modules)) moduleDeps[m] = new Set();
for (const e of snap.edges) {
  const a = files[e.from].module, b = files[e.to].module;
  if (a !== b) moduleDeps[a].add(b);
}

const hubs = Object.values(files)
  .filter((f) => !f.isTest)
  .map((f) => ({ path: f.path, fanIn: inAdj[f.path].length, module: f.module, exports: f.exports.slice(0, 5) }))
  .filter((f) => f.fanIn >= 3)
  .sort((a, b) => b.fanIn - a.fanIn)
  .slice(0, 12);

const prodEntries = snap.entries.filter((e) => !files[e].isTest);

// ---------------------------------------------------------------------------
// Render, respecting the budget
// ---------------------------------------------------------------------------

const out = [];
const g = snap.git || {};

out.push(`# ${snap.repo}: codebase context`);
out.push('');
out.push(`<!-- Generated by codebase-cartographer from .codemap/snapshot.json. Do not hand edit outside the notes block. -->`);
out.push('');
out.push(`**Map commit:** \`${g.sha || 'unknown'}\` (\`${g.shortSha || '?'}\` on \`${g.branch || '?'}\`)`);
out.push(`**Generated:** ${snap.generatedAt}`);
out.push(`**Size:** ${snap.totals.files} source files, ${snap.totals.loc} LOC, ${snap.totals.modules} modules, ${snap.totals.externalPackages} external packages`);
out.push('');
out.push('> **Trust rule.** This brief is accurate as of the commit above. Before relying on it, run');
out.push('> `node scripts/check-freshness.mjs`. If it reports DRIFTED, this brief is still valid except');
out.push('> for the files it names; read those from disk. If STALE, rebuild the map or read source directly.');
out.push('> For anything this brief does not cover, query the graph rather than reading files:');
out.push('> `node scripts/query-map.mjs --impact <file>` and `--trace <entry>`.');
out.push('');

if (snap.warnings?.length) {
  out.push('> **Warning:** the map was built with unresolved imports and may be inaccurate.');
  for (const w of snap.warnings) out.push(`> ${w}`);
  out.push('');
}

// --- Entry points ---------------------------------------------------------
out.push('## How the app is entered');
out.push('');
const byKind = {};
for (const e of prodEntries) (byKind[classifyEntry(e)] ||= []).push(e);
for (const [kind, list] of Object.entries(byKind).sort((a, b) => b[1].length - a[1].length)) {
  out.push(`**${kind}** (${list.length})`);
  out.push('');
  for (const e of list.slice(0, 12)) {
    const r = reachedModules(e);
    out.push(`- \`${routeLabel(e)}\` — \`${e}\` reaches ${r.fileCount} files across ${r.modules.length ? r.modules.map((m) => `\`${m}\``).join(', ') : 'nothing'}`);
  }
  if (list.length > 12) out.push(`- _...and ${list.length - 12} more_`);
  out.push('');
}

// --- Modules --------------------------------------------------------------
out.push('## Modules');
out.push('');
out.push('Roles are inferred from file and export names, so treat them as a hint rather than fact.');
out.push('Cohesion is the share of outbound imports staying inside the module.');
out.push('');
out.push('| Module | Files | LOC | Likely role | Depends on | Cohesion |');
out.push('|---|---:|---:|---|---|---:|');
for (const m of Object.values(modules).sort((a, b) => b.loc - a.loc)) {
  const role = inferRole(m.name, m.files);
  const deps = [...moduleDeps[m.name]].sort();
  out.push(`| \`${m.name}\` | ${m.fileCount} | ${m.loc} | ${role.join(', ') || '—'} | ${deps.length ? deps.map((d) => `\`${d}\``).join(', ') : '—'} | ${m.cohesion} |`);
}
out.push('');

out.push('### Key exports per module');
out.push('');
for (const m of Object.values(modules).sort((a, b) => b.loc - a.loc).slice(0, 12)) {
  const ke = keyExports(m.name);
  if (ke.length) out.push(`- \`${m.name}\`: ${ke.map((e) => `\`${e}\``).join(', ')}`);
}
out.push('');

// --- Hubs -----------------------------------------------------------------
out.push('## Files worth reading first');
out.push('');
out.push('Highest fan-in, so understanding these explains the most about the rest. They also carry the widest blast radius when changed.');
out.push('');
for (const h of hubs) {
  out.push(`- \`${h.path}\` — imported by ${h.fanIn} files. Exports: ${h.exports.map((e) => `\`${e}\``).join(', ') || '—'}`);
}
out.push('');

// --- Where things live ----------------------------------------------------
out.push('## Where to look by task');
out.push('');
const taskMap = [];
for (const m of Object.values(modules)) {
  for (const role of inferRole(m.name, m.files)) {
    taskMap.push([role, m.name]);
  }
}
const byRole = {};
for (const [role, m] of taskMap) (byRole[role] ||= []).push(m);
for (const [role, mods] of Object.entries(byRole).sort()) {
  out.push(`- **${role}**: ${[...new Set(mods)].map((m) => `\`${m}\``).join(', ')}`);
}
out.push('');

// --- Landmines ------------------------------------------------------------
out.push('## Known problems in this codebase');
out.push('');
const f = snap.findings;
const landmines = [];
if (f.cycles.length) landmines.push(`**${f.cycles.length} import cycles.** Largest: ${f.cycles[0].map((x) => `\`${x}\``).join(' <-> ')}. Load order here is fragile.`);
if (f.orphans.length) landmines.push(`**${f.orphans.length} unreachable files.** Not reached from any entry point. Do not assume they are live: ${f.orphans.slice(0, 5).map((x) => `\`${x}\``).join(', ')}${f.orphans.length > 5 ? ', ...' : ''}`);
if (f.testOnly.length) landmines.push(`**${f.testOnly.length} files only tests reach.** Likely backed-out features: ${f.testOnly.slice(0, 5).map((x) => `\`${x}\``).join(', ')}`);
if (f.unresolved.length) landmines.push(`**${f.unresolved.length} imports do not resolve.** The graph is incomplete around these.`);
if (f.identicalFiles.length) landmines.push(`**${f.identicalFiles.length} groups of byte-identical files.** Editing one will not change the other.`);
if (f.undeclaredDeps.length) landmines.push(`**${f.undeclaredDeps.length} packages imported but not in package.json.** Works locally, breaks on clean install: ${f.undeclaredDeps.map((d) => `\`${d}\``).join(', ')}`);
const lowCohesion = Object.values(modules).filter((m) => m.fileCount >= 3 && m.cohesion < 0.5);
if (lowCohesion.length) landmines.push(`**${lowCohesion.length} modules with low cohesion**, so their boundaries are not real yet: ${lowCohesion.map((m) => `\`${m.name}\``).join(', ')}`);

out.push(landmines.length ? landmines.map((l) => '- ' + l).join('\n') : '- None detected.');
out.push('');

// --- External deps --------------------------------------------------------
out.push('## Main external dependencies');
out.push('');
const topExternal = Object.entries(snap.externalUsage || {})
  .filter(([k]) => !k.startsWith('node:'))
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 15);
for (const [pkgName, users] of topExternal) {
  out.push(`- \`${pkgName}\` — used in ${users.length} files${users.length <= 3 ? ` (${users.map((u) => `\`${u}\``).join(', ')})` : ''}`);
}
out.push('');

// --- Human notes ----------------------------------------------------------
out.push('## Notes from the team');
out.push('');
out.push('Anything the dependency graph cannot show: business rules, deploy quirks, why a');
out.push('weird thing is the way it is. This block survives regeneration.');
out.push('');
out.push(NOTES_OPEN);
out.push('');
out.push(notes || '_No notes yet. Add them here and they will persist across map rebuilds._');
out.push('');
out.push(NOTES_CLOSE);
out.push('');

let text = out.join('\n');

// Budget enforcement: trim the long tail sections rather than truncating mid table,
// because a brief that ends mid-sentence is worse than one that admits it was cut.
const approxTokens = (s) => Math.ceil(s.length / 4);
if (approxTokens(text) > args.budget) {
  const marker = '## Main external dependencies';
  const idx = text.indexOf(marker);
  if (idx !== -1 && approxTokens(text.slice(0, idx)) < args.budget) {
    const notesBlock = text.slice(text.indexOf('## Notes from the team'));
    text = text.slice(0, idx)
      + `_External dependency list omitted to stay within the context budget. Run \`node scripts/query-map.mjs --deps\` for it._\n\n`
      + notesBlock;
  }
}

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, text);

console.error(`Wrote ${path.relative(args.repo, args.out)}`);
console.error(`  ~${approxTokens(text)} tokens (budget ${args.budget}), covering ${snap.totals.files} files / ${snap.totals.loc} LOC`);
if (notes) console.error('  preserved existing team notes');
