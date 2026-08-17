#!/usr/bin/env node
/**
 * build-map.mjs
 *
 * Zero dependency codebase mapper for TypeScript / Node repos.
 * Produces .codemap/snapshot.json describing:
 *   - every source file, its exports, LOC, fan in / fan out
 *   - the resolved import graph (internal edges) and external package usage
 *   - detected entry points and reachability from them (orphan detection)
 *   - import cycles (Tarjan SCC)
 *   - module clustering and cross module edges
 *   - repo hygiene findings (junk files, committed build output, secrets risk)
 *
 * Usage:
 *   node build-map.mjs [--repo <path>] [--out <path>] [--quiet]
 *
 * Config (optional): .codemap/config.json
 *   {
 *     "roots": ["src"],
 *     "ignore": ["**\/*.stories.tsx"],
 *     "entries": ["src/server.ts"],
 *     "moduleDepth": 1
 *   }
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { stripComments, cheapHash } from './hash.mjs';

const SOURCE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const RESOLVE_EXT = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', '.vercel',
  'coverage', '.nyc_output', '.cache', 'vendor', '.venv', '__pycache__',
  '.codemap', 'storybook-static', '.output', '.svelte-kit',
]);

const TEST_PATTERN = /(\.|\/)(test|spec)\.[cm]?[tj]sx?$|(^|\/)(__tests__|__mocks__|tests?|e2e|cypress|playwright)\//;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { repo: process.cwd(), out: null, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') args.repo = path.resolve(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--quiet') args.quiet = true;
  }
  if (!args.out) args.out = path.join(args.repo, '.codemap', 'snapshot.json');
  return args;
}

const args = parseArgs(process.argv);
const log = (...m) => { if (!args.quiet) console.error(...m); };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readJsonLoose(file) {
  // tsconfig.json and friends allow comments and trailing commas.
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const noComments = stripComments(raw);
    const noTrailing = noComments.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(noTrailing);
  } catch {
    return null;
  }
}

function toPosix(p) { return p.split(path.sep).join('/'); }

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp('^' + escaped + '$');
}

// ---------------------------------------------------------------------------
// Config, tsconfig, package.json
// ---------------------------------------------------------------------------

const repo = args.repo;
const config = readJsonLoose(path.join(repo, '.codemap', 'config.json')) || {};
const pkg = readJsonLoose(path.join(repo, 'package.json')) || {};

function loadTsConfig() {
  // Follow "extends" one level, which covers the common monorepo base config case.
  const candidates = ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json'];
  for (const name of candidates) {
    const p = path.join(repo, name);
    if (!fs.existsSync(p)) continue;
    let cfg = readJsonLoose(p);
    if (!cfg) continue;
    if (cfg.extends && typeof cfg.extends === 'string' && cfg.extends.startsWith('.')) {
      const parent = readJsonLoose(path.resolve(path.dirname(p), cfg.extends));
      if (parent) {
        cfg = {
          ...parent, ...cfg,
          compilerOptions: { ...(parent.compilerOptions || {}), ...(cfg.compilerOptions || {}) },
        };
      }
    }
    return { file: name, options: cfg.compilerOptions || {} };
  }
  return { file: null, options: {} };
}

const tsconfig = loadTsConfig();
const baseUrl = tsconfig.options.baseUrl
  ? path.resolve(repo, tsconfig.options.baseUrl)
  : repo;
/**
 * tsconfig "paths" wildcards are NOT the same as file globs: a single `*` in
 * "@/*" matches across slashes, so "@/lib/db" must match. Using the ignore-glob
 * converter here silently fails to resolve every aliased import, which then
 * cascades into the whole app looking orphaned. Keep this matcher separate.
 */
function aliasToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '(.*)');
  return new RegExp('^' + escaped + '$');
}

