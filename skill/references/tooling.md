# Optional tooling

The bundled scripts need nothing but Node, deliberately, so the skill works on a
cold repo with no install step. These tools go deeper where it matters. Suggest
them; do not install them without asking, since adding a devDependency to someone's
repo is exactly the kind of unrequested change this skill is meant to prevent.

## What the core scripts do not do

| Gap | Tool | Why it needs a real parser |
|---|---|---|
| Unused *exports* within a used file | `knip` | Needs symbol-level resolution, not file-level |
| Near-duplicate code blocks | `jscpd` | Token-level similarity, not file hashing |
| Enforcing boundaries in CI | `dependency-cruiser` | Declarative rules with good error messages |
| Type-aware dead code | `ts-morph` / `tsc` API | Needs the type checker |

The core scripts detect unused *files* and unused *packages*. They do not detect
an exported function that nobody imports inside a file that is otherwise used.
That is `knip`'s job and it is the single highest-value addition.

## knip

```bash
npx knip --reporter json > /tmp/knip.json
```

Config in `knip.json`:

```json
{
  "entry": ["src/server.ts", "src/app/**/{page,layout,route}.tsx", "supabase/functions/*/index.ts"],
  "project": ["src/**/*.{ts,tsx}"],
  "ignoreDependencies": []
}
```

Reports unused files, unused exports, unused exported types, unused dependencies,
and unlisted dependencies. Cross-check its unused-files list against
`findings.orphans` from the snapshot: agreement is strong signal, disagreement
usually means an entry point is missing from one of the two configs, and
resolving that disagreement is more informative than either tool alone.

## dependency-cruiser

The right tool for making a proposed boundary *stick* after the developer applies
it. Rules fail the build when someone crosses a line that was deliberately drawn.

```bash
npx depcruise --config .dependency-cruiser.cjs src
```

See `assets/dependency-cruiser.cjs` for a starting config with layer rules,
no-circular, and no-orphans already wired up.

Propose these rules only after a boundary has actually been established. Adding
enforcement to a boundary nobody has cleaned up yet just produces a permanently
red build that the team learns to ignore.

## jscpd

```bash
npx jscpd src --reporters json --silent --min-lines 8 --min-tokens 60
```

Finds copy-paste that file hashing misses. Tune `--min-lines` up if it floods:
short matches in generated code and test fixtures are noise, and a duplication
report nobody reads has negative value.

## Merging results into the report

If any of these ran, fold their findings into the `## Excess and dead weight`
section of `MAP.md` under a clear subheading naming the tool, so the developer
can tell which findings came from full parsing and which came from the cheap
built-in heuristics. Never present a heuristic finding with the same confidence
as a type-checked one.
