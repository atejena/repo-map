#!/usr/bin/env node
/**
 * query-map.mjs
 *
 * Answers targeted questions against the committed map. This is where the token
 * saving actually lives: "what breaks if I change this file" is a graph query
 * that costs a few hundred tokens, versus grepping and opening thirty files to
 * reconstruct the same answer badly.
 *
 * Commands:
 *   --file <path>       what it imports, what imports it, module, size
 *   --impact <path>     everything transitively depending on it (blast radius)
 *   --trace <path>      everything it transitively pulls in (downstream)
 *   --module <name>     contents, public surface, boundaries
 *   --find <substring>  locate files or exports by name
 *   --entries           entry points grouped by kind
 *   --deps              external packages and where they are used
 *   --hot               highest fan-in files
 *   --between <a> <b>   shortest import path from a to b, if any
 *
 * Flags: --repo <path> --json --limit <n>
 */

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const a = { repo: process.cwd(), json: false, limit: 40, cmd: null, arg: null, arg2: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--repo') a.repo = path.resolve(argv[++i]);
    else if (k === '--json') a.json = true;
    else if (k === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (k.startsWith('--')) {
      a.cmd = k.slice(2);
      if (!['entries', 'deps', 'hot'].includes(a.cmd)) a.arg = argv[++i];
      if (a.cmd === 'between') a.arg2 = argv[++i];
    }
  }
  return a;
}

const args = parseArgs(process.argv);
const snapPath = path.join(args.repo, '.codemap', 'snapshot.json');

let snap;
try { snap = JSON.parse(fs.readFileSync(snapPath, 'utf8')); }
catch { console.error('No readable .codemap/snapshot.json. Run build-map.mjs first.'); process.exit(2); }

const files = snap.files;
const outAdj = {};
const inAdj = {};
for (const f of Object.keys(files)) { outAdj[f] = []; inAdj[f] = []; }
for (const e of snap.edges) { outAdj[e.from].push(e.to); inAdj[e.to].push(e.from); }

/** Accept partial paths, since nobody wants to type the full thing. */
function resolvePath(input) {
  if (files[input]) return input;
  const matches = Object.keys(files).filter((f) => f.includes(input));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const exact = matches.filter((f) => path.basename(f) === input || path.basename(f, path.extname(f)) === input);
    if (exact.length === 1) return exact[0];
    console.error(`Ambiguous: "${input}" matches ${matches.length} files:`);
    for (const m of matches.slice(0, 15)) console.error('  ' + m);
    process.exit(2);
  }
  console.error(`Not in the map: "${input}". If the file is new, the map is stale; run check-freshness.mjs.`);
  process.exit(2);
}

