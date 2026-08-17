# Contributing

Thanks for taking a look.

## Setup

No dependencies to install. Node 18 or newer.

```bash
git clone <your fork>
cd repo-map
npm test
```

## Before opening a PR

1. **`npm test` passes.** The suite builds throwaway git repos with deliberately
   planted defects and asserts on real CLI output. They are integration tests on
   purpose: the failure modes that matter here (tsconfig alias resolution, git
   porcelain parsing, template literal handling) only break against a real
   filesystem and a real git.
2. **Add a regression test for any bug you fix.** Both parser bugs found while
   dogfooding have one, under `parser edge cases found by dogfooding`.
3. **Run `npm run selfmap`** and commit the result if you changed anything
   structural. CI fails if the committed map does not match a fresh run.

## Design constraints

These are deliberate. Please raise an issue before working around them.

- **Zero runtime dependencies.** The tool must run on a cold repo with no
  install step. That is what makes it usable as the first thing an agent runs.
- **Never modify the user's code.** It proposes, it does not apply. The only
  exception is generating characterization tests, and only when asked.
- **Be honest about confidence.** A heuristic finding must never be presented
  with the confidence of a type-checked one. If a limitation bears on the
  question being asked, the output says so rather than letting silence imply
  coverage that is not there.

## Adding a language

Extend `SOURCE_EXT`, `RESOLVE_EXT`, `IMPORT_PATTERNS`, `EXPORT_*` and
`ENTRY_PATTERNS` in `src/build-map.mjs`. Everything downstream of the graph
(reachability, cycles, cohesion, diffing, queries) is language-agnostic and
should not need changes.

Please include a fixture repo in the test suite covering that language's import
syntax and at least one entry point convention.
