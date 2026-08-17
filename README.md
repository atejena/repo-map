# repo-map

**Your AI coding agent reads 40 files to answer "what breaks if I change this?" This answers it from a committed map, in about 130 tokens.**

Zero dependencies. One command. Works on any TypeScript or JavaScript repo.

```bash
npx repo-map all
```

---

## TL;DR

`repo-map` builds a map of your codebase and commits it. Two things come out of that:

**1. Agents stop re-reading your repo.** It writes `docs/codemap/CONTEXT.md` — a token-budgeted brief covering entry points, modules, what depends on what, and known landmines. An agent reads that one file instead of grepping through your source. The brief is capped in size, so the cost of orienting stays flat as your repo grows.

**2. Junk stops reaching your main branch.** Because the map is committed, every run diffs against the last one. It tells you what *this commit* introduced: dead files, unused dependencies, new import cycles, `.DS_Store`, a stray `.env`. CI can fail on new problems while ignoring the backlog you inherited.

### The three commands you'll actually use

```bash
npx repo-map check                        # Can I trust the map right now?
npx repo-map query --impact src/lib/db.ts # What breaks if I change this?
npx repo-map all                          # Refresh the map before committing
```

### What `--impact` gives you

```
BLAST RADIUS of src/lib/db.ts
  6 files transitively depend on it, across modules: app, features, (root)
  3 entry points affected:
    ! src/app/api/webhook/route.ts
    ! src/server.ts
    ! src/features/billing/charge.test.ts
  direct importers (3):
    <- src/features/billing/charge.ts
    <- src/features/notifications/send.ts
    <- src/features/projects/service.ts
```

Reconstructing that by hand means grepping, opening files, and following imports. This is one command and it doesn't miss edges.

### Getting started

```bash
cd your-repo
npx repo-map init      # optional: scaffold config
npx repo-map all       # build the map
```

Then **check the detected entry points in `docs/codemap/CONTEXT.md`.** Entry points determine what counts as reachable, so a missing one makes live code look dead. If anything is invoked dynamically — a scheduler, a string-routed handler — add it to `.codemap/config.json` and rerun.

Finally, commit the map so the next run has something to compare against:

```bash
git add .codemap/snapshot.json docs/codemap/
```

That's the whole workflow. **Everything below is detail you can read when you need it.**

---
---

## Table of contents