const pathAliases = Object.entries(tsconfig.options.paths || {}).map(([pattern, targets]) => ({
  pattern,
  regex: aliasToRegExp(pattern),
  targets: Array.isArray(targets) ? targets : [targets],
}));

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function detectRoots() {
  if (Array.isArray(config.roots) && config.roots.length) return config.roots;
  const guesses = ['src', 'app', 'lib', 'server', 'packages', 'apps', 'supabase/functions', 'bin', 'scripts', 'test', 'tests', '__tests__'];
  const found = guesses.filter((g) => fs.existsSync(path.join(repo, g)));

  // A repo whose entry point lives outside the guessed directories (a CLI in
  // bin/, say) would otherwise be scanned without any entry point at all, and
  // every file would be reported as dead. Pull the directories named by
  // package.json into the root set so that cannot happen silently.
  const declared = [];
  for (const v of [pkg.main, pkg.module, pkg.browser]) if (typeof v === 'string') declared.push(v);
  if (pkg.bin) declared.push(...(typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin)));
  if (pkg.exports && typeof pkg.exports === 'object') {
    for (const v of Object.values(pkg.exports)) {
      if (typeof v === 'string') declared.push(v);
      else if (v && typeof v === 'object') for (const inner of Object.values(v)) if (typeof inner === 'string') declared.push(inner);
    }
  }
  for (const d of declared) {
    const dir = toPosix(path.dirname(d)).replace(/^\.\//, '').split('/')[0];
    if (dir && dir !== '.' && dir !== '..' && !found.includes(dir) && fs.existsSync(path.join(repo, dir))) {
      found.push(dir);
    }
  }
  return found.length ? found : ['.'];
}

const roots = detectRoots();
const ignoreGlobs = (config.ignore || []).map(globToRegExp);

function walk(dir, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (DEFAULT_IGNORE_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.') continue;
      walk(full, acc);
    } else if (e.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

const allFiles = [];
for (const r of roots) walk(path.join(repo, r), allFiles);

const sourceFiles = allFiles
  .filter((f) => SOURCE_EXT.includes(path.extname(f)))
  .filter((f) => !f.endsWith('.d.ts'))
  .map((f) => toPosix(path.relative(repo, f)))
  .filter((rel) => !ignoreGlobs.some((rx) => rx.test(rel)))
  .sort();

const sourceSet = new Set(sourceFiles);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?[\w${},*\s\n]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const EXPORT_DECL = /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/g;
const EXPORT_LIST = /\bexport\s*\{([^}]*)\}/g;
const EXPORT_DEFAULT = /\bexport\s+default\b/;

/**
 * Blank the interior of template literals, preserving offsets and newlines.
 *
 * Files that embed code as data (test fixtures, codegen templates, docs
 * tooling) would otherwise have their sample `import ... from '...'` lines
 * parsed as real imports, producing phantom edges and phantom unresolved
 * findings. A static import is never inside a template literal, and a dynamic
 * `import(`...`)` built from one is not statically resolvable anyway, so
 * nothing real is lost here.
 */
function blankTemplateLiterals(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let depth = 0;          // nesting depth of template literals
  let state = 'code';     // code | single | double
  while (i < n) {
    const c = src[i];
    if (depth === 0 && state === 'code') {
      if (c === '`') { depth = 1; out += c; i++; continue; }
      if (c === "'") { state = 'single'; out += c; i++; continue; }
      if (c === '"') { state = 'double'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'single' || state === 'double') {
      out += c;
      if (c === '\\') { if (i + 1 < n) out += src[i + 1]; i += 2; continue; }
      if ((state === 'single' && c === "'") || (state === 'double' && c === '"')) state = 'code';
      i++; continue;
    }
    // Inside a template literal: keep backticks, braces and newlines, blank the rest.
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === '`') { depth--; out += c; i++; continue; }
    if (c === '$' && src[i + 1] === '{') { depth++; out += '${'; i += 2; continue; }
    if (c === '}' && depth > 1) { depth--; out += c; i++; continue; }
    out += c === '\n' ? '\n' : ' ';
    i++;
  }
  return out;
}

function parseFile(rel) {
  const abs = path.join(repo, rel);
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  const code = stripComments(raw);
  const scannable = blankTemplateLiterals(code);

  const rawLines = raw.split('\n');
  const codeLines = code.split('\n').filter((l) => l.trim().length > 0);

  const specifiers = new Set();
  for (const rx of IMPORT_PATTERNS) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(scannable)) !== null) specifiers.add(m[1]);
  }

  const exports = new Set();
  let m;
  EXPORT_DECL.lastIndex = 0;
  while ((m = EXPORT_DECL.exec(scannable)) !== null) exports.add(m[1]);
  EXPORT_LIST.lastIndex = 0;
  while ((m = EXPORT_LIST.exec(scannable)) !== null) {
    for (const piece of m[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop().trim();
      if (name && name !== 'type') exports.add(name.replace(/^type\s+/, ''));
    }
  }
  if (EXPORT_DEFAULT.test(scannable)) exports.add('default');

  // Cheap smells that matter for the audit pass.
  const commentedOutCode = countCommentedOutCode(rawLines);
  const todos = (raw.match(/\b(TODO|FIXME|HACK|XXX)\b/g) || []).length;

  return {
    path: rel,
    loc: codeLines.length,
    rawLoc: rawLines.length,
    bytes: Buffer.byteLength(raw),
    exports: [...exports].sort(),
    specifiers: [...specifiers],
    isTest: TEST_PATTERN.test('/' + rel),
    todos,
    commentedOutCode,
    hash: cheapHash(code),
  };
}

