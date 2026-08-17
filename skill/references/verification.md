# Verification: proving a refactor changed nothing

Four layers, cheapest first. Run them in order and stop at the first failure,
because a later layer's output is meaningless once an earlier one is red.

## Contents
- [Layer 1: typecheck and existing tests](#layer-1-typecheck-and-existing-tests)
- [Layer 2: characterization tests for untested paths](#layer-2-characterization-tests-for-untested-paths)
- [Layer 3: import graph diffing](#layer-3-import-graph-diffing)
- [Layer 4: runtime tracing](#layer-4-runtime-tracing)
- [The verification report](#the-verification-report)

## Layer 1: typecheck and existing tests

```bash
npx tsc --noEmit
npm test -- --run
```

Capture the baseline **before** any moves. A test that was already failing is not
a regression, and treating it as one sends the developer chasing a ghost.

```bash
npx tsc --noEmit 2>&1 | tee /tmp/tsc-before.txt
npm test -- --run --reporter=json > /tmp/tests-before.json 2>&1 || true
```

For TypeScript specifically, `tsc --noEmit` catches the overwhelming majority of
move-induced breakage: bad paths, missing exports, circular type references. Run
it after every individual move rather than at the end, so a failure points at one
move instead of ten.

Two gaps typecheck will not catch, which is why the later layers exist:

- Dynamic `import()` with a computed specifier
- Anything reached by string name: DI containers, route tables, `require` by
  variable, framework file-convention routing

Grep for these in the move scope and list them as manual check items.

## Layer 2: characterization tests for untested paths

A characterization test does not assert correct behavior. It asserts *current*
behavior, whatever that is, so that a refactor which changes it gets caught. Bugs
get pinned in place deliberately, which is correct: the refactor should not fix
them silently.

Generate these only for files in the move scope that have no existing coverage.

Determine what is uncovered:

```bash
npx vitest run --coverage --coverage.reporter=json-summary
# then read coverage/coverage-summary.json and intersect with the move scope
```

Write them like this:

```ts
// characterization.billing.test.ts
// Generated to pin current behavior before extracting the billing module.
// These assert what the code DOES, not what it SHOULD do. Do not "fix" a
// failing expectation here without deciding the behavior change is intended.
import { chargeCustomer } from '@/features/billing/charge';

describe('chargeCustomer [characterization]', () => {
  it('returns the current shape for a standard input', () => {
    expect(chargeCustomer({ amount: 100, currency: 'usd' }))
      .toMatchInlineSnapshot();  // fill by running once, then commit
  });

  it('preserves current behavior on zero amount', () => {
    expect(() => chargeCustomer({ amount: 0 })).toThrowErrorMatchingInlineSnapshot();
  });
});
```

Cover, in priority order: the happy path, each early return, each thrown error,
and boundary inputs (empty, zero, null, undefined). Inline snapshots are ideal
here because they make an unintended behavior change visible in the diff rather
than hidden in a separate snapshot file.

Delete these tests after the refactor lands and real tests replace them, or keep
them and say so. Leaving them undeclared is how a suite rots.

## Layer 3: import graph diffing

This is the layer unique to this skill and the one that catches what tests miss.
A refactor that preserves behavior should produce a *predictable* graph change.
An unpredicted change means something moved that you did not intend to move.

```bash
cp .codemap/snapshot.json /tmp/snapshot-before.json
# ... developer applies the proposed moves ...
npx repo-map map
npx repo-map report --prev /tmp/snapshot-before.json
```

Then compare against the prediction written in the proposal:

| Check | Pass condition |
|---|---|
| Cross-module edges | Matches the predicted number |
| Cycles | Same or fewer, never more |
| Orphans | No new ones. A new orphan means a call site was dropped, not updated. |
| Unresolved imports | Zero. Any value means a broken path. |
| Entry points | Unchanged. A lost entry point means a route or handler went dark. |
| External packages | Unchanged. A new one means a dependency crept in. |

**A new orphan after a refactor is the highest signal failure in this whole
process.** It means a file that was reachable no longer is, so some call site was
deleted rather than repointed, and typecheck stayed green because the file simply
stopped being imported. Tests may also stay green if that path was uncovered.
Treat it as a blocker.

## Layer 4: runtime tracing

For code paths that static analysis cannot follow (dynamic imports, DI, string
routing), record which modules actually load during a real run, before and after.

```bash
# Before the refactor
node --experimental-loader ./scripts/trace-loader.mjs dist/server.js &
# exercise the app: run the e2e suite, or hit the critical routes
npx playwright test
# trace written to /tmp/trace-before.json
```

A minimal loader that records every resolved module:

```js
// scripts/trace-loader.mjs
import fs from 'node:fs';
const seen = new Set();
const out = process.env.TRACE_OUT || '/tmp/trace.json';
export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  seen.add(result.url);
  return result;
}
process.on('exit', () => fs.writeFileSync(out, JSON.stringify([...seen].sort(), null, 2)));
```

Diff the two sets. Modules present before and absent after are the ones to
explain. Normalize the paths first or every moved file shows as a difference,
which makes the diff useless.

This layer is expensive and only worth it when the move scope contains dynamic
resolution. Skip it otherwise and say that you skipped it, rather than implying
a level of assurance that was not actually obtained.

## The verification report

```markdown
## Verification result: PASS | FAIL | PARTIAL

**Baseline** (before any moves)
- tsc: N errors
- tests: N passing, N failing, N skipped
- graph: N files, N cross-module edges, N cycles, N orphans

**After**
- tsc: N errors  [delta]
- tests: N passing, N failing  [delta]
- graph: N cross-module edges (predicted N), N cycles, N orphans

**Layers run**: 1, 2, 3   **Skipped**: 4 (no dynamic resolution in scope)

**Blockers**
- <new orphan, new cycle, failing test that passed at baseline>

**Not covered by verification**
- <dynamic imports, string-routed handlers, anything only exercised in prod>
```

State the "not covered" section every time, even when empty. The value of this
report comes from the developer knowing precisely how much assurance they have,
and a report that implies total coverage when three code paths were never
exercised is worse than no report at all.
