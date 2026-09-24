# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Chisel is an experimental TypeScript toolkit for growing an executable business specification from a closed data model, generated examples, and human-provided expectations. The workflow is fixed and sequential:

```
declare data and behavior
→ generate unanswered examples
→ let a human fill expected results
→ refine data and behavior
→ implement an executable model
→ check the model against the examples
```

Requires Node.js >= 26 (uses the built-in `Temporal` API — see `mise.toml` for the pinned version).

## Commands

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest run (see vitest.config.ts: test.include is test/**/*.test.ts)
npm run check        # typecheck + test
npm run coverage     # vitest run --coverage (v8 provider, src/** only)
npm run build        # tsc -p tsconfig.build.json -> dist/
npm run demo         # runs examples/progressive-demo/run.ts end-to-end
```

CI (`.github/workflows/check.yml`) runs `npm ci && npm run check` on push to `main` and on every pull request.

Run a single test file directly with vitest, e.g. `npx vitest run test/chisel.test.ts`. Tests use Vitest (`describe`/`it`/`expect` imported explicitly from `"vitest"`, no globals). `expect(...).toStrictEqual(...)` (not `toEqual`) is the standard equality assertion here — it distinguishes `{ note: undefined }` from `{}` the same way `node:assert.deepStrictEqual` did, which matters for the `optional()` invariant below.

`src/cli.ts` exports `run(argv): Promise<{ exitCode, stdout, stderr }>` — a pure argv-in/lines-out function with no direct `console.log`/`process.exit` calls — plus a top-level `isRunAsScript()` guard (comparing `import.meta.url` against the `realpathSync`'d `process.argv[1]`, so it resolves correctly through the `dist/cli.js` bin symlink too) that calls `run` and does the actual I/O only when the file is executed directly. `test/cli.test.ts` calls `run(...)` in-process for nearly all cases (fast, fully covered by `npm run coverage`) and keeps exactly one `spawnSync` subprocess test to prove the shebang/`isRunAsScript` wiring itself works end-to-end — that one test's process boundary is the only part of `cli.ts` Vitest's V8 coverage can't see.

The CLI can load `.ts` spec files directly (via `tsx/esm/api`'s `tsImport`), no build step required:

```sh
npx tsx src/cli.ts check ./examples/order-cancellation.spec.ts
npx tsx src/cli.ts check ./examples/order-cancellation.spec.ts --strict
npx tsx src/cli.ts generate ./examples/order-cancellation.spec.ts
```

package.json also exposes these as `npm run example:check`, `npm run example:strict`, `npm run example:generate`. `check` reports state without failing by default; `--strict` exits 1 when examples are unanswered, variants are uncovered, the implementation is absent/pending, control policies are incomplete, or the implementation disagrees with an example.

## Architecture

Everything is exported through `src/index.ts`; there is no barrel re-exporting beyond that. Four modules, each building on the last:

1. **`src/schema.ts`** — the data layer. `Schema<T>` is the common interface (`parse`/`placeholder`). Primitives: `string`, `number`, `boolean`, `instant` (Temporal.Instant), `literal`, `array`, `optional`, `record`. `object(shape)` composes fields; `optional()` fields become real `key?: T` in the inferred type (via `InferShape`), not a required `key: T | undefined`. `sum(discriminant, variants)` builds a tagged union over object variants and is central to the whole system: behaviors' `input` and `effects` must be `SumSchema` because coverage analysis is driven by enumerating `variantTags` — `array`/`optional`/`record` are only meant to appear *inside* an `object()` shape or as a behavior's `result` schema, never as a behavior's `input`/`effects` directly. `tagOf`/`isSumSchema` are the primitives everything else uses to identify which variant a runtime value belongs to.

2. **`src/behavior.ts`** — the behavior/implementation layer. `behavior({ name, input, result, effects, dependsOn })` declares a boundary (data in, data out, side-effect vocabulary) without implementation. `implement(behaviorDef, { cases, controls })` supplies one `Decision` (or `pending(reason)`) per input variant, plus a `ControlTable` mapping each effect variant to a `ControlPolicy` (`execution: direct|outbox|queue`, `idempotency`, `compensation`, optional `exposure`) or `pending`. `runImplementation` dispatches on the input's discriminant tag, runs the matching decision, and validates the input/result/effects against their schemas — throwing `SpecificationError` on any mismatch, missing case, or pending decision.

3. **`src/specification.ts`** — the example/adequacy layer. `example`/`examples` build typed rows of `{ given, expect }` against a behavior, where `expect` is either a concrete `Execution` or `unanswered(reason)`. `defineSpecification({ name, examples, implementation? })` ties an example set to an (optional) implementation. `evaluateSpecification` is the core analyzer: it walks every example, tracks input/result/effect variant coverage, collects unanswered rows, pending decisions, control gaps, and `dependencyIssues` (a `Behavior.dependsOn` or per-`Decision.dependsOn` entry that names an effect tag not present in the behavior's `effects` schema — catches typos in declared dependencies), and — if an implementation is present — actually runs it against each example (`runImplementation`) and deep-equal-compares the outcome, reporting mismatches as `failures`. The run-and-compare logic is factored into the private `runAndCompare` helper, shared with `verifyConformance` below. The result is an `AdequacyReport`; `adequate` is true only when there is an implementation, zero failures/unanswered/pending/gaps/dependencyIssues, full input/result/effect coverage, and every class in `partitions` has an answered row in it. The report also carries `evidence` graded the way Souther grades it (an input case is `specified`/`executed`/`verified`, a result case `specified`/`observed`/`verified`; a row whose answer is owed still runs, so it can execute and observe but never specify), `measures.arms` (`not applicable` without an implementation, otherwise `not measured` with a `notRead` list of decision ids — a `Decision.run` closure is opaque, so its branches are never read), and a `verdict`: `not_satisfied` when a gap was found, `undetermined` when none was found but the arms could not be measured, `satisfied` only when nothing is left unmeasured. `--strict` exits 1 exactly when `adequate` is false; an unreadable measure is the tool's shortfall and never fails a build. `generateExamples` emits `unanswered()` rows (with schema-derived placeholders) for every uncovered input variant and then for every class no existing or generated row stands in, moving only the position that class belongs to — this is what backs `chisel generate`. Rows whose answer is owed count as already asking, so they are not generated again. `verifyConformance` is a separate, narrower check: it runs *only* the answered examples against an arbitrary async subject function (e.g. a real controller/service), keeping "does the model make sense" (adequacy) separate from "does infrastructure code conform to the model" (conformance).

4. **`src/cli.ts`** — thin wrapper over the above. Loads a spec file's module via `tsImport` (so `.ts` files run without a build step), discovers exported `Behavior`s and `Specification`s by shape (`isBehavior`/`isSpecification`), synthesizes an empty specification for any behavior that's exported but not wrapped in `defineSpecification` yet, and dispatches to `check` (prints `AdequacyReport`s) or `generate` (prints ready-to-paste `example(...)` rows via `formatTypeScriptValue` from `src/codegen.ts`).

`src/partition.ts` derives the positions of a behavior's input from its schema, Souther-style: every field under each input variant is a position named by a path such as `@商品あり.クーポン` (`@` narrows to a sum case, `[]` steps into array elements, `?` into what an optional holds). `optional` divides into `なし`/`あり`, `boolean` into `true`/`false`, and a sum field into its cases; objects, array elements and optional payloads are taken apart recursively; everything else is `not-derivable` — the model draws no line through it, which is a fact about the model and never a gap. A `DividedPosition` can `classify` a given value and `place` a class into one (forcing the enclosing sum cases and writing an array element where needed), which is how `generateExamples` composes rows.

`src/codegen.ts` is a small, standalone pretty-printer from runtime values back to TypeScript literal syntax (including `Temporal.Instant.from(...)`), used only to render generated example placeholders.

## Key invariants to preserve when editing

- `sum`'s `parse` merges the discriminant tag back into the parsed value (`{ [discriminant]: tag, ...result.value }`) — variant object schemas do not need to declare the discriminant field themselves.
- Coverage/adequacy analysis (`evaluateSpecification`, `generateExamples`) depends entirely on `SumSchema.variantTags` and `tagOf`; if you add a new schema kind that can appear as a behavior's `input`/`effects`, it must stay a `SumSchema` or the coverage model breaks.
- `runImplementation` and `evaluateSpecification`'s implementation check both re-validate input/result/effects through the schema, even though the example row was presumably already schema-valid — don't remove this, it's what catches implementation code that returns malformed data.
- Stale examples are meant to fail to compile when the data/behavior model changes (see `examples/progressive-demo/type-break/`) — this is a deliberate correctness mechanism, not something to work around with looser types.
- `object()`'s `parse`/`placeholder` drop a field entirely when its value is `undefined` (this is how `optional()` fields disappear instead of being written as `undefined`). Keep that: `evaluateSpecification`/`verifyConformance` compare examples with `isDeepStrictEqual`, which treats `{ note: undefined }` and `{}` as different — writing an explicit `undefined` key would make schema-normalized values fail to match hand-written examples that simply omit the field.

## The progressive demo

`examples/progressive-demo/` (driven by `npm run demo`, verified by `test/progressive-demo.test.ts`) walks the full stage-01 → stage-04 sketch/answer/refine/implement sequence for a hotel reservation behavior. It's the reference example for how the four stages are meant to compose in practice — read `examples/progressive-demo/README.md` and the stage files in order before changing the demo or the underlying API surface it exercises.
