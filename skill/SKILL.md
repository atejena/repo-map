---
name: repo-map
description: Maintains a committed map of a TypeScript/Node codebase that agents read to understand the app without loading the whole repo into context. Consult this skill at the start of any task in a repo that has a docs/codemap/CONTEXT.md, and whenever the user asks how an app works, what depends on what, what breaks if a file changes, where a feature lives, or how a request flows through the system. Also use it to audit code health, find dead or unused code and dependencies, find junk committed to a repo, review a feature before or after merge, propose splitting or modularizing an app, extract a module, check whether things are properly compartmentalized, or verify a refactor breaks nothing. Covers phrasings like "how does this app work", "what does this codebase do", "what am I going to break", "is this repo clean", "what can we delete", "should we split this up", and "refresh the map" — even when the user does not say map, audit, or modularize.
---

# Repo Map

Maintains a committed, self-describing map of a TypeScript/Node repo. The map
serves two purposes: it is the cheap way for an agent to understand the codebase,
and it is the baseline that makes code health measurable commit over commit.

**Read `docs/codemap/CONTEXT.md` before exploring source in a mapped repo.** It is
a reference point, not a rule. It is a compressed, possibly slightly stale
description of the code, and the code is the truth. When the two disagree, the
code wins and the map needs rebuilding.

**This skill proposes refactors. It never applies them.** Do not move files,
rewrite imports, or delete anything. Output a plan the developer executes. The one
exception is generating characterization tests when asked, since those add
coverage without changing behavior.

## The artifacts

| Path | Committed | Purpose |
|---|---|---|
| `docs/codemap/CONTEXT.md` | **yes** | The orientation brief. Budget capped, so cost stays flat as the repo grows. |
| `.codemap/snapshot.json` | **yes** | Full graph. Backs the queries. Too large to read directly. |
| `docs/codemap/MAP.md` | yes | Audit findings and commit-over-commit delta. |
| `docs/codemap/map.mmd` | yes | Mermaid module graph with new/changed/removed marked. |
| `.codemap/report.json` | no | Machine readable, for CI gating. |

Both `CONTEXT.md` and `snapshot.json` must be committed with the code they
describe. That is the entire mechanism by which the next session inherits this
work, so a run that ends without refreshing them has produced nothing durable.

## Mode 1: Orient (the default)

At the start of a task in a mapped repo:

```bash
npx repo-map check
```

Three outcomes, and the middle one matters most:

| Result | Exit | What to do |
|---|---|---|
| **FRESH** | 0 | Read `CONTEXT.md`. Trust it for structure. Query for specifics. |
| **DRIFTED** | 1 | Trust the map for every file it does *not* name. Read the named files from disk. |
| **STALE** | 2 | Rebuild if you can. Otherwise read source directly for the areas you touch and say the map was unavailable. |

DRIFTED is the common case and the reason this is worth doing. Six changed files
out of four hundred does not invalidate the map; it invalidates six entries. Read
those six, trust the rest. Treating any drift as total staleness throws away a
good map and pushes you back to reading everything, which defeats the purpose.

### Query instead of reading

Once oriented, answer structural questions from the graph. These cost a few
hundred tokens each, versus opening a dozen files to reconstruct the same answer
less reliably:

```bash
npx repo-map query --impact src/lib/db.ts      # what breaks if I change this
npx repo-map query --trace src/app/api/x/route.ts  # what this request pulls in
npx repo-map query --file src/features/billing/charge.ts
npx repo-map query --module features            # contents, public surface, boundaries
npx repo-map query --find billing               # locate files or exports by name
npx repo-map query --between a.ts b.ts          # actual import chain
npx repo-map query --entries | --deps | --hot
```

Run `--impact` before editing any file you did not write. It names the entry
points affected, which is the question that actually matters and the one hardest
to answer by reading.

### What the map cannot tell you

Structure, not behavior. The graph knows that `charge.ts` imports `db.ts`; it has
no idea whether the retry logic is correct. Read source for logic, always. Also
invisible to it: anything resolved dynamically or by string name (DI containers,
computed `import()`, string-keyed route tables), and the reasons behind decisions.
The team notes block in `CONTEXT.md` exists for that last category.

When the map does not cover what you need, read the source. Falling back is the
designed behavior, not a failure. Silently guessing from a stale map is the
failure.

## Mode 2: Refresh (end of every run)

After making changes, leave the map correct for whoever comes next:

```bash
npx repo-map map
npx repo-map report
npx repo-map context
git add .codemap/snapshot.json docs/codemap/
```

Do this whenever files were added, deleted, moved, or their imports changed.
Content-only edits inside existing files rarely shift the graph, so a rebuild is
optional there. When in doubt, rebuild: it takes seconds and a stale map costs the
next session far more than the rebuild costs this one.

Mention the refresh in your summary so the developer knows the map moved and does
not mistake the changed files for stray edits.

Hand-written content between `<!-- codemap:notes -->` and `<!-- /codemap:notes -->`
in `CONTEXT.md` survives regeneration. Put anything there that the graph cannot
show and that the next session would benefit from: business rules, deploy quirks,
why something is the way it is. Adding to that block is often the highest-value
thing a run leaves behind.

## Mode 3: Audit

`MAP.md` holds the findings. Add judgment rather than restating the table:

1. **Blocking** — unresolved imports, new orphans, junk or secrets committed
2. **Worth doing now** — dead files, unused deps, duplicate files, cycles
3. **Worth knowing** — oversized files, low cohesion, hub files with weak coverage

| Finding | Reading |
|---|---|
| `orphans` | Unreachable from any entry point. Deletion candidates *if* the entry list is right. |
| `testOnly` | Product code only tests reach. Usually a backed-out feature that left tests behind. |
| `cycles` | Blocks extraction, makes load order fragile. |
| `unusedDeps` | Declared, never imported. Install weight and audit surface for nothing. |
| `undeclaredDeps` | Imported, not declared. Works locally, breaks on clean install. |
| `unresolved` | Broken path, or a config problem invalidating the whole run. |
| `junkFiles` | `.DS_Store`, logs, `.env`, committed build output, archives. |
| `identicalFiles` | Byte-identical duplicates. |

Entry points drive reachability, and reachability drives orphan detection, so a
missing entry point makes live code look dead. Read the detected `entries` list
back to the user before presenting anything as a deletion candidate. Call orphans
"unreachable from the entry points I detected" rather than "dead code" — the
distinction matters when someone acts on it.

Add anything invoked dynamically to `.codemap/config.json`:

```jsonc
{
  "roots": ["src", "supabase/functions"],   // defaults are guessed; override when wrong
  "entries": ["src/worker.ts"],             // schedulers, dynamic imports, anything invoked by name
  "ignore": ["**/*.stories.tsx"],
  "moduleDepth": 1                          // 2 for src/features/billing rather than src/features
}
```

If a committed `.env` shows up, flag it separately and immediately: that needs
credential rotation, not just a `git rm`, because deleting the file leaves the
secrets in git history.

Check `warnings` in the snapshot before trusting any finding. If a meaningful
share of imports failed to resolve, the mapper misread the project and the orphan
list in particular will be fiction.

## Mode 4: Propose modularization

Read `references/modularization.md` first. It has the seam-finding method, the
ranking formula, the required proposal format, and the cases where refusing is the
right answer.

Every proposal cites snapshot evidence, names the exact files to move, and
predicts the resulting graph delta as a number. The prediction is what makes the
proposal falsifiable when the mapper reruns.

## Mode 5: Verify a refactor

Read `references/verification.md`. Four layers, cheapest first:

1. `tsc --noEmit` and the existing suite, **baselined before any moves**
2. Characterization tests for untested files in the move scope
3. Import graph diffing against the prediction
4. Runtime tracing, only when the scope contains dynamic resolution

Baseline first, or a pre-existing failure reads as a regression. A **new orphan
after a refactor** is the highest-signal failure available: it means a call site
was deleted rather than repointed, and both typecheck and tests can stay green
while it happens.

## Setup in a new repo

```bash
mkdir -p scripts && cp <skill>/scripts/*.mjs scripts/
npx repo-map all
```

Check the detected entry points and roots, correct them in `.codemap/config.json`,
rebuild, then commit. Optionally add `assets/codemap.yml` as a CI workflow, which
gates on findings *introduced* by a PR rather than the inherited backlog, and
`assets/dependency-cruiser.cjs` to enforce boundaries once they exist.

Point the repo's `CLAUDE.md` or `AGENTS.md` at the brief so future sessions find
it without being told:

```markdown
## Codebase map
Before exploring source, run `npx repo-map check` and read
`docs/codemap/CONTEXT.md`. Query structure with `npx repo-map query`.
Refresh the map before finishing: `npx repo-map all`.
```

## Scope and honesty

TypeScript and JavaScript only: `.ts .tsx .js .jsx .mjs .cjs`. Handles tsconfig
path aliases, monorepo roots, Next.js app and pages routing, and Supabase edge
functions.

The scripts parse with regex at file granularity, no dependencies, so they run on
a cold repo with no install. The cost of that:

- Unused *exports* inside a used file are **not** detected. That needs `knip`.
- Only byte-identical duplicates are found, not near-duplicates. That needs `jscpd`.
- Module roles in `CONTEXT.md` are inferred from names and are hints, not facts.
- Dynamic and string-based resolution is invisible.

See `references/tooling.md` for layering those in. Never present a heuristic
finding with the confidence of a type-checked one, and when a limitation bears on
the question being asked, say so rather than letting silence imply coverage that
is not there.

## Files

```
scripts/build-map.mjs        Zero-dependency mapper, writes .codemap/snapshot.json
scripts/write-context.mjs    Derives the budgeted CONTEXT.md brief, preserves team notes
scripts/check-freshness.mjs  FRESH / DRIFTED / STALE with the exact drifted file list
scripts/query-map.mjs        Targeted graph queries
scripts/report-map.mjs       Diff vs previous snapshot, writes MAP.md + Mermaid
references/modularization.md Seam finding, ranking, proposal format, when to refuse
references/verification.md   The four verification layers and the report format
references/tooling.md        knip, dependency-cruiser, jscpd integration
assets/dependency-cruiser.cjs Boundary enforcement template
assets/codemap.yml           GitHub Actions workflow
```

`write-context.mjs --budget <n>` sets the token ceiling for the brief, default
24000. `check-freshness.mjs --threshold <0-1>` sets the drift ratio above which
the map is called stale, default 0.15. Both take `--json`.
