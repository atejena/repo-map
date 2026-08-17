/**
 * End to end tests. Each builds a throwaway git repo with deliberately planted
 * defects, runs the real CLI against it, and asserts on the output.
 *
 * These are integration tests on purpose. The failure modes that matter here are
 * things like tsconfig alias resolution and git porcelain parsing, and both of
 * those only break against a real filesystem and a real git.
 *
 * Run: npm test
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'cli.mjs');

let tmp;

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function cli(args, cwd, allowFail = false) {
  try {
    return { out: execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' }), code: 0 };
  } catch (e) {
    if (!allowFail) throw new Error(`CLI failed: ${e.stderr || e.message}`);
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status };
  }
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function commit(root, msg) {
  sh('git', ['add', '-A'], root);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg], root);
}

function snapshot(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.codemap', 'snapshot.json'), 'utf8'));
}

/** A small app with one of every defect the tool claims to detect. */
function makeRepo(name) {
  const root = fs.mkdtempSync(path.join(tmp, name + '-'));
  write(root, 'package.json', JSON.stringify({
    name, main: 'src/server.ts',
    dependencies: { stripe: '^14.0.0', lodash: '^4.0.0', 'never-used': '^1.0.0' },
    devDependencies: { vitest: '^1.0.0' },
  }, null, 2));
  // Comments and a trailing comma: both legal in tsconfig, both break strict JSON.
  write(root, 'tsconfig.json', `{
  // deliberately non-strict JSON
  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] }, }
}`);
  write(root, 'src/server.ts', `import { createProject } from '@/features/projects/service';
import { logger } from './lib/logger';
export function main() { logger.info('up'); return createProject(); }
export default main;`);
  write(root, 'src/lib/logger.ts', `export const logger = { info: (m: string) => console.log(m) };`);
  write(root, 'src/lib/db.ts', `import { logger } from './logger';
export const db = { logger };`);
  write(root, 'src/features/projects/service.ts', `import { db } from '@/lib/db';
import { formatMoney } from '@/utils/money';
import { charge } from '../billing/charge';
export function createProject() { return db && formatMoney(1) && charge(); }`);
  write(root, 'src/features/billing/charge.ts', `import Stripe from 'stripe';
import { createProject } from '../projects/service';
export function charge() { return new Stripe('k') && createProject; }`);
  write(root, 'src/utils/money.ts', `import _ from 'lodash';
export function formatMoney(n: number) { return _.round(n, 2); }`);
  // Planted defects
  write(root, 'src/lib/orphaned.ts', `export function nobodyCallsMe() { return 1; }`);
  write(root, 'src/utils/money-copy.ts', fs.readFileSync(path.join(root, 'src/utils/money.ts'), 'utf8'));
  write(root, '.DS_Store', '');
  write(root, 'debug.log', 'noise');
  sh('git', ['init', '-q'], root);
  commit(root, 'initial');
  return root;
}

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-test-')); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('map', () => {
  let root;
  before(() => { root = makeRepo('map'); cli(['map', '--quiet'], root); });

  test('resolves tsconfig path aliases across slashes', () => {
    const s = snapshot(root);
    // The regression that mattered: "@/lib/db" must resolve, or every aliased
    // import silently vanishes and the whole app looks unreachable.
    assert.ok(s.edges.some((e) => e.from === 'src/server.ts' && e.to === 'src/features/projects/service.ts'));
    assert.ok(s.edges.some((e) => e.to === 'src/lib/db.ts'), 'aliased import to lib/db should resolve');
    assert.equal(s.findings.unresolved.length, 0);
    assert.deepEqual(s.warnings, []);
  });

  test('parses tsconfig with comments and trailing commas', () => {
    assert.equal(snapshot(root).config.tsconfig, 'tsconfig.json');
  });

  test('finds unreachable files but not live ones', () => {
    const { orphans } = snapshot(root).findings;
    assert.ok(orphans.includes('src/lib/orphaned.ts'));
    assert.ok(!orphans.includes('src/lib/db.ts'), 'db.ts is imported, must not be an orphan');
    assert.ok(!orphans.includes('src/utils/money.ts'));
  });

  test('detects cycles, duplicates, junk and unused deps', () => {
    const f = snapshot(root).findings;
    assert.equal(f.cycles.length, 1);
    assert.deepEqual(f.cycles[0].sort(), ['src/features/billing/charge.ts', 'src/features/projects/service.ts']);
    assert.equal(f.identicalFiles.length, 1);
    assert.ok(f.unusedDeps.includes('never-used'));
    assert.ok(!f.unusedDeps.includes('stripe'), 'stripe is imported and must not be flagged');
    const junk = f.junkFiles.map((j) => j.path);
    assert.ok(junk.includes('.DS_Store') && junk.includes('debug.log'));
  });

  test('ignores commented out imports', () => {
    write(root, 'src/lib/logger.ts',
      `// import { gone } from './does-not-exist';\nexport const logger = { info: (m: string) => console.log(m) };`);
    cli(['map', '--quiet'], root);
    assert.equal(snapshot(root).findings.unresolved.length, 0);
  });
});