function bfs(start, adj, maxDepth = 20) {
  const depths = new Map([[start, 0]]);
  let frontier = [start];
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const n of adj[cur] || []) {
        if (depths.has(n)) continue;
        depths.set(n, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  depths.delete(start);
  return depths;
}

function output(obj, human) {
  if (args.json) console.log(JSON.stringify(obj, null, 2));
  else console.log(human);
}

function groupByModule(paths) {
  const g = {};
  for (const p of paths) (g[files[p].module] ||= []).push(p);
  return g;
}

const L = args.limit;

switch (args.cmd) {
  case 'file': {
    const p = resolvePath(args.arg);
    const f = files[p];
    const imports = outAdj[p].sort();
    const importers = inAdj[p].sort();
    const data = { path: p, module: f.module, loc: f.loc, isTest: f.isTest, exports: f.exports, imports, importedBy: importers,
      isOrphan: snap.findings.orphans.includes(p) };
    output(data, [
      `${p}`,
      `  module: ${f.module}   ${f.loc} LOC   ${f.isTest ? 'test file' : 'product code'}${data.isOrphan ? '   UNREACHABLE from any entry point' : ''}`,
      `  exports (${f.exports.length}): ${f.exports.join(', ') || 'none'}`,
      ``,
      `  imports (${imports.length}):`,
      ...imports.slice(0, L).map((i) => `    -> ${i}`),
      ``,
      `  imported by (${importers.length}):`,
      ...importers.slice(0, L).map((i) => `    <- ${i}`),
      importers.length > L ? `    ...and ${importers.length - L} more` : '',
    ].filter(Boolean).join('\n'));
    break;
  }

  case 'impact': {
    const p = resolvePath(args.arg);
    const depths = bfs(p, inAdj);
    const affected = [...depths.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    const direct = affected.filter(([, d]) => d === 1);
    const entriesHit = [...depths.keys()].filter((x) => snap.entries.includes(x));
    const mods = [...new Set([...depths.keys()].map((x) => files[x].module))].sort();
    output(
      { file: p, totalAffected: affected.length, directImporters: direct.length, modulesAffected: mods, entryPointsAffected: entriesHit },
      [
        `BLAST RADIUS of ${p}`,
        `  ${affected.length} files transitively depend on it, across modules: ${mods.join(', ') || 'none'}`,
        `  ${entriesHit.length} entry points affected${entriesHit.length ? ':' : '.'}`,
        ...entriesHit.slice(0, 15).map((e) => `    ! ${e}`),
        ``,
        `  direct importers (${direct.length}):`,
        ...direct.slice(0, L).map(([x]) => `    <- ${x}`),
        direct.length > L ? `    ...and ${direct.length - L} more` : '',
        ``,
        affected.length > direct.length ? `  indirect (${affected.length - direct.length}):` : '',
        ...affected.filter(([, d]) => d > 1).slice(0, L).map(([x, d]) => `    <- ${x} (depth ${d})`),
      ].filter(Boolean).join('\n')
    );
    break;
  }

  case 'trace': {
    const p = resolvePath(args.arg);
    const depths = bfs(p, outAdj);
    const byMod = groupByModule([...depths.keys()]);
    const externals = new Set();
    for (const [ext, users] of Object.entries(snap.externalUsage || {})) {
      if (users.includes(p) || users.some((u) => depths.has(u))) externals.add(ext);
    }
    output(
      { entry: p, reaches: depths.size, modules: Object.keys(byMod), externalPackages: [...externals] },
      [
        `DOWNSTREAM of ${p}`,
        `  pulls in ${depths.size} files across ${Object.keys(byMod).length} modules`,
        ``,
        ...Object.entries(byMod).sort().flatMap(([m, list]) => [
          `  ${m} (${list.length}):`,
          ...list.sort((a, b) => depths.get(a) - depths.get(b)).slice(0, 12).map((x) => `    ${'  '.repeat(Math.min(depths.get(x) - 1, 4))}-> ${x}`),
          list.length > 12 ? `    ...and ${list.length - 12} more` : '',
        ].filter(Boolean)),
        ``,
        `  external packages on this path (${externals.size}): ${[...externals].sort().join(', ') || 'none'}`,
      ].join('\n')
    );
    break;
  }

  case 'module': {
    const name = snap.modules[args.arg] ? args.arg
      : Object.keys(snap.modules).find((m) => m.includes(args.arg));
    if (!name) { console.error(`No module matching "${args.arg}". Known: ${Object.keys(snap.modules).join(', ')}`); process.exit(2); }
    const m = snap.modules[name];
    const inbound = snap.moduleEdges.filter((e) => e.to === name);
    const outbound = snap.moduleEdges.filter((e) => e.from === name);
    // The public surface is whatever outsiders actually import.
    const surface = [...new Set(snap.edges.filter((e) => files[e.to].module === name && files[e.from].module !== name).map((e) => e.to))].sort();
    output(
      { module: name, ...m, inbound, outbound, publicSurface: surface },
      [
        `MODULE ${name}`,
        `  ${m.fileCount} files, ${m.loc} LOC, ${m.exports} exports, cohesion ${m.cohesion}`,
        ``,
        `  entered from outside via (${surface.length} files):`,
        ...surface.slice(0, L).map((x) => `    * ${x}`),
        ``,
        `  depends on: ${outbound.map((e) => `${e.to} (${e.count})`).join(', ') || 'nothing'}`,
        `  depended on by: ${inbound.map((e) => `${e.from} (${e.count})`).join(', ') || 'nothing'}`,
        ``,
        `  files:`,
        ...m.files.slice(0, L).map((x) => `    ${x} (${files[x].loc} LOC)`),
        m.files.length > L ? `    ...and ${m.files.length - L} more` : '',
      ].filter(Boolean).join('\n')
    );
    break;
  }

  case 'find': {
    const q = args.arg.toLowerCase();
    const pathHits = Object.keys(files).filter((f) => f.toLowerCase().includes(q));
    const exportHits = [];
    for (const [p, f] of Object.entries(files)) {
      for (const e of f.exports) if (e.toLowerCase().includes(q)) exportHits.push({ export: e, path: p });
    }
    output({ query: args.arg, pathHits, exportHits }, [
      `FILES matching "${args.arg}" (${pathHits.length}):`,
      ...pathHits.slice(0, L).map((x) => `  ${x} [${files[x].module}]`),
      ``,
      `EXPORTS matching "${args.arg}" (${exportHits.length}):`,
      ...exportHits.slice(0, L).map((h) => `  ${h.export}  in ${h.path}`),
    ].join('\n'));
    break;
  }

  case 'entries': {
    const groups = {};
    for (const e of snap.entries) {
      const kind = files[e].isTest ? 'test' : /route\.[tj]s/.test(e) ? 'http route'
        : /page\.[tj]sx/.test(e) ? 'page' : /supabase\/functions/.test(e) ? 'edge function' : 'process entry';
      (groups[kind] ||= []).push(e);
    }
    output(groups, Object.entries(groups).map(([k, v]) =>
      `${k.toUpperCase()} (${v.length}):\n` + v.slice(0, L).map((x) => `  ${x}`).join('\n')
    ).join('\n\n'));
    break;
  }

  case 'deps': {
    const list = Object.entries(snap.externalUsage || {})
      .filter(([k]) => !k.startsWith('node:'))
      .sort((a, b) => b[1].length - a[1].length);
    output(Object.fromEntries(list), [
      `EXTERNAL PACKAGES (${list.length}):`,
      ...list.map(([k, v]) => `  ${k}  (${v.length} files)${v.length <= 3 ? ': ' + v.join(', ') : ''}`),
      ``,
      `Declared but unused: ${snap.findings.unusedDeps.join(', ') || 'none'}`,
      `Used but undeclared: ${snap.findings.undeclaredDeps.join(', ') || 'none'}`,
    ].join('\n'));
    break;
  }

  case 'hot': {
    const ranked = Object.keys(files)
      .map((p) => ({ path: p, fanIn: inAdj[p].length, fanOut: outAdj[p].length, loc: files[p].loc, module: files[p].module }))
      .sort((a, b) => b.fanIn - a.fanIn)
      .slice(0, L);
    output(ranked, [
      'HIGHEST FAN-IN (read these first, change them most carefully):',
      ...ranked.map((r) => `  ${String(r.fanIn).padStart(4)} importers  ${r.path}  [${r.module}, ${r.loc} LOC]`),
    ].join('\n'));
    break;
  }

  case 'between': {
    const a = resolvePath(args.arg);
    const b = resolvePath(args.arg2);
    // Reconstruct an actual path, since "yes they are connected" is not actionable.
    const prev = new Map([[a, null]]);
    const queue = [a];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === b) break;
      for (const n of outAdj[cur] || []) if (!prev.has(n)) { prev.set(n, cur); queue.push(n); }
    }
    if (!prev.has(b)) {
      output({ from: a, to: b, connected: false }, `No import path from ${a} to ${b}. They are independent in this direction.`);
      break;
    }
    const chain = [];
    for (let cur = b; cur; cur = prev.get(cur)) chain.unshift(cur);
    output({ from: a, to: b, connected: true, path: chain },
      `IMPORT PATH (${chain.length - 1} hops):\n` + chain.map((c, i) => `  ${'  '.repeat(i)}${i ? '-> ' : ''}${c}`).join('\n'));
    break;
  }

  default:
    console.error(`Usage: query-map.mjs --file|--impact|--trace|--module|--find|--between <arg> | --entries|--deps|--hot`);
    process.exit(2);
}