function countCommentedOutCode(lines) {
  // A commented line that looks like a statement rather than prose.
  let n = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('//')) continue;
    const body = t.slice(2).trim();
    if (body.length < 8) continue;
    if (/[;{}]$|^(const|let|var|function|class|import|export|return|if|for|while)\b|=>|\)\s*[;{]?$/.test(body)) n++;
  }
  return n;
}

log(`Parsing ${sourceFiles.length} source files...`);
const files = {};
for (const rel of sourceFiles) {
  const parsed = parseFile(rel);
  if (parsed) files[rel] = parsed;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function tryFile(absNoExt) {
  if (sourceSet.has(toPosix(path.relative(repo, absNoExt))) && fs.existsSync(absNoExt)) {
    return toPosix(path.relative(repo, absNoExt));
  }
  for (const ext of RESOLVE_EXT) {
    const cand = absNoExt + ext;
    const rel = toPosix(path.relative(repo, cand));
    if (sourceSet.has(rel)) return rel;
  }
  for (const ext of RESOLVE_EXT) {
    const cand = path.join(absNoExt, 'index' + ext);
    const rel = toPosix(path.relative(repo, cand));
    if (sourceSet.has(rel)) return rel;
  }
  return null;
}

function resolveSpecifier(spec, fromRel) {
  if (spec.startsWith('.')) {
    const abs = path.resolve(path.dirname(path.join(repo, fromRel)), stripQuery(spec));
    return { kind: 'internal', target: tryFile(abs) };
  }
  for (const alias of pathAliases) {
    const match = alias.regex.exec(stripQuery(spec));
    if (!match) continue;
    const wildcard = match[1] || '';
    for (const target of alias.targets) {
      const abs = path.resolve(baseUrl, target.replace(/\*/g, wildcard));
      const hit = tryFile(abs);
      if (hit) return { kind: 'internal', target: hit };
    }
    // Matched an alias but resolved to nothing: an internal import that is
    // broken or points outside the scanned roots. Never count it as a package.
    return { kind: 'internal', target: null };
  }
  // Non relative and not an alias: could still be baseUrl relative.
  if (tsconfig.options.baseUrl) {
    const hit = tryFile(path.resolve(baseUrl, stripQuery(spec)));
    if (hit) return { kind: 'internal', target: hit };
  }
  return { kind: 'external', target: packageNameOf(spec) };
}

function stripQuery(s) { return s.split('?')[0]; }

function packageNameOf(spec) {
  const clean = stripQuery(spec);
  if (clean.startsWith('node:')) return clean;
  const parts = clean.split('/');
  return clean.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const edges = [];          // { from, to }
const unresolved = [];     // { from, specifier }
const externalUsage = {};  // pkg -> [files]

for (const rel of Object.keys(files)) {
  const f = files[rel];
  const seen = new Set();
  for (const spec of f.specifiers) {
    const r = resolveSpecifier(spec, rel);
    if (r.kind === 'internal') {
      if (!r.target) { unresolved.push({ from: rel, specifier: spec }); continue; }
      if (r.target === rel) continue;
      const key = r.target;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: rel, to: r.target });
    } else {
      (externalUsage[r.target] ||= []).push(rel);
    }
  }
  delete f.specifiers;
}