describe('check', () => {
  let root;
  before(() => {
    root = makeRepo('check');
    cli(['all'], root);
    commit(root, 'add map');
  });

  test('FRESH on a clean tree', () => {
    const r = cli(['check', '--json'], root, true);
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).status, 'FRESH');
  });

  test('DRIFTED names the exact file, uncorrupted', () => {
    fs.appendFileSync(path.join(root, 'src/lib/db.ts'), '\n// edit\n');
    const r = cli(['check', '--json'], root, true);
    assert.equal(r.code, 1);
    const j = JSON.parse(r.out);
    assert.equal(j.status, 'DRIFTED');
    // Regression: git porcelain's leading space was being trimmed, shifting
    // every path by one character ("rc/lib/db.ts").
    assert.deepEqual(j.drifted.map((d) => d.path), ['src/lib/db.ts']);
    assert.equal(j.totalFiles - j.driftedCount, j.totalFiles - 1);
  });

  test('stays FRESH when the map is committed alongside the code it describes', () => {
    // The normal workflow: build the map, then commit map and code together.
    // The snapshot records the previous HEAD, so a naive sha comparison would
    // report every file in that commit as drifted. Content verification must
    // absorb that, or every user sees a false STALE after every commit.
    const r0 = fs.mkdtempSync(path.join(tmp, 'wf-'));
    fs.cpSync(root, r0, { recursive: true });
    write(r0, 'src/newfeature.ts', 'export const feature = 1;');
    write(r0, 'src/server.ts', `import { createProject } from '@/features/projects/service';
import { feature } from './newfeature';
import { logger } from './lib/logger';
export function main() { logger.info('up'); return createProject() && feature; }
export default main;`);
    cli(['all'], r0);
    commit(r0, 'ship feature + refresh map');
    const r = cli(['check', '--json'], r0, true);
    assert.equal(JSON.parse(r.out).status, 'FRESH', 'committing the map with the code must not read as drift');
    assert.equal(r.code, 0);
  });

  test('ignores a change that was reverted back to the mapped content', () => {
    const p = path.join(root, 'src/lib/logger.ts');
    const original = fs.readFileSync(p, 'utf8');
    fs.writeFileSync(p, original + '\n// scratch\n');
    fs.writeFileSync(p, original);
    const j = JSON.parse(cli(['check', '--json'], root, true).out);
    assert.ok(!j.drifted.some((d) => d.path === 'src/lib/logger.ts'),
      'content matching the map is not drift, whatever git says');
  });

  test('STALE when too much has moved', () => {
    for (let i = 0; i < 12; i++) write(root, `src/features/new${i}.ts`, `export const v${i} = ${i};`);
    const r = cli(['check', '--json'], root, true);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).status, 'STALE');
  });

  test('STALE, not a crash, when no map exists', () => {
    const bare = fs.mkdtempSync(path.join(tmp, 'bare-'));
    sh('git', ['init', '-q'], bare);
    const r = cli(['check'], bare, true);
    assert.equal(r.code, 2);
    assert.match(r.out, /No .codemap\/snapshot\.json/);
  });
});

describe('query', () => {
  let root;
  before(() => { root = makeRepo('query'); cli(['map', '--quiet'], root); });

  test('impact reports transitive dependents and affected entry points', () => {
    const j = JSON.parse(cli(['query', '--impact', 'src/lib/db.ts', '--json'], root).out);
    assert.ok(j.totalAffected >= 3);
    assert.ok(j.entryPointsAffected.includes('src/server.ts'));
  });

  test('trace reports downstream reach and external packages', () => {
    const j = JSON.parse(cli(['query', '--trace', 'src/server.ts', '--json'], root).out);
    assert.ok(j.reaches >= 5);
    assert.ok(j.externalPackages.includes('stripe'));
  });

  test('between reconstructs a real import chain', () => {
    const j = JSON.parse(cli(['query', '--between', 'src/server.ts', 'src/utils/money.ts', '--json'], root).out);
    assert.equal(j.connected, true);
    assert.equal(j.path[0], 'src/server.ts');
    assert.equal(j.path.at(-1), 'src/utils/money.ts');
  });

  test('between reports no path rather than inventing one', () => {
    const j = JSON.parse(cli(['query', '--between', 'src/utils/money.ts', 'src/server.ts', '--json'], root).out);
    assert.equal(j.connected, false);
  });

  test('accepts partial paths and rejects unknown ones', () => {
    assert.doesNotThrow(() => cli(['query', '--file', 'money.ts', '--json'], root));
    const r = cli(['query', '--file', 'nope.ts'], root, true);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /Not in the map/);
  });
});

