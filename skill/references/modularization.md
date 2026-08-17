# Modularization: proposing boundaries

This skill proposes moves. It does not execute them. Produce a plan the developer
applies themselves, ordered so that each step is independently revertible.

## Contents
- [Read the map before proposing anything](#read-the-map-before-proposing-anything)
- [Finding real seams](#finding-real-seams)
- [Ranking candidates](#ranking-candidates)
- [The proposal format](#the-proposal-format)
- [Moves to refuse](#moves-to-refuse)

## Read the map before proposing anything

Every proposal must cite evidence from `.codemap/snapshot.json`. A boundary
suggestion with no supporting fan-in, cohesion, or cycle data is a guess dressed
up as analysis, and it wastes the developer's time in a way that is hard to
detect until they have already started moving files.

The fields that matter:

| Field | What it tells you |
|---|---|
| `modules[].cohesion` | Share of outbound imports staying inside the module. Below 0.5 means it is not really a module yet. |
| `files[].fanIn` | How many files import this. High fan-in means high blast radius. |
| `findings.cycles` | Import cycles. These block extraction until broken. |
| `moduleEdges[].count` | Weight of each cross-module dependency, with `examples` naming actual files. |
| `findings.orphans` | Delete these before refactoring. Never spend effort modularizing dead code. |

## Finding real seams

A seam is a place where the dependency graph is already nearly cut. Look for:

**Directories with high cohesion and few inbound edges.** These are already
modules in everything but name. Extraction is mostly mechanical: add an
`index.ts` barrel, route all outside imports through it, done.

**Asymmetric edge pairs.** If `a -> b` has weight 14 and `b -> a` has weight 1,
that single reverse edge is usually the accident. Inverting or deleting it turns
a tangle into a clean layer. Name the specific file pair from `examples`.

**Shared leaf utilities.** Files with high fan-in and zero fan-out are natural
`shared/` or `core/` residents. Moving them down the stack removes cross-edges
without touching behavior.

**Type-only edges.** An import used solely for types disappears at runtime.
`import type { X }` edges can often be cut by relocating the type to a shared
declarations module, which lowers coupling at zero runtime risk. This is the
cheapest win available and it is worth checking first.

## Ranking candidates

Score each candidate extraction so the developer knows what to do first:

```
value  = (cross-module edges removed) + (cycles broken x 5)
cost   = (files moved) + (call sites updated) + (hub files touched x 3)
risk   = untested files in scope / total files in scope
```

Lead with high value, low cost, low risk. A proposal that is correct but starts
with the riskiest extraction will not get applied, so ordering is part of the
work rather than a presentation detail.

## The proposal format

Use this structure per candidate:

```markdown
### Candidate N: <short name>

**Evidence**
- Cohesion 0.31 across 9 files (`modules.features.cohesion`)
- 14 outbound edges to `lib`, 1 inbound from `lib` (the accident)
- 2 files in scope have no test coverage

**Proposed boundary**
Move these files: <explicit list with source and destination paths>
Public surface: <exact exports the new module should expose>
Everything else becomes module-private.

**The one reverse edge to cut first**
`src/lib/db.ts` imports `formatMoney` from `src/features/billing`.
Move `formatMoney` to `src/shared/money.ts` and both sides stop crossing.

**Call sites to update** (N files)
<explicit list>

**Verification for this move** (see verification.md)
- Characterization tests needed first for: <untested files in scope>
- Expected import graph delta: cross-module edges 14 -> 3, cycles 1 -> 0
- Behavior delta expected: none

**Order**: apply after Candidate 1, before Candidate 3. Independently revertible.
```

Always state the expected import graph delta as a concrete number. After the
developer applies the move, rerunning the mapper either confirms that number or
reveals the proposal was wrong, which is the whole point of predicting it.

## Moves to refuse

Say no, with the reason, when:

- **Coverage is absent on hub files in scope.** Propose characterization tests as
  a prerequisite step instead of proposing the move. Refactoring untested
  high-fan-in code is how silent breakage ships.
- **The cycle is load-bearing.** Some cycles encode genuine mutual recursion.
  Breaking them mechanically changes initialization order. Flag for human review.
- **The module is churning.** If git shows heavy recent activity, a large move
  will collide with in-flight work. Say so and suggest waiting.
- **It is only aesthetic.** Reorganizing files that have no cycles, healthy
  cohesion, and no cross-boundary pain is churn. The absence of a finding is a
  valid result, and reporting "no extraction is worth it right now" is more
  useful than manufacturing a proposal.