// If a large share of internal specifiers fail to resolve, the alias or root
// config is wrong and every downstream finding (orphans especially) is garbage.
// Say so loudly rather than emitting a confident but false map.
const resolutionWarnings = [];
const internalAttempts = edges.length + unresolved.length;
if (internalAttempts > 0) {
  const failRate = unresolved.length / internalAttempts;
  // Require an absolute floor as well as a ratio. On a small repo a single
  // typo is a large fraction of very few imports, and warning that the whole
  // map is unreliable over one bad specifier trains people to ignore warnings.
  if (failRate > 0.1 && unresolved.length >= 3) {
    resolutionWarnings.push(
      `${unresolved.length} of ${internalAttempts} internal imports (${Math.round(failRate * 100)}%) did not resolve. ` +
      `Orphan and reachability findings are unreliable until this is fixed. ` +
      `Check tsconfig paths (${tsconfig.file || 'none found'}) and the scanned roots (${roots.join(', ')}).`
    );
  }
}
const outAdj = {};
const inAdj = {};
for (const rel of Object.keys(files)) { outAdj[rel] = []; inAdj[rel] = []; }
for (const e of edges) { outAdj[e.from].push(e.to); inAdj[e.to].push(e.from); }
for (const rel of Object.keys(files)) {
  files[rel].fanOut = outAdj[rel].length;
  files[rel].fanIn = inAdj[rel].length;
}

// ---------------------------------------------------------------------------
// Entry points and reachability
// ---------------------------------------------------------------------------

const ENTRY_PATTERNS = [
  /(^|\/)app\/.*\/(page|layout|route|template|error|loading|not-found)\.[tj]sx?$/,
  /(^|\/)app\/(page|layout|route)\.[tj]sx?$/,
  /(^|\/)pages\/.*\.[tj]sx?$/,
  /(^|\/)api\/.*\.[tj]sx?$/,
  /(^|\/)supabase\/functions\/[^/]+\/index\.ts$/,
  /(^|\/)(server|main|index|app|worker|cli)\.[tj]sx?$/,
  /(^|\/)middleware\.[tj]s$/,
  /\.config\.[tjm]s$/,
  /(^|\/)scripts\/[^/]+\.[tjm]s$/,
];

function detectEntries() {
  const entries = new Set();
  for (const e of config.entries || []) if (files[e]) entries.add(e);

  for (const field of ['main', 'module', 'browser']) {
    const v = pkg[field];
    if (typeof v === 'string') {
      const hit = tryFile(path.resolve(repo, v.replace(/\.[cm]?js$/, '')));
      if (hit) entries.add(hit);
    }
  }
  if (pkg.bin && typeof pkg.bin === 'object') {
    for (const v of Object.values(pkg.bin)) {
      const hit = tryFile(path.resolve(repo, String(v).replace(/\.[cm]?js$/, '')));
      if (hit) entries.add(hit);
    }
  }
  for (const rel of Object.keys(files)) {
    if (files[rel].isTest) { entries.add(rel); continue; }
    if (ENTRY_PATTERNS.some((rx) => rx.test('/' + rel))) entries.add(rel);
  }
  return [...entries].sort();
}

const entries = detectEntries();

