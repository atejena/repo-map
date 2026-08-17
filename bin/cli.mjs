#!/usr/bin/env node
/**
 * repo-map CLI
 *
 * Thin dispatcher over the src/ scripts. Each subcommand runs in its own
 * process so a crash in one stage cannot corrupt another, and so the scripts
 * stay independently runnable for anyone who prefers to vendor them.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

const COMMANDS = {
  map: { script: 'build-map.mjs', blurb: 'Scan the repo and write .codemap/snapshot.json' },
  report: { script: 'report-map.mjs', blurb: 'Diff against the last snapshot, write docs/codemap/MAP.md' },
  context: { script: 'write-context.mjs', blurb: 'Write the budgeted agent brief, docs/codemap/CONTEXT.md' },
  check: { script: 'check-freshness.mjs', blurb: 'Report FRESH / DRIFTED / STALE against the working tree' },
  query: { script: 'query-map.mjs', blurb: 'Ask the graph a targeted question' },
};

const HELP = `
repo-map ${pkg.version}
${pkg.description}

USAGE
  npx repo-map <command> [options]

COMMANDS
  all          ${'Run map, report and context in sequence (the usual command)'}
${Object.entries(COMMANDS).map(([k, v]) => `  ${k.padEnd(12)} ${v.blurb}`).join('\n')}
  init         Scaffold .codemap/config.json and print next steps

COMMON OPTIONS
  --repo <path>     Target repository (default: cwd)
  --json            Machine readable output where supported
  -h, --help        This text
  -v, --version     Print version

QUERY EXAMPLES
  npx repo-map query --impact src/lib/db.ts     What breaks if I change this
  npx repo-map query --trace src/server.ts      What this entry point pulls in
  npx repo-map query --module features          Contents and public surface
  npx repo-map query --find billing             Locate files or exports
  npx repo-map query --between a.ts b.ts        Actual import chain
  npx repo-map query --entries | --deps | --hot

TYPICAL LOOP
  npx repo-map check          # before you start: can I trust the map?
  npx repo-map query --impact <file>
  ...make changes...
  npx repo-map all            # before you commit: refresh the map
  git add .codemap docs/codemap

Docs: ${pkg.homepage || 'https://github.com/OWNER/repo-map'}
`;

function run(script, argv) {
  const r = spawnSync(process.execPath, [path.join(src, script), ...argv], { stdio: 'inherit' });
  if (r.error) { console.error(r.error.message); process.exit(1); }
  return r.status ?? 1;
}

function repoFrom(argv) {
  const i = argv.indexOf('--repo');
  return i !== -1 && argv[i + 1] ? path.resolve(argv[i + 1]) : process.cwd();
}

function init(argv) {
  const repo = repoFrom(argv);
  const dir = path.join(repo, '.codemap');
  const cfg = path.join(dir, 'config.json');
  if (fs.existsSync(cfg)) {
    console.log(`${path.relative(repo, cfg)} already exists, leaving it alone.`);
  } else {
    fs.mkdirSync(dir, { recursive: true });
    // Guessing roots here would bake a wrong assumption into a file people rarely
    // revisit. Ship the keys commented out with guidance instead.
    fs.writeFileSync(cfg, JSON.stringify({
      _README: 'Delete keys you do not need. Entry points drive dead-code detection, so add anything invoked dynamically.',
      roots: [],
      entries: [],
      ignore: [],
      moduleDepth: 1,
    }, null, 2) + '\n');
    console.log(`Wrote ${path.relative(repo, cfg)}`);
  }
  console.log(`
Next:
  1. npx repo-map all
  2. Open docs/codemap/CONTEXT.md and check the detected entry points.
     Anything invoked dynamically (schedulers, string-routed handlers) will be
     missing. Add those to "entries" in .codemap/config.json and rerun, or live
     code will be reported as dead.
  3. Commit .codemap/snapshot.json and docs/codemap/ so the next run can diff.
`);
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { console.log(HELP.trim()); process.exit(0); }
if (cmd === '-v' || cmd === '--version') { console.log(pkg.version); process.exit(0); }

if (cmd === 'init') process.exit(init(rest));

if (cmd === 'all') {
  for (const step of ['build-map.mjs', 'report-map.mjs', 'write-context.mjs']) {
    const code = run(step, rest.filter((a, i, arr) => !['--fail-on'].includes(arr[i - 1]) && a !== '--fail-on'));
    // report-map exits non-zero by design under --fail-on; only stop on a real error.
    if (code !== 0 && step !== 'report-map.mjs') process.exit(code);
  }
  process.exit(0);
}

if (!COMMANDS[cmd]) {
  console.error(`Unknown command "${cmd}".\n`);
  console.error(HELP.trim());
  process.exit(2);
}

process.exit(run(COMMANDS[cmd].script, rest));