describe('context', () => {
  let root;
  before(() => { root = makeRepo('context'); cli(['all'], root); });

  test('writes a brief that names entry points and landmines', () => {
    const md = fs.readFileSync(path.join(root, 'docs/codemap/CONTEXT.md'), 'utf8');
    assert.match(md, /How the app is entered/);
    assert.match(md, /src\/server\.ts/);
    assert.match(md, /import cycles/);
  });

  test('brief is far smaller than the source it describes', () => {
    const md = fs.readFileSync(path.join(root, 'docs/codemap/CONTEXT.md'), 'utf8');
    const snap = fs.readFileSync(path.join(root, '.codemap/snapshot.json'), 'utf8');
    assert.ok(md.length < snap.length, 'brief must be smaller than the raw snapshot');
  });

  test('preserves hand written team notes across regeneration', () => {
    const p = path.join(root, 'docs/codemap/CONTEXT.md');
    const note = 'Billing retries are idempotent. Do not add a second retry layer.';
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(
      /_No notes yet[^_]*_/, note));
    cli(['context'], root);
    assert.match(fs.readFileSync(p, 'utf8'), new RegExp(note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('respects the token budget', () => {
    cli(['context', '--budget', '400'], root);
    const md = fs.readFileSync(path.join(root, 'docs/codemap/CONTEXT.md'), 'utf8');
    assert.match(md, /codemap:notes/, 'notes block must survive budget trimming');
  });
});

describe('report', () => {
  let root;
  before(() => { root = makeRepo('report'); cli(['all'], root); commit(root, 'baseline map'); });

  test('flags findings introduced by a commit, and gates on them', () => {
    write(root, 'src/features/dead-on-arrival.ts', 'export const unused = 1;');
    cli(['map', '--quiet'], root);
    const r = cli(['report', '--fail-on', 'regression'], root, true);
    assert.equal(r.code, 1, 'new orphan must fail the regression gate');
    const md = fs.readFileSync(path.join(root, 'docs/codemap/MAP.md'), 'utf8');
    assert.match(md, /dead-on-arrival/);
    assert.match(md, /Introduced by this commit/);
  });

  test('passes the gate when a commit introduces nothing new', () => {
    fs.rmSync(path.join(root, 'src/features/dead-on-arrival.ts'));
    cli(['map', '--quiet'], root);
    assert.equal(cli(['report', '--fail-on', 'regression'], root, true).code, 0);
  });
});

describe('cli', () => {
  test('help and version work without a repo', () => {
    assert.match(cli(['--help'], tmp).out, /USAGE/);
    assert.match(cli(['--version'], tmp).out, /\d+\.\d+\.\d+/);
  });

  test('unknown command exits non-zero with guidance', () => {
    const r = cli(['bogus'], tmp, true);
    assert.equal(r.code, 2);
    assert.match(r.out, /Unknown command/);
  });

  test('init scaffolds config without overwriting', () => {
    const root = fs.mkdtempSync(path.join(tmp, 'init-'));
    sh('git', ['init', '-q'], root);
    cli(['init'], root);
    const cfg = path.join(root, '.codemap/config.json');
    assert.ok(fs.existsSync(cfg));
    fs.writeFileSync(cfg, '{"roots":["custom"]}');
    cli(['init'], root);
    assert.match(fs.readFileSync(cfg, 'utf8'), /custom/, 'must not clobber existing config');
  });
});

describe('parser edge cases found by dogfooding', () => {
  let root;
  before(() => {
    root = makeRepo('edge');
    // A file that embeds sample code as data, the way tests and codegen do.
    write(root, 'src/fixtures.ts', [
      'export const sample = `',
      '  import { ghost } from "./does-not-exist";',
      '  export function fake() { return ghost; }',
      '`;',
      'export const real = 1;',
    ].join('\n'));
    write(root, 'test/thing.test.mjs', `import { main } from '../src/server.ts';\nmain();`);
    cli(['map', '--quiet'], root);
  });

  test('does not read imports out of template literals', () => {
    const s = snapshot(root);
    assert.equal(s.findings.unresolved.length, 0,
      'sample code inside a template literal must not register as a real import');
    assert.ok(!s.edges.some((e) => e.to?.includes('does-not-exist')));
  });

  test('still sees real exports in a file containing fixtures', () => {
    assert.ok(snapshot(root).files['src/fixtures.ts'].exports.includes('real'));
  });

  test('treats .mjs test files and test/ directories as tests', () => {
    const f = snapshot(root).files['test/thing.test.mjs'];
    assert.equal(f.isTest, true);
    assert.ok(snapshot(root).entries.includes('test/thing.test.mjs'));
  });
});