function reachableFrom(seeds) {
  const seen = new Set(seeds.filter((s) => files[s]));
  const stack = [...seen];
  while (stack.length) {
    const cur = stack.pop();
    for (const next of outAdj[cur] || []) {
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  return seen;
}

const reachable = reachableFrom(entries);
const nonTestEntries = entries.filter((e) => !files[e].isTest);
const reachableFromProd = reachableFrom(nonTestEntries);

const orphans = Object.keys(files)
  .filter((rel) => !reachable.has(rel))
  .sort();

// Files only kept alive by tests: dead product code with a test still attached.
const testOnly = Object.keys(files)
  .filter((rel) => !files[rel].isTest && reachable.has(rel) && !reachableFromProd.has(rel))
  .sort();

// Two config failures make the map actively misleading rather than merely
// incomplete, because the output looks confident either way. Say so plainly.
if (entries.length === 0 && Object.keys(files).length > 0) {
  resolutionWarnings.push(
    `No entry points were detected, so nothing is reachable and every file is reported as an orphan. ` +
    `This is almost always a config problem, not dead code. Set "entries" in .codemap/config.json ` +
    `(scanned roots: ${roots.join(', ')}).`
  );
} else if (orphans.length > 0 && orphans.length / Object.keys(files).length > 0.5) {
  resolutionWarnings.push(
    `${orphans.length} of ${Object.keys(files).length} files are unreachable from the ${entries.length} detected ` +
    `entry points. A majority-orphan result usually means entry points are missing rather than that the code is dead. ` +
    `Verify before deleting anything.`
  );
}

// ---------------------------------------------------------------------------
// Cycles (Tarjan strongly connected components)
// ---------------------------------------------------------------------------

function tarjan() {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const comps = [];
  let counter = 0;

  const nodes = Object.keys(files);
  for (const node of nodes) if (!index.has(node)) strongConnect(node);

  function strongConnect(root) {
    // Iterative to avoid blowing the stack on large repos.
    const work = [[root, 0]];
    index.set(root, counter); low.set(root, counter); counter++;
    stack.push(root); onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      const neighbours = outAdj[v] || [];
      if (i < neighbours.length) {
        frame[1]++;
        const w = neighbours[i];
        if (!index.has(w)) {
          index.set(w, counter); low.set(w, counter); counter++;
          stack.push(w); onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low.set(parent, Math.min(low.get(parent), low.get(v)));
        }
        if (low.get(v) === index.get(v)) {
          const comp = [];
          let w;
          do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
          if (comp.length > 1) comps.push(comp.sort());
        }
      }
    }
  }
  // Self loops are already filtered out at edge construction time.
  return comps.sort((a, b) => b.length - a.length);
}

const cycles = tarjan();

// ---------------------------------------------------------------------------
// Module clustering
// ---------------------------------------------------------------------------

const moduleDepth = Number.isInteger(config.moduleDepth) ? config.moduleDepth : 1;

function moduleOf(rel) {
  let p = rel;
  for (const r of roots) {
    const prefix = r === '.' ? '' : r + '/';
    if (prefix && p.startsWith(prefix)) { p = p.slice(prefix.length); break; }
  }
  const segs = p.split('/');
  if (segs.length <= 1) return '(root)';
  return segs.slice(0, moduleDepth).join('/');
}

const modules = {};
for (const rel of Object.keys(files)) {
  const m = moduleOf(rel);
  files[rel].module = m;
  (modules[m] ||= { name: m, files: [], loc: 0, exports: 0 });
  modules[m].files.push(rel);
  modules[m].loc += files[rel].loc;
  modules[m].exports += files[rel].exports.length;
}

const moduleEdges = {};
for (const e of edges) {
  const a = files[e.from].module;
  const b = files[e.to].module;
  if (a === b) continue;
  const key = a + '->' + b;
  (moduleEdges[key] ||= { from: a, to: b, count: 0, examples: [] });
  moduleEdges[key].count++;
  if (moduleEdges[key].examples.length < 5) moduleEdges[key].examples.push(`${e.from} -> ${e.to}`);
}

// Coupling metrics per module: how self contained is it?
for (const m of Object.values(modules)) {
  const internal = edges.filter((e) => files[e.from].module === m.name && files[e.to].module === m.name).length;
  const outgoing = edges.filter((e) => files[e.from].module === m.name && files[e.to].module !== m.name).length;
  const incoming = edges.filter((e) => files[e.to].module === m.name && files[e.from].module !== m.name).length;
  m.internalEdges = internal;
  m.outgoingEdges = outgoing;
  m.incomingEdges = incoming;
  m.cohesion = internal + outgoing === 0 ? 1 : Number((internal / (internal + outgoing)).toFixed(3));
  m.fileCount = m.files.length;
}

// ---------------------------------------------------------------------------
// Dependency hygiene
// ---------------------------------------------------------------------------

const declaredDeps = Object.keys(pkg.dependencies || {});
const declaredDevDeps = Object.keys(pkg.devDependencies || {});
const usedPkgs = new Set(Object.keys(externalUsage).filter((p) => !p.startsWith('node:')));

const unusedDeps = declaredDeps.filter((d) => !usedPkgs.has(d));
const undeclaredDeps = [...usedPkgs].filter(
  (p) => !declaredDeps.includes(p) && !declaredDevDeps.includes(p) && !p.startsWith('.')
);
// A runtime dependency used only from test files is probably a devDependency.
const depsOnlyUsedInTests = declaredDeps.filter((d) => {
  const users = externalUsage[d];
  return users && users.length > 0 && users.every((u) => files[u]?.isTest);
});

// ---------------------------------------------------------------------------
// Repo hygiene: the "junk in the repo" scan
// ---------------------------------------------------------------------------

const JUNK_PATTERNS = [
  { rx: /(^|\/)\.DS_Store$/, label: 'macOS metadata' },
  { rx: /(^|\/)Thumbs\.db$/, label: 'Windows metadata' },
  { rx: /\.(log)$/, label: 'log file' },
  { rx: /\.(orig|rej|bak|old|backup|tmp|swp)$/, label: 'editor or merge artifact' },
  { rx: /(^|\/)\.env(\.|$)(?!example|sample|template)/, label: 'env file (possible secrets)' },
  { rx: /(^|\/)(dist|build|out|\.next)\//, label: 'committed build output' },
  { rx: /\s(copy|final|v\d)\.[a-z]+$/i, label: 'duplicate-looking filename' },
  { rx: /(^|\/)[^/]*\.(zip|tar|gz|rar|7z)$/, label: 'archive committed to repo' },
];

function gitTrackedFiles() {
  try {
    const out = execSync('git ls-files -z', { cwd: repo, maxBuffer: 64 * 1024 * 1024 }).toString();
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

const tracked = gitTrackedFiles();
const hygieneScope = tracked || allFiles.map((f) => toPosix(path.relative(repo, f)));

// `git ls-files` reports the index, which still lists files the developer has
// deleted but not staged. Only report junk that is actually still on disk,
// otherwise a cleanup looks like it did nothing.
const junkFiles = [];
for (const rel of hygieneScope) {
  if (!fs.existsSync(path.join(repo, rel))) continue;
  for (const { rx, label } of JUNK_PATTERNS) {
    if (rx.test('/' + rel)) { junkFiles.push({ path: rel, reason: label }); break; }
  }
}

const largeFiles = [];
for (const rel of hygieneScope) {
  try {
    const st = fs.statSync(path.join(repo, rel));
    if (st.size > 1024 * 1024) largeFiles.push({ path: rel, bytes: st.size });
  } catch { /* file may be gone */ }
}
largeFiles.sort((a, b) => b.bytes - a.bytes);

// ---------------------------------------------------------------------------
// Duplication candidates (structural, cheap)
// ---------------------------------------------------------------------------

const byHash = {};
for (const [rel, f] of Object.entries(files)) (byHash[f.hash] ||= []).push(rel);
const identicalFiles = Object.values(byHash).filter((g) => g.length > 1);

// ---------------------------------------------------------------------------
// Git context
// ---------------------------------------------------------------------------

function git(cmd, fallback = null) {
  try { return execSync(cmd, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return fallback; }
}

const gitInfo = {
  sha: git('git rev-parse HEAD'),
  shortSha: git('git rev-parse --short HEAD'),
  branch: git('git rev-parse --abbrev-ref HEAD'),
  subject: git('git log -1 --pretty=%s'),
  author: git('git log -1 --pretty=%an'),
  committedAt: git('git log -1 --pretty=%cI'),
};

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const snapshot = {
  schema: 'codemap/1',
  generatedAt: new Date().toISOString(),
  repo: path.basename(repo),
  git: gitInfo,
  config: { roots, moduleDepth, tsconfig: tsconfig.file },
  totals: {
    files: Object.keys(files).length,
    testFiles: Object.values(files).filter((f) => f.isTest).length,
    loc: Object.values(files).reduce((a, f) => a + f.loc, 0),
    edges: edges.length,
    modules: Object.keys(modules).length,
    entries: entries.length,
    externalPackages: usedPkgs.size,
  },
  files,
  edges,
  modules,
  moduleEdges: Object.values(moduleEdges).sort((a, b) => b.count - a.count),
  entries,
  warnings: resolutionWarnings,
  findings: {
    orphans,
    testOnly,
    cycles,
    unresolved,
    unusedDeps,
    undeclaredDeps,
    depsOnlyUsedInTests,
    junkFiles,
    largeFiles: largeFiles.slice(0, 50),
    identicalFiles,
  },
  externalUsage: Object.fromEntries(
    Object.entries(externalUsage).map(([k, v]) => [k, [...new Set(v)].sort()])
  ),
};

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(snapshot, null, 2) + '\n');

log(`Wrote ${toPosix(path.relative(repo, args.out))}`);
log(`  ${snapshot.totals.files} files, ${snapshot.totals.loc} LOC, ${snapshot.totals.edges} internal imports, ${snapshot.totals.modules} modules`);
for (const w of resolutionWarnings) log(`WARNING: ${w}`);
log(`  ${orphans.length} orphans, ${cycles.length} cycles, ${junkFiles.length} junk files, ${unusedDeps.length} unused deps`);

if (!args.quiet) console.log(args.out);