- [Why this exists](#why-this-exists)
- [What it actually detects](#what-it-actually-detects)
- [The artifacts](#the-artifacts)
- [Freshness: the part most tools get wrong](#freshness-the-part-most-tools-get-wrong)
- [Query reference](#query-reference)
- [Configuration](#configuration)
- [Using it with Claude Code and other agents](#using-it-with-claude-code-and-other-agents)
- [CI integration](#ci-integration)
- [When the map is wrong](#when-the-map-is-wrong)
- [Limitations, stated plainly](#limitations-stated-plainly)
- [How it compares](#how-it-compares)
- [Contributing](#contributing)
- [License](#license)

## Why this exists

Two problems, one underlying artifact.

**Agents burn context rediscovering your codebase.** Every session starts from zero. The agent greps, opens files, follows imports, builds a mental model, then the session ends and all of it evaporates. Next session, same thing. The expensive part isn't the work, it's the orientation, and it's paid over and over.

**Code health degrades invisibly.** A feature ships. It leaves behind a helper nothing imports, a dependency nobody removed from `package.json`, an import cycle that makes load order fragile. Each one is individually trivial. None of them show up in code review, because review looks at the diff, not at what the repo now looks like as a whole.

Both are solved by the same thing: a map of the codebase that lives in version control. Agents read it instead of rediscovering. CI diffs it to catch what a commit introduced.

## What it actually detects

| Finding | What it means |
|---|---|
| `orphans` | Unreachable from any entry point. Deletion candidates — **if** your entry point list is right. |
| `testOnly` | Product code only tests reach. Usually a backed-out feature that left its tests behind. |
| `cycles` | Import cycles, via Tarjan's algorithm. Blocks module extraction, makes load order fragile. |
| `unusedDeps` | Declared in `package.json`, never imported. Install weight and audit surface for nothing. |
| `undeclaredDeps` | Imported but not declared. Works on your machine, breaks on a clean install. |
| `unresolved` | Broken import paths — or a config problem invalidating the whole run. |
| `junkFiles` | `.DS_Store`, logs, `.env`, committed build output, archives, merge artifacts. |
| `identicalFiles` | Byte-identical duplicates. Editing one won't change the other. |
| `godFiles` | Oversized, measured against your repo's own p90 rather than a fixed number. |
| `hubFiles` | High fan-in. Widest blast radius when changed, so they need the best test coverage. |
| Low cohesion | Modules whose imports mostly point outward, meaning the boundary isn't real yet. |

Cohesion is the share of a module's outbound imports that stay inside the module. It's the number to look at before trying to extract something.

## The artifacts

| Path | Commit it? | What it's for |
|---|---|---|
| `docs/codemap/CONTEXT.md` | **Yes** | The agent brief. Token-budgeted. Read this first. |
| `.codemap/snapshot.json` | **Yes** | Full graph. Backs the queries. Too big to read directly. |
| `docs/codemap/MAP.md` | Yes | Audit findings and commit-over-commit delta. |
| `docs/codemap/map.mmd` | Yes | Mermaid module graph, new/changed/removed marked. |
| `.codemap/report.json` | No | Machine readable, for CI. |

**`snapshot.json` and `CONTEXT.md` must be committed.** That's the entire mechanism. Without them in git history there's no previous state to diff against, and every run degrades into a baseline that reports everything as new.

The Mermaid graph renders natively on GitHub. Green is new in this commit, yellow modified, dashed red deleted, thick arrows are dependency edges that didn't exist before.

### The team notes block

`CONTEXT.md` has a block that survives regeneration:

```markdown
<!-- codemap:notes -->
Billing retries are idempotent via the Stripe key. Do not add a second retry layer.
<!-- /codemap:notes -->
```

Put anything here that a dependency graph can't show: business rules, deploy quirks, why a weird thing is the way it is. It's often the highest-value part of the file, and rebuilding the map won't clobber it.

## Freshness: the part most tools get wrong

A map is only useful if you know how much of it to trust. Most tools give you a binary: fresh, or stale. That's the wrong shape. Six changed files out of four hundred doesn't invalidate the map — it invalidates six entries.

`repo-map check` returns three states:

| State | Exit | Meaning |
|---|---|---|
| `FRESH` | 0 | Map matches the working tree. Trust it. |
| `DRIFTED` | 1 | Map valid **except** for the files it names. Read those; trust the rest. |
| `STALE` | 2 | Too much moved. Rebuild, or read source directly. |

```
MAP FRESHNESS: DRIFTED
1 of 12 source files changed since f3c9f54. The map is still accurate for the other 11.

Files changed since the map was built (1). Read these from disk;
the map remains accurate for everything else.
  uncommitted  src/lib/db.ts

These are edits to files the map already knows about, so module structure is very
likely unchanged. Read them only if your task touches them.
```

`DRIFTED` is the common case and the reason this is worth doing. Treating any drift as total staleness throws away a good map and pushes the agent back to reading everything.

Drift is measured from git, so it's fast regardless of repo size. It also detects when the map came from a different or rebased branch, where a diff would be meaningless.

## Query reference

```bash
repo-map query --impact <file>      # transitive dependents + entry points affected
repo-map query --trace <file>       # everything this pulls in downstream
repo-map query --file <file>        # imports, importers, exports, module
repo-map query --module <name>      # contents, public surface, boundaries
repo-map query --find <substring>   # locate files or exports by name
repo-map query --between <a> <b>    # the actual import chain, if one exists
repo-map query --entries            # entry points grouped by kind
repo-map query --deps               # external packages and where they're used
repo-map query --hot                # highest fan-in files
```

All accept partial paths (`money.ts` instead of the full path) and `--json`.

`--between` reconstructs the actual chain rather than answering yes/no:

```
IMPORT PATH (2 hops):
  src/server.ts
    -> src/features/projects/service.ts
      -> src/utils/money.ts
```

## Configuration

`.codemap/config.json`, all keys optional:

```jsonc
{
  "roots": ["src", "supabase/functions"],  // scan roots; defaults are guessed
  "entries": ["src/worker.ts"],            // anything invoked dynamically
  "ignore": ["**/*.stories.tsx"],
  "moduleDepth": 1                         // 2 groups by src/features/billing not src/features
}
```

**`entries` is the one that matters.** Entry points drive reachability, reachability drives orphan detection, and a missing entry point makes live code look dead. Auto-detection handles Next.js app and pages routing, Supabase edge functions, `package.json` main/bin/exports, `middleware.*`, config files, and test files. It cannot detect something a scheduler invokes by name.

If no entry points are found, or if a majority of files come back orphaned, the tool warns loudly rather than presenting the result as fact.

## Using it with Claude Code and other agents

The `skill/` directory is a [Claude Code skill](https://docs.claude.com). Copy it into `.claude/skills/` and Claude will use the map automatically: checking freshness before exploring, querying instead of reading files, refreshing the map before finishing.

For any other agent, add this to your `CLAUDE.md` / `AGENTS.md` / `.cursorrules`:

```markdown
## Codebase map
Before exploring source, run `npx repo-map check` and read `docs/codemap/CONTEXT.md`.
Query structure with `npx repo-map query --impact <file>` instead of opening files.
Refresh before finishing: `npx repo-map all`, then commit `.codemap/` and `docs/codemap/`.
```

The skill also covers two workflows beyond mapping:

- **Modularization proposals** (`skill/references/modularization.md`) — finding real seams in the dependency graph, ranking extractions by value against cost and risk, and the cases where the right answer is "don't." Proposals only; it never moves your files.
- **Refactor verification** (`skill/references/verification.md`) — four layers, cheapest first: typecheck and existing tests baselined *before* any moves, characterization tests for untested paths, import graph diffing against a prediction, and runtime tracing when dynamic resolution is involved.

On that third layer: **a new orphan appearing after a refactor is the highest-signal failure available.** It means a call site was deleted rather than repointed. Both typecheck and tests can stay green while it happens.

## CI integration

`skill/assets/codemap.yml` is a GitHub Actions workflow. The key behavior:

```bash
npx repo-map report --fail-on regression
```

This fails on findings **introduced by this PR**, not on the total backlog. An inherited mess never blocks unrelated work, which is what makes the gate survivable on a real codebase. Use `--fail-on any` only on a repo you've already cleaned.

The workflow also fails if `snapshot.json` is stale, so the map can't silently rot.

`skill/assets/dependency-cruiser.cjs` is a starting config for enforcing boundaries once they exist. Adopt rules at `warn`, clear the violations, then promote to `error` — landing them all as errors at once produces a permanently red build that people learn to ignore.

## When the map is wrong

**Everything shows as an orphan.** No entry points detected. Almost always config, not dead code. Check `roots` and `entries`.

**A file you know is used shows as unreachable.** It's probably reached dynamically. Add it to `entries`.

**High unresolved count.** Path aliases aren't resolving. Check that `tsconfig.json` has `baseUrl` and `paths`, and that `roots` covers where those aliases point. The tool warns when more than 10% of internal imports fail to resolve, because at that point every downstream finding is unreliable.

**Findings that don't match reality after a refactor.** Rebuild. `npx repo-map all`.

This repo dogfoods the awkward case, by the way: the CLI spawns each `src/` script as a subprocess rather than importing it, so static analysis sees no edges to them. Look at [`.codemap/config.json`](.codemap/config.json) for how that's declared.

## Limitations, stated plainly

Regex parsing at file granularity, zero dependencies. That combination is what lets it run on a cold repo with no install step, and it has real costs:

- **Unused *exports* inside a used file are not detected.** Only unused *files* and *packages*. For symbol-level analysis use [`knip`](https://github.com/webpro-nl/knip), which is excellent and complementary.
- **Only byte-identical duplicates are found**, not near-duplicates. Use [`jscpd`](https://github.com/kucherenko/jscpd) for that.
- **Module roles in `CONTEXT.md` are inferred from names.** They're hints, labelled as such.
- **Dynamic and string-based resolution is invisible.** DI containers, computed `import()`, string-keyed route tables. This is a property of static analysis, not a bug.
- **Structure, not behavior.** The graph knows `charge.ts` imports `db.ts`. It has no idea whether your retry logic is correct.
- **An import statement written inside a plain string literal is read as real.** Code samples in template literals are handled, but specifiers live in quotes, so ordinary strings can't be blanked without breaking all resolution. This shows up in test fixtures and codegen; add those files to `ignore` if it bothers you.

`skill/references/tooling.md` covers layering the heavier tools in. Never present a heuristic finding with the confidence of a type-checked one.

**Supported:** `.ts .tsx .js .jsx .mjs .cjs`. Handles tsconfig path aliases, monorepo roots, Next.js app and pages routing, Supabase edge functions.

## How it compares

- **[knip](https://github.com/webpro-nl/knip)** — deeper dead-code analysis via full parsing, finds unused exports. Better at that specific job. Doesn't produce an agent-readable brief or track changes commit over commit. Use both.
- **[dependency-cruiser](https://github.com/sverweij/dependency-cruiser)** — the best boundary *enforcement* tool. Complementary: this finds where the seams are, that enforces them once you've drawn them.
- **[madge](https://github.com/pahen/madge)** — dependency graphs and cycle detection with visual output. No health findings, no diffing, no agent brief.
- **[codebase-cartographer](https://github.com/patrickcardosomoraes/codebase-cartographer)** — closest in intent: a living `MAP.md` for AI agents, with its own staleness handling. Worth evaluating alongside this one.

What's distinctive here: the graph query interface, partial-trust freshness, and diffing against a committed baseline so you can gate on what a commit *introduced*.

## Contributing

Issues and PRs welcome. Please:

1. `npm test` before opening a PR. The suite builds throwaway git repos with planted defects and asserts on real output — integration tests, because the failure modes that matter (tsconfig alias resolution, git porcelain parsing) only break against a real filesystem.
2. Add a regression test for any bug you fix. Both parser bugs found while dogfooding have one.
3. Run `npm run selfmap` and commit the result if you changed anything structural.

Adding language support means extending `SOURCE_EXT`, `IMPORT_PATTERNS`, and `ENTRY_PATTERNS` in `src/build-map.mjs`. The graph logic downstream is language-agnostic.

## License

MIT. See [LICENSE](LICENSE).
