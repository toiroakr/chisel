# Chisel

Chisel is an experimental TypeScript toolkit for defining executable state transitions and checking the same definitions against invariants. A machine runs in production through `@toiroakr/chisel`; its verification properties live separately in `@toiroakr/chisel/verification`, so they are not part of the runtime import graph. See [one reducer for runtime and exhaustive checking](#one-reducer-for-runtime-and-exhaustive-checking) for a complete example.

The machine workflow is:

```text
define state and commands
→ implement one transition expression
→ run it with runMachine
→ declare invariants in a separate specification
→ check reachable states or generate TLA+ proof obligations
```

Install with `npm install @toiroakr/chisel` (Node.js 22.22, 24.15, 26 or newer, or Bun).

**0.2.0 migration:** The package root now exports the state-machine runtime. Existing 0.1.x imports of `behavior`, `spec`, `check`, and related APIs must change from `@toiroakr/chisel` to `@toiroakr/chisel/full`. Verification of machines uses `@toiroakr/chisel/verification`. This breaking export change is outside the `^0.1.0` version range.

The earlier behavior-and-example workflow remains available from `/full` and is documented below.

## 1. Declare data and behavior

The behavior and specification examples below use `import * as c from "@toiroakr/chisel/full"`. The package root `@toiroakr/chisel` provides the executable state-machine API described in [one reducer for runtime and exhaustive checking](#one-reducer-for-runtime-and-exhaustive-checking), together with what production code needs to run a behavior: the schemas, `behavior`, `implement`, `model` and its expressions, `dependency`, `perform`, `performSync`, `decode` and `encode`. It reaches neither the analysis (`check`, `generate`, `verify`) nor zod, tsx or `tla-ts`, so code that runs a verified model in place of its own imports only the root, and its specification imports `/full` alongside.

`c.performSync(implementation, input, deps)` answers what `perform` answers, for a caller that cannot await: it parses and validates the same way and throws `SpecificationError` where a dependency or a decision answers a promise.

The first version describes the domain vocabulary and the behavior boundary, not its implementation. `variants(discriminant, { case: object(...) })` declares a discriminated union: a value is exactly one of the named cases, told apart by the discriminant field (Souther calls this a sum type). An `object` holds exactly the fields it declares: a value carrying another key is refused, not trimmed, so a model answering with a stray field fails `check` instead of passing it.

```ts
import * as c from "@toiroakr/chisel/full";

const Order = c.variants("state", {
  unpaid: c.object({ orderId: c.string() }),
  paid: c.object({
    orderId: c.string(),
    paymentId: c.string(),
  }),
});

const CancelResult = c.variants("type", {
  accepted: c.object({ orderId: c.string() }),
  rejected: c.object({ reason: c.string() }),
});

const CancelEffect = c.variants("type", {
  refund: c.object({ paymentId: c.string() }),
  restock: c.object({ orderId: c.string() }),
});

export const cancelOrder = c.behavior("cancel-order", {
  input: Order,
  result: CancelResult,
  effects: CancelEffect,
});
```

## 2. Generate unanswered examples

```sh
chisel generate ./cancel-order.spec.ts
```

Chisel emits TypeScript rows for every uncovered input variant, then for every class and border point no row stands in yet (see [Analysis](#analysis)). The rows are written the way hand-written examples are (bare keys where the key is an identifier, trailing commas), so they paste as they are. For a behavior no `spec` wraps yet, the output also carries the `import` line, an implementation whose every case and control is `c.todo(...)`, and a `spec` block to paste after the behavior (a specification with no implementation gets the implementation scaffold too); for one that has a specification, only the rows are printed, ready to go into its `examples(...)` table.

```ts
export const cancelOrderExamples = c.examples(cancelOrder, {
  "cancel-order: unpaid": {
    given: {
      state: "unpaid",
      orderId: "<orderId>",
    },
    expect: c.todo(
      "Expected result for unpaid must be decided by a human",
    ),
  },
  "cancel-order: paid": {
    given: {
      state: "paid",
      orderId: "<orderId>",
      paymentId: "<paymentId>",
    },
    expect: c.todo(
      "Expected result for paid must be decided by a human",
    ),
  },
});
```

## 3. Fill expectations

A human replaces `todo()` with the expected result and effect trace. `todo(reason)` is the one marker for anything not decided yet: an answer here, and also a case of `implement` or an effect's control policy that is still open. `examples(behavior, { name: row })` is a table keyed by the row's name, which the report uses to point at a row; two rows with one name do not compile. Each row's `given` and `expect` are typed by the behavior, so a row that no longer fits the model fails to compile.

```ts
export const cancelOrderExamples = c.examples(cancelOrder, {
  "cancel a paid order": {
    given: {
      state: "paid",
      orderId: "o-1",
      paymentId: "p-1",
    },
    expect: {
      result: {
        type: "accepted",
        orderId: "o-1",
      },
      effects: [
        { type: "refund", paymentId: "p-1" },
        { type: "restock", orderId: "o-1" },
      ],
    },
  },
});
```

Where only the case of the answer is known, as an SOP's *then* says `status == Shipped` and nothing about the shipment it answers, the row writes the case with `c.caseOf(tag)` in place of the result, as Souther's bare case name `-> Shipped` does:

```ts
"ship a picked order": {
  given: { state: "picked", orderId: "o-1" },
  expect: {
    result: c.caseOf("shipped"),
    effects: [{ type: "notifyCustomer", orderId: "o-1" }],
  },
},
```

The answer is then compared by its case alone, and the effects still in full. The row specifies the `shipped` result case and verifies it when the model answers that case. An `ensures` clause, which reads the answer's value, is not held against such a row, since nothing wrote the value it would read; `c.test` compares production code's answer by the case too, and a fake row standing in for a behavior whose recorded row writes only the case agrees with it when it answers that case. A case the result does not have does not compile, and is refused as `Expected result is invalid`.

To build a row outside the table (a helper, or a row shared by several specifications), `example(behavior, { given, expect })` types it by the behavior, and it is put in a table under a name: `examples(cancelOrder, { "paid": paidRow })`. Rows are kept in the order written, except that names which are plain integers (`"1"`, `"100"`) come first, as JavaScript orders such keys.

Changing the data or behavior model makes stale examples fail to compile. Running `generate` again emits rows for newly introduced variants, classes and border points, each composed from an answered row with only the position in question moved.

## 4. Implement the model

Once expectations are known, `implement()` supplies one inspectable `model(name, input => expression)` per input case. The builder runs once at declaration; execution interprets its expression tree. Use `choose(condition, yes, no)` for branching and `construct(schema, value)` for intermediate constructions. The name is how reports refer to the model.

```ts
const implementation = c.implement(cancelOrder, {
  cases: {
    unpaid: c.model("cancel-unpaid", order => ({
        result: { type: "accepted", orderId: order.orderId },
        effects: [{ type: "restock", orderId: order.orderId }],
    })),
    paid: c.model("cancel-paid", order => ({
        result: { type: "accepted", orderId: order.orderId },
        effects: [
          { type: "refund", paymentId: order.paymentId },
          { type: "restock", orderId: order.orderId },
        ],
    })),
  },
  controls: {
    refund: {
      execution: "queue",
      idempotency: "required",
      compensation: "manual",
    },
    restock: {
      execution: "outbox",
      idempotency: "required",
      compensation: "automatic",
    },
  },
});

export const cancellation = c.spec("order cancellation", {
  examples: cancelOrderExamples,
  implementation,
});
```

## Guarantees and migration

`model()` replaces callback bodies when a specification must pass strict checking. Existing `action()` and `Decision.run` remain executable for progressive migration, but their bodies are not certified. See [the complete example](examples/verified.spec.ts), which passes `check --strict`.

- `verify(implementation)` checks intermediate constructions, results, effects, and postconditions. It exhausts finite domains, or proves supported constraints from input invariants and path conditions. Exact interval arithmetic also proves bounded numeric expressions without enumerating every input. It returns `verified`, `refuted` with a counterexample, or `undetermined`; sampled successes never count as proof.
- `choose` decisions remain visible even when multiple branches feed one computation. `check` measures their complete paths and feasible class pairs. `generate(..., { ways: true })` searches missing paths and pairs without supplying expected answers. Impossible pairs require exhaustive evidence; exhausted searches remain undecided.
- `data("Price", object(...))` creates a nominal object type. `Price.create(...)` validates and freezes a value. In a model, use `construct(Price, {...})` and list `constructs: [Price]` in `implement`. The ordinary schema parser remains an explicit validation boundary. This is a TypeScript type guarantee, not protection from `any` or malicious host modules.
- `int64()` stores signed 64-bit `bigint` values; `rational()` stores reduced `Rational` values. `arithmetic` supports exact bigint, Rational, and Decimal operations; `quotient` returns an exact Rational, including for integer division. `int()` retains safe JavaScript integers and `number()` retains finite JavaScript numbers. Decimal arithmetic in the model and linear rules does not inherit decimal.js's process precision setting. JSON uses strings for int64, Rational, Decimal, and Temporal values.
- `string()` now normalizes to NFC, rejects unpaired surrogates, and measures and orders Unicode scalar values. Enum and literal declarations must already be NFC; parsed text is normalized. This changes results for supplementary characters and decomposed text.

`check` reports `measures.constructions` and `measures.pairs` in schema version 2. Configure pair budgets with `pairs: { obligations, candidates }` or CLI `--pair-obligations` / `--pair-candidates`. Bounds apply to proofs and generation; an unresolved obligation fails strict checking.

```sh
chisel verify ./model.spec.ts
chisel verify ./model.spec.ts --json --candidates 4096 --ways 10000
chisel check ./model.spec.ts --strict --timeout 30000
npm run example:verified
```

`verify` exits 1 for either a counterexample or an unproved implementation. Text diagnostics use `file: error CHISEL001: description`, suitable for an editor task's problem matcher. TypeScript provides type errors and completion; [an example VS Code task](docs/editor-task.json) runs semantic verification. This repository's `build` runs the verifier on its complete expression example after TypeScript compilation.

The executable CLI runs all commands in a worker with a default 30-second deadline (including module loading), a 256 MiB old-generation heap limit, and a 1 MiB streamed-output limit. The deadline terminates synchronous loops too. `runIsolated(argv, timeoutMs)` from `@toiroakr/chisel/isolated` offers this boundary to hosts. It needs Node, which is why it has an entry of its own: `@toiroakr/chisel/full` imports no Node module, so a bundle of it runs where only Web APIs exist, such as a browser or an edge or serverless function runtime. Direct in-process `check` / `perform` calls cannot preempt arbitrary JavaScript callbacks; expression evaluation has its own step budget. The worker is a resource boundary, not an I/O sandbox for imported modules.

The proof system preserves matching quantified facts from input invariants and guards, including nested quantifiers and captured input fields. It also proves structural schema inclusion for collections and pipeline boundaries. Typed `map` and `fold` expressions prove their element and accumulator contracts. Recursive proofs, general higher-order functions, and unsupported substitutions remain unresolved. Full Souther language compatibility is not implied by a passing report; the guarantee applies to the selected model and the reported obligations.

### Function dependencies in models

Use `call` to invoke a declared function dependency in an expression:

```ts
const pricing = c.behavior("pricing", {
  input: c.variants("kind", {
    request: c.object({ quantity: c.int().min(1).max(100) }),
  }),
  result: c.int().min(1).max(101),
  effects: c.variants("kind", {}),
  dependencies: {
    price: c.dependency(c.int().min(1).max(100), c.int().min(0).max(100)),
  },
});
const implementation = c.implement(pricing, {
  cases: {
    request: c.model("price", (input, deps) => ({
      result: c.arithmetic("add", c.call(deps.price, input.quantity), 1),
      effects: [],
    })),
  },
});
c.verify(implementation);
```

The verifier proves each argument satisfies the dependency's input contract and treats each call's result as an independent value allowed by its output contract. For `dependency(behavior)`, supported unconditional `ensures` also supply facts. Bind a result and branch on its variant tag to use a case-scoped `ensures` within the matching branch. Verification never executes the injected callback or uses a fake table as proof of its universal behavior.

At runtime, every call validates its input, output, and applicable `ensures`. Model inputs, value dependencies, and call inputs and outputs are copied and frozen, including Decimal values, to prevent a dependency from mutating values used by another expression. Unsupported host objects such as mutable custom class instances are rejected at this boundary; use plain data or the supported Decimal, Rational, and Temporal types. The proof is conditional on the declared dependency contracts; it does not certify host callback termination or implementation. Case-scoped dependency postconditions supply proof facts when `bind` or `matchValue` establishes the matching result tag. These bindings also expose result fields to expressions and guards. Local and repeated branch coverage remains unmeasured, as described below.

A function dependency may answer a promise, as one that reads a database or calls another service does: `perform` awaits it where the model calls it and holds the settled answer to the same contract, so `c.perform(implementation, input, { lookup: async id => (await db.find(id)) ?? null })` reads the answer as a value. Calls run one after another, in the order the model reads them, each after the one before has settled; a rejection fails the run with its own error. A model whose dependencies answer values is still evaluated synchronously, so fake tables, `check` and `generate` read it as before. An action's own code (`run`, `orElse`, a `match` handler or a free-form decision) reads a dependency's answer as a value, so a dependency that answers a promise there fails the run with a `SpecificationError` instead of being read as its answer; a dependency that answers a value reaches that code as before, called on the object supplied.

A model can pass the entire input with `c.call(deps.lookup, input)`; internal dependency bindings are excluded. `#deps` is reserved as a top-level input field when a behavior declares dependencies. Existing fake tables work with `call` in example checks.

### Local values and collections

`bind(schema, expression, value => body)` evaluates an expression once, validates its contract, and makes its fields available to the body. This also lets `choose` inspect a function result. Inside a model builder with a dependency that returns `answer`:

```ts
const answer = c.object({ accepted: c.boolean(), amount: c.int().min(1) });
const result = c.bind(answer, c.call(deps.lookup, input), value =>
  c.choose(value.accepted.$eq(true), value.amount, 0),
);
```

For a variant result, `matchValue(schema, expression, cases)` requires a body for every tag and exposes the fields of that case. It evaluates the expression once:

```ts
const answer = c.variants("kind", {
  missing: c.object({}),
  ok: c.object({ amount: c.int().min(1) }),
});
const result = c.matchValue(answer, c.call(deps.lookup, input), {
  missing: () => 0,
  ok: value => value.amount,
});
```

Where the expression is a field of the input declared with that schema, `matchValue` reads the field itself: its cases are measured like a guard on the field's discriminant (arms, ways and borders), and the fields of a case are proved under it, so a model written this way can pass `check --strict`.

### Absence is a case of a sum

A comparison reading a value that may be left out is refused where it is written: an optional field (`c.string().optional()`), a field of an object that may be left out, an entry of a record read by its key (`input.tags["owner"]`), a field only some cases of a sum declare, or the constant `undefined`. Such a comparison would hold whenever the value is left out, so `input.note.$eq("urgent")` would silently pass for an input without a note. `refine` throws (`refine reads $.割引額, which may be left out: write its absence as a case of a sum`), and so do `implement` for a guard or a model (`guard in note reads $.note, which may be left out: …`) and `behavior` for an `ensures` clause. Write the absence as a case of a sum instead, and read a case's fields where the case is settled: under an earlier guard or conjunct comparing the discriminant (`input.name.state.$eq("given").$and(input.name.value.$eq("x"))`), inside a `choose` on it, or in the case's body of a `matchValue`. A term of a sum reaches the fields of every case, and `implement` checks which reads are settled. An optional field may still be carried into an answer; only comparing it is refused.

```ts
const label = c.variants("state", { absent: c.object({}), given: c.object({ value: c.string().min(1) }) });
const result = c.matchValue(label, input.name, {
  absent: () => ({ verdict: "none" }),
  given: name => ({ verdict: "owner", name: name.value }),
});
```

`map(elementSchema, outputSchema, values, element => body)` proves the body for an arbitrary element. `fold(elementSchema, accumulatorSchema, values, initial, (accumulator, element) => body)` proves that the initial value and every update satisfy the accumulator schema. This is an inductive invariant, independent of the array length:

```ts
const bounded = c.int64().min(0n).max(100n);
const maximum = c.fold(bounded, bounded, input.values, 0n, (accumulator, value) =>
  c.choose(value.$gt(accumulator), value, accumulator),
);
const incremented = c.map(
  bounded, c.int64().min(1n).max(101n), input.values,
  value => c.arithmetic("add", value, 1n),
);
```

These builders run at declaration time; the interpreter executes the resulting expressions. Nested collections and captured input fields are supported. Runtime checks validate each element and update, including the initial accumulator for an empty array. Iterations share the evaluation budget, and nested body proofs share the path budget. Dependency calls inside a body remain independent at each iteration.

Locals cannot escape their body. Declare each binding separately rather than reusing its expression in multiple locations. Top-level input names starting with `#local:` are reserved in models. Reading the whole input inside a body excludes local bindings.

Construction proofs and example coverage are separate. A branch on a dependency's answer (`matchValue` or `choose` over what `c.call` answers) is measured like a guard: the answer is read as a position of its own, written `lookup()` in reports, that may be any value the dependency declares it answers and is held to its `ensures` (a way they leave no value is owed no row). Rows reach such a way through the specification's `fakes`, and `generate` (given `fakes`, as `chisel generate` passes them) offers the input a fake row asks for each way or border point no row reaches yet, or names the answer a fake row must give. A branch on a value the model computes is measured too. A `bind` of a sum or difference of input numbers, a whole multiple of one, a constant or an object of such values is read where it is read (`bind(c.int(), c.arithmetic("add", input.a, input.b), total => c.choose(total.$gte(100), …))` is the guard `$.a + $.b >= 100`, with its border drawn on the input), and a condition that reads no value settles which way it goes. A quotient by a whole number compared with a rational is read multiplied out (`quotient($.a, 7) >= new c.Rational(3n)` is `$.a >= 21`); a rational compared with a plain number, which never holds as the model compares them, is refused by `implement`. This reading is for measurement only: the model runs as it is written, and what a run takes is recorded in the terms the analyses read. A sum of `number` fields is not read as an expression, since the model adds numbers in floating point and an exact expression could answer otherwise (`0.1 + 0.2 == 0.3`). A value Chisel cannot read as an expression (a product of two inputs, a bound `choose`, a concatenation, whose NFC form may be shorter than its parts, a temporal value, a fold's accumulator) is shown by what computes it (`multiply($.a, deps.rate)`), and a way through it, or a border point drawn on it, that no row reaches is settled by running the case's inputs through the decision: the fields the decision's choices turn on, every stand-in of the value dependencies, and every answer a function dependency's contract allows (its output, as the schema the answer is bound under also takes it, and its `ensures`). One that takes the way makes it a gap, and where a fake row gives that answer `generate` offers the input it asks; where those runs are every input, stand-in and answer there is and none takes it, no row is owed (three times a whole price is never 200). Before and after that, a comparison a sum, difference or product can never meet given the bounds of what it reads owes no row (two inputs of at least 2 never multiply to less than 4), and a product of two integer inputs equal to a whole number is tried at every divisor pair of it (a prime is never a product of factors of at least 2; 1000001 is 101 × 9901). Only where none of this settles it is it left `undecided`, as no cubes add up to a cube, which takes Fermat's last theorem to tell: deciding such a way in general is not possible. A branch inside `map` or `fold` is measured as the ways one element takes through the body (`each of $.lines[]: …`): an element of an array the input holds stands at that array's element position, so its borders and classes are drawn there and `generate` composes them, and a way through the body by a row holding one element that takes it. Branch-free collection expressions remain eligible for strict checking. Array-length relationships and arbitrary fold postconditions beyond the declared accumulator contract are not inferred.


## Commands

Chisel runs on Node.js 22.22, 24.15 and 26 or later, and on Bun. Only the temporal schemas (`instant`, `date`, `time`, `datetime`) need the Temporal API: Node.js 26 has it built in, and on earlier runtimes import a polyfill such as `temporal-polyfill/global` before using them. A specification without temporal values needs nothing more. The test suite loads `temporal-polyfill` where the runtime lacks Temporal, and CI runs it on Node.js 22, 24 and 26.

```sh
npm install
npm run check
npm run demo
```

The built CLI can load TypeScript directly.

```sh
node dist/cli.js generate ./cancel-order.spec.ts
node dist/cli.js check ./cancel-order.spec.ts
node dist/cli.js check ./cancel-order.spec.ts --strict
```

`check` reports the current state without failing by default. `--strict` exits with status 1 while examples are unanswered, input/result/effect variants, classes or border points are uncovered, the implementation is absent or pending, control policies are incomplete, or the implementation disagrees with an example. It also fails for `undetermined`: missing measurements, unproved constructions, exhausted budgets, and opaque callback bodies must not certify a build. `adequate` is now exactly `verdict === "satisfied"`.

Invalid command lines, including unknown subcommands, unknown flags, and missing required arguments, exit with status 2. Errors while executing a command exit with status 1.

## Progressive demo

The [hotel reservation demo](./examples/progressive-demo/README.md) runs the complete declaration → generation → human answer → refinement → implementation sequence.

```sh
npm run demo
```

## Analysis

The analyzer follows the example-adequacy model of [Souther](https://github.com/souther-lang/souther). It measures what the model itself states and nothing else:

- **Cases** of the input, result and effect variants. Evidence is graded: an input case is `specified` by a row, `executed` when the model ran on it and `verified` when the row held; a result or effect case is `specified`, `observed` or `verified`.
- **Classes** of each input position, derived from the types: an optional field (`c.string().optional()`) is absent or present, a `boolean` true or false, an `enum` one of its values (`c.enum(["draft", "submitted"])`, with what each means as `c.enum(["draft", "submitted"], { labels: { draft: "下書き", submitted: "申請中" } })`, a choice with nothing to carry, which a guard may compare with `$eq`/`$ne` and a `match` may select; ordering it with `$lt` and the like is listed as a comparison Chisel cannot read, since its values order by their text), a `variants` field one of its cases. A class an `eq`/`ne` invariant refuses is `excluded` and counted neither way, and so is one that invariants relating several booleans, enums or `variants` cases leave no combination for (`.refine(v => v.甲.$eq("x").$or(v.乙.$eq("y")))` with `.refine(v => v.甲.$ne("x").$or(v.乙.$eq("y")))` leave `乙` only `y`). The same holds for an input case an invariant on the input sum refuses (`variants(...).refine(v => v.state.$ne("archived"))`), and a rule on a field every case shares draws its border under each case. A position no rule draws a line through is `not derivable`, which is a fact about the model rather than a gap.
- **Borders** drawn by an invariant that compares a value or a `length` with a constant, with the four domain-testing points `ON`, `OFF`, `IN` and `OUT`. Outside an invariant nothing can be constructed, so `OFF` and `OUT` are excluded; `ON` and `IN` are owed a row. An invariant ordering two positions, such as `object({ 数量: c.int(), 上限: c.int() }).refine(v => v.数量.$lte(v.上限))`, draws its border on their difference (`@case.数量 − @case.上限`, `ON = 0` and `IN < 0` owed, `OFF = 1` and `OUT > 1` excluded), as Souther draws the border of a relation an input's type states, whether the case or an object one of its fields holds declares it (one comparing a field with itself draws none, and is reported as a model error when no value keeps it); an invariant on an answer draws none. `int`, lengths, instants and the calendar types have a neighbouring value (a `date` steps by a day, a `time` or `datetime` by a nanosecond); `number` and `string` do not, so their `OFF` point is not named. A point one bound owes is excluded when another bound refuses it, and bounds that leave nothing admitted (`$ >= 10` with `$ <= 5`) are reported as a model error rather than as gaps. A length is never negative, so a point that would lie below zero has no point there (`none: a length is never negative`) and no row is asked for at it, whether the border comes from an invariant or a guard. A `time` lies between `00:00` and `23:59:59.999999999` in the same way, so a point past either end is `none: a time of day lies within one day`.
- **The lines beside a border** over two or more fields, as Souther's E1938 asks: once every point a guard's border owes has a row, the rows that reached it may still fall on the same sides of a line one weight away, so that the guard could have been written as that line. For a guard `y <= 2 * x` whose rows all have `x = 0`, the report names `-@case.x + @case.y = 0` (`border.beside`, `not told`, printed as `隣の線 ! … と見分ける行がない`) and the specification is not adequate until a row the two lines answer differently at is written; each part's weight is moved by one up and then down, in the order of the fields' paths, and the first line the rows allow is named, with an input to write a row at (`beside.input`, `@case.x = 1, @case.y = 2` there): a step along the border from a row that the guards before it still let through, preferring one the other guards also keep and then the fewest steps, as Souther's hint does; `generate` offers a row there, named `隣の線 (…)`, or lists the border among those it could not compose when no such step is found. Souther reports it as a warning that still fails adequacy, and so does Chisel.

Besides `c.instant()` for an exact moment (`Temporal.Instant`), `c.date()`, `c.time()` and `c.datetime()` hold a calendar date, a time of day and a wall-clock date and time (`Temporal.PlainDate`, `PlainTime` and `PlainDateTime`); a condition orders values of one of these types, and ordering two types against each other does not compile.

A model moves one of these values by a whole number of one unit with `c.plus(value, amount, unit)` and `c.minus(value, amount, unit)`, and counts the whole units from one to another with `c.between(start, end, unit)`, as Temporal's `add`, `subtract` and `until` do:

```ts
c.model("plan the receipt", order => ({
  result: {
    outcome: "planned",
    expectedOn: c.plus(order.exFactoryOn, order.leadTimeDays, "days"),
    daysLate: c.between(order.exFactoryOn, order.completedOn, "days"),
  },
  effects: [],
}))
```

The unit is the type's: a date takes `years`, `months`, `weeks` and `days`, a time of day and an instant `hours`, `minutes`, `seconds` and `milliseconds`, and a date-time both, so `c.plus(time, 1, "days")` does not compile. The amount is a whole number, which may be negative. A month or year that lands past the target month's last day moves to that day (`2026-01-31` plus a month is `2026-02-28`) unless `{ overflow: "reject" }` asks for the value to be refused instead; a time of day wraps at midnight (`23:00` plus 90 minutes is `00:30`); `between` drops a part of a unit, toward zero, and is negative when the end comes first; it counts a unit of fixed length (`weeks` to `milliseconds`) between dates or date-times of two calendars in the ISO calendar, since such a unit counts alike in every calendar, and leaves months and years to Temporal, which refuses to count them across calendars. `verify` places a date, a date-time and an instant on one line of nanoseconds since 1970-01-01, so a move by a unit of fixed length (`weeks` to `milliseconds`) and a count between two such values are proved from the bounds of their parts, as integer arithmetic is: `c.plus(on, by, "days")` with `on` at most `2099-12-31` and `by` from 0 to 365 meets a `c.date().max(...)` a year later, and is refuted with a counterexample against one that ends on `2099-12-31`; a date with no bounds may be moved out of the range Temporal holds, so it is left undetermined. A month or year has no fixed length and is left undetermined too, and so is a count in `weeks` whose end may lie within a week of that range, since Temporal places the week past the end to round the count. A moved time of day meets a `c.time()` without bounds when its amount is a safe integer short of the 2^53 seconds Temporal refuses as a duration; an amount that may lie past the safe integers leaves any move undetermined.

Any schema takes `.describe("...")`, as in zod, and a behavior a `description`, saying what they mean to the people reading the specification; neither changes what is parsed or measured, and an optional field carries the description of what it holds. `variants("状態", { 下書き: c.object({...}).describe("まだ申請していない"), ... })` names each case.

Use `c.int()` for whole units such as yen and pieces, and `c.decimal(scale)` for values with fixed fractional digits. A `c.number()` has no value next to a bound, so `price < 1000` owes a row at 1000 but cannot name the one just below it. Where the digits after the point are fixed, as for an amount in cents or a weight in grams, `c.decimal(2)` (or `decimal(3)`) says so. Its values are [decimal.js](https://github.com/MikeMcl/decimal.js) `Decimal`s, so arithmetic on them is exact (`new Decimal("0.1").plus("0.2")` is `0.3`): a value with more digits is refused, a bound steps by one unit of the last digit, so the same guard owes a row at 999.99 too, and `generate` writes the rows as `new Decimal("999.99")`, importing decimal.js beside chisel. A bound written off that grid, such as `$gte(new Decimal("0.004"))` in cents, draws the border of `$gte(new Decimal("0.01"))`. An equality with such a value settles without a row (`$ne(new Decimal("0.005"))` in cents always holds, and `$eq` never does), so it is refused wherever it is written: `implement` refuses it in a guard (`guard in 半端な額 compares $.合計 with 0.005, which no decimal(2) holds: $.合計 != 0.005`), `refine` and its shorthands in an invariant (`refine compares $.合計 with 0.005, …`), and `behavior` in an `ensures` clause (`Ensures 半端にしない compares value.合計 with 0.005, …`). A decimal is compared only with a decimal: two of them draw a border on their difference in units of the finer scale.

The common bounds have zod's shorthands, each desugaring to the same rule `refine` would take: on numbers, decimals and the temporal types `min`, `max`, `gt` and `lt` compare the value (with a bound of the same type, such as `c.date().min(Temporal.PlainDate.from("2026-01-01"))`), and on strings, arrays and records `min`, `max` and `length` compare the length, so the borders keep a value and a length apart. `refine(v => ...)` states anything else, such as a relation between two fields (`.refine(v => v.start.$lte(v.end))`), and takes a name first, as every named construct does (`.refine("starts before it ends", v => v.start.$lte(v.end))`, as do the shorthands, `c.int().min("at least one", 1)`), which the issue for a value breaking it carries as `invariant` (`Invariant starts before it ends violated: $.start <= $.end`) and the borders it draws are labelled with; a value is refused with one issue for every invariant it breaks, and one schema may not name two invariants alike; its callback returns a rule built with term operators, not a boolean, so a condition the analysis cannot read does not type-check. A numeric or decimal term also adds and subtracts, `v.甲.$gte(v.乙.$minus(v.丙))` or `v.甲.$plus(2).$lte(v.乙)`, as Souther conditions do: the comparison reads the value of the expression, and one holding a field that may be left out is refused, as every comparison reading such a field is (see [absence is a case of a sum](#absence-is-a-case-of-a-sum)). A guard or an input invariant comparing an expression of integer or number fields draws its border on the expression, as Souther does: `甲 >= 乙 − 丙` has its `ON` point at `甲 − 乙 + 丙 = 0` and its `OFF` point at `-1`, and `generate` writes a point by moving a field the expression counts once, trying each in turn until the input takes the row (a point of `2 * 甲 >= 2 * 乙`, which counts none once, is named among those it could not compose), and the guards on one expression are read together, so a point of `甲 >= 乙 − 丙` behind `甲 <= 乙 − 丙` that no value reaches is owed no row, and so is one the fields' own bounds leave the expression no value at (with `甲` and `丙` at least 0 and `乙` at most 0, `甲 − 乙 + 丙` is never below 0, so `OFF` and `OUT` are owed none); a row `generate` moves across an invariant ordering two numbers, such as `correctQty < recordedQty` when `correctQty` is moved to 1, has the other number moved to the nearest value that keeps it (`recordedQty = 2`); an expression over decimals is still listed among the comparisons Chisel cannot read.

```ts
const Line = c.object({
  quantity: c.int().min(1),
  unitPrice: c.int().min(0),
});
const Lines = c.array(Line).min(1);
const SubtotalByProduct = c.record(c.int().min(0)).min(1);
```

A record's length is its number of keys, so `SubtotalByProduct` needs at least one product; `generate` writes it as `{ "<key>": 0 }`, one entry showing the shape of its value, the way an array placeholder holds one element.

- **Arms and rules** of an action's `guards`, and the borders and classes its guards draw. A guard compares with the same vocabulary as an invariant: a condition is written on terms, which read a field by its own name, as `run` reads the value (`line.quantity`), and whose operators carry a `$` prefix, so no field name can shadow one: they compare with `$lt`, `$lte`, `$gt`, `$gte`, `$eq` and `$ne`, measure with `$length()`, read a string as `String.prototype.trim`, `toLowerCase` and `toUpperCase` give it back with `$trim()`, `$lowercase()` and `$uppercase()` (in the order written, the value itself left as it is, so `reason.$trim().$length().$gt(0)` refuses a reason of only spaces and `code.$trim().$lowercase().$eq("abc")` matches ` ABC `; a bound no string reads as, such as `"ABC"` after `$lowercase()`, has no point at it, so such an equality never holds and owes no row), quantify over array elements with `$all` and `$any`, and combine with `$and`, `$or` and `$not`. A condition becomes a guard with `$else`, which answers when the condition does not hold; that answer is an ordinary result case, so a business rejection is data, not an exception:

```ts
const implementation = c.implement(checkout, {
  cases: {
    withItems: c.action("check stock, then confirm", {
      guards: cart => [
        cart.lines.$all(line => line.quantity.$lte(line.stock)).$else(() => ({
          result: { type: "rejected", reason: "out of stock" },
          effects: [],
        })),
      ],
      run: cart => confirm(cart),
    }),
  },
});
```

  Every guard has a `holds` and an `else` arm, and every case of a `match` is an arm (a `match` that leaves out a case of the `variants` or value of the `enum` it matches on, or names one it does not have, fails to compile, and one on a sum that may be left out, or is held by something that may be, is refused by `implement`, since no case would take its absence: write the absence as a case of the sum); each way through the guards is a rule. Where every value the guards and the `match` read is a boolean, an `enum` or a `variants` case and their combinations are few enough (`feasibility.combinations`), Chisel tries each combination the invariants on those values keep and lists only the ways some combination takes, since the ways `$and`/`$or` spell grow exponentially with the conditions while the combinations stay few; otherwise it lists at most `feasibility.ways` ways (10000 by default, `chisel check --feasibility-ways <n>`) and leaves a decision with more unmeasured instead. Such a decision is reported in `toBeChangedFirst` with what to change, read off the model's shape without listing its ways (`c.modelChanges(specification, options)`, which `chisel check` prints under `計測の前に:` before it measures in text mode; with `--json` the guidance is in the report's `toBeChangedFirst`): the ways of a model multiply across the parts a way goes through all of, so the report names parts, chosen greedily and each itself within the limit, that, declared as behaviors of their own and called as dependencies (whose answer is read as a value, their choices measured once in their own reports), leave the rest within the limit (a guide, not the smallest split there is); for guards, it names the stages that, joined with `compose`, are each within it (or says no such split exists). Nothing it says depends on the measurement, so the model can be changed as soon as it is printed. A check that runs long says on stderr which behavior and phase it is on, after three seconds and then once a minute (`progress` in `CheckOptions` and `GenerationOptions`).

Following Souther 0.5.0, a check also reports `walks`: every `fold` a model writes is run, for each answered row that took a second element, with the walk stopping after its first step and with every step handed the seed; a rewrite no row tells apart is `not told`, which makes the specification inadequate, and `generate` offers a row with the walked list grown to two elements. It reports `stops`: every operation, temporal move and construction a model writes is judged once as `may stop` (with an input that stops there, and for a division by an input field the invariant that keeps it from stopping), `never stops` (shown by an exhaustive run, a proved construction or the exact range of the operation) or `not resolved`, which leaves the verdict `undetermined`. Guard borders over one computation owe their weights from the lines beside them once, however many thresholds it is compared with. `generate` also offers suggested rows that owe nothing: the inputs a called behavior's recorded rows were written with, asked in its caller. A condition may also relate a place to a value: `v.email.$endsWith("@example.com")`, `$startsWith`, `$contains`, `v.rates.$hasKey("USD")` on a record and `v.tags.$includes("vip")` on an array; against a written value it divides the place into the classes the relations come out in, each owed a row, and a way whose relations contradict each other by their laws owes none. `c.decimal()` without a scale takes any finite decimal, `c.round(value, scale, mode)` and `c.divide(a, b, scale, mode)` round exactly at any scale, and a run with no room to write an answer fails as `OutOfRoom`, which `check` reports apart from the model's failures. A fold or map takes its step as a value too: `c.fold(element, output, xs, seed, c.choose(cond, c.step<[number, number], number>((total, x) => …), c.step<[number, number], number>(…)))` chooses the step once, before the walk. A way or an arm no row took is a gap only when some row could take it: where the conditions it passes contradict each other or the invariants of the values they read (`$.x >= 10` holds and `$.x >= 5` fails), no row is owed, and that includes an invariant relating several booleans, enums or `variants` cases by `==`/`!=` (with each other or with a value) and `$and`/`$or`/`$not`, whose combinations Chisel tries up to a limit (`c.check(specification, { feasibility: { combinations } })`, `chisel check --feasibility-combinations <n>`, 4096 by default; past it the way is undecided); where a condition Chisel cannot read (`all`/`any`) shares a value with another, it is undecided, which leaves the verdict `undetermined` rather than `not_satisfied`. Both are counted under their reason instead of listed. A guard border point is settled the same way, from the conditions a row has passed before it reaches the comparison. That holds for a comparison of two positions too, read on their difference: behind a guard `x <= y`, the `IN (> 0)` point of a later `x >= y` is one no row can reach, so no row is owed there, as Souther refutes a point the rules leave no value at. `generate` offers a row for each way no row takes but some row could: where the way ends in a `match`, it moves the matched field of a row that reaches it, and, with `chisel generate --ways` (`c.generate(examples, implementation, { ways: true })`), where every condition on the way compares a boolean, an `enum` or a `variants` case with a value (`==`/`!=`), it writes all of them at once, so a way that needs several values chosen together (`$.甲 == "x"` and `$.乙 == "y"`) gets a row too. Without it such a way is only named, since every way through `$and`/`$or` is its own row and their number grows quickly with the conditions. Wherever a row `generate` writes would break an invariant relating several booleans, enums or `variants` cases, the other values those invariants reach are chosen again so the row keeps them, and a way row is tried from every answered row of the case before its placeholder. A way with an ordering, a length, `all`/`any` or a field inside a `variants` field it cannot compose is named in its output instead. A guard comparing a position with a constant divides it into classes and owes all four border points; one comparing two positions with an order draws its border on their difference, while an equality between two positions draws none, since its `holds` and `else` arms already ask for a row on each side of the line. A guard point is met only by a row that reached the comparison.

Any free-form `run` closure, including `action({ run })` and match handlers, may contain hidden branches and constructions. Declared guards still have coverage measurements, but `measures.constructions` is `undetermined`, so the specification cannot be certified. The same holds for a comparison inside `rules` that Chisel cannot draw a line from.

## Postconditions and dependencies

A behavior can state what it ensures of its answer, and declare the outside world it needs:

```ts
const findMember = c.behavior("find-member", {
  input, result, effects,
  dependencies: { now: c.dependency(c.instant()), lookup: c.dependency(c.string(), c.boolean()) },
  ensures: clause => [
    clause.when("a found member is the one asked for", ["found"], (asked, answer) =>
      asked.id.$gt(0).$and(answer.id.$eq(asked.id)),
    ),
  ],
});
```

Every answer an example writes, the model produces or a conformance subject returns is held to the clauses, and a comparison of the input with a constant draws a border. Clause names must be distinct, and `check` says of every part of every rule how much of it the checker can read (`derivable`, `exact match`, `always holds`, `never holds` or `runtime only`) and which answer cases no clause states anything about. Example rows stand in for value dependencies with `with: { now: ... }` (`generate` writes one on every row it offers, the placeholder of the dependency's type under what the row it moved from writes, so a generated row runs as it is pasted), and a specification stands in for function dependencies with `fakes: [fake(findMember, "lookup", [["m-1", true]], { otherwise: false })]`. An action reads a value dependency in a guard condition through the second argument of its `guards` builder, `action("future only", { guards: (request, deps) => [deps.now.$lt(request.at).$else(...)], run: ... })`: the condition is evaluated against the stand-in a row writes with `with`, and the comparison is measured like any other (here, a border on `deps.now − @case.at`). Function dependencies stay out of conditions. A function dependency can be another behavior, `dependencies: { stock: dependency(checkStockExamples) }`: a fake table for it is then held to that behavior's `ensures` (a row that breaks one is an error) and to its recorded rows (a row answering differently from one is a warning).

`check` now enforces feasible pairs of classes as obligations (`measures.pairs`), and retains the older reached counts in `pairs` for display, over the same classes the report lists (including those guard thresholds draw, and leaving excluded classes out), and `check --json` writes the whole report as one document, described by the closed JSON Schema in [`schema/report.schema.json`](schema/report.schema.json) (published as `@toiroakr/chisel/report.schema.json`). The arms, rules, and comparisons measures retain their availability and weakening metadata; pairs record each obligation and constructions record each proof; every border point, arm, way, and pair carries a stable `obligationId`; `incompleteness` lists the rows that were not observed (not run for want of a stand-in, or not come back); and `sources` names the spec file each report's `source` refers to. `schemaVersion` is raised only when a field is removed or renamed.

## One model, several behaviors

Behaviors that work on one record can share its model as their input: `input: Report` in each of them, so a state added to `Report` reaches every behavior at once. Each of them is then asked about every field of every state, including fields its answer never turns on. `disregards` says which, per input case like `cases`, with `$default` for every case not written; `r => [r]` disregards a whole case:

```ts
export const approve = c.behavior("approve", {
  input: Report,
  result, effects,
  disregards: { submitted: r => [r.lines, r.urgent], $default: r => [r] },
});

c.implement(approve, {
  cases: {
    submitted: c.action("approve within the limit", {
      guards: r => [r.amount.$lte(r.limit).$else(refuse("over the limit"))],
      run: approved,
    }),
    $default: c.action("refuse unless submitted", { run: refuse("not submitted") }),
  },
});
```

A disregarded field draws no classes of its type, no invariant borders and no borders an `ensures` clause draws on it, so `generate` offers no row that only moves it; where a guard or a `match` reads it, it keeps the classes the guard draws or its own classes, since the arms turn on them. Every input case is still owed its row, guards still draw their borders and arms from the whole input, and an invariant that leaves a disregarded field empty is still a model error. Rows keep the whole record, so `c.test` hands production code what it takes. `check` holds the claim: it moves the disregarded fields of an answered row, each element of an array and each entry of a record on its own, through every combination of their other classes and of the invariant border points they would have owed (`IN (> 0)` for an `int().min(0)` at 0), smallest first, runs the model on each and fails the row on the first answer that changes, naming the fields it moved (`approve disregards @submitted.urgent, but its answer changed when @submitted.urgent was true`). A row with more than 255 combinations the input can hold, or more than 4096 candidates before those it cannot hold are left out, is not tried (the limits are the caller's: `c.check(specification, { disregards: { combinations, candidates } })`, or `chisel check --disregard-combinations <n> --disregard-candidates <n>`); it is listed in `incompleteness` as `disregards not checked` and leaves the verdict `undetermined`. `cases.$default` decides every case `cases` leaves out; it is one decision, so its arms and ways are listed once and owed wherever one of its cases can reach them, a `c.todo` there leaves each of its cases pending, and a `$default` beside cases that decide every case is refused. An input case cannot be named `$default`. [`examples/expense-report/`](examples/expense-report/) writes three behaviors over one five-state model both ways.

## One reducer for runtime and exhaustive checking

For a finite command domain, `machine` uses one expression for both runtime state updates and exhaustive reachability checking. Commands emitted by a transition run through that same reducer in order. The returned state is yours to persist wherever you choose. Import the execution API from `@toiroakr/chisel`; put verification properties in a separate module importing `@toiroakr/chisel/verification`. This keeps invariant definitions, model checking, TLA+ translation, and `tla-ts` out of the production import graph. The optional `/runtime` subpath is an alias of the root, which also exports the behavior runtime described above; the previous combined API is available from `/full`.

```ts
import * as c from "@toiroakr/chisel";

const State = c.int().min(0).max(2);
const Command = c.enum(["go", "finish"] as const);
export const workflow = c.machine("two steps", {
  state: State,
  command: Command,
  initial: [0],
  update: (state, command) => ({
    state: c.choose(state.$lt(2), state.$plus(1), state),
    commands: c.choose(command.$eq("go"), ["finish" as const], [] as const),
  }),
});

c.runMachine(workflow, 0, "go"); // { state: 2, steps: [go: 0→1, finish: 1→2] }
```

In a separate `workflow.spec.ts` file used by CI:

```ts
import { invariant, specifyMachine, checkMachine } from "@toiroakr/chisel/verification";
import { workflow } from "./workflow.js";

export const specification = specifyMachine(workflow, {
  invariants: [invariant<number>("at most two", state => state.$lte(2))],
});
checkMachine(specification); // { status: "held", states: 3, transitions: 6 }
```

[`examples/order-machine.ts`](examples/order-machine.ts) shows a typed order workflow with `submit`, internal `allocate`, and `receive` commands. [`examples/order-machine.spec.ts`](examples/order-machine.spec.ts) declares its invariant and transition property. `runMachine` returns each intermediate step, while `checkMachine` checks every command from every reachable state. A receipt before issuance or beyond the ordered quantity intentionally leaves the state unchanged; the invariant checks state safety rather than command acceptance.

`requires` in `specifyMachine` states, per command, the states and commands in which the command is meant to change the state (`requires: { allocate: order => order.phase.$eq("approved") }`). `checkMachine` is `broken` when a step changes the state although its precondition is false, or leaves the state unchanged although it holds, and the counterexample is the shortest command sequence that reaches such a step. A command without an entry is not held to one.

`columns` in `specifyMachine` (`columns: ["phase"]`) names the state fields that tell the rows of a table apart. Then `checkMachine` adds `matrix` to its report: for each value of the columns reached and each command, whether the command `changes` the state (`always`, `sometimes` or `never`, over every reachable state that shares those column values) and, where `requires` has an entry, whether its `precondition` holds. `model-check` prints it, and `--json` carries it. For the order workflow, `receive` with one unit in `phase=issued` reads `changes sometimes, precondition sometimes`, since it takes effect only while the ordered quantity has room. A cell no run reached, such as one cut off by `maxCommands`, reads `unknown` rather than `never`. The table lists each command as it is invoked from a state, so a state that exists only between a command and the commands it emits (`approved` in the order workflow) has no row; the precondition of an emitted command is still checked at every step. A `sometimes` that you expected to be `always` or `never` is a row to read. Columns are always chosen by you: a state field with many values (a counter, an id) would give one row per value.

A command that writes to something outside the machine returns `effects` instead of `state`. Each `c.effect(name, stateAfter)` names a write and the state the machine is in once it has succeeded; the state after the command is the one after the last effect, and with no effects the state is unchanged. The expression stays pure: the effect only says what the state would be.

```ts
update: (state, command) => ({
  effects: [
    c.effect("writeLabel", { ...state, label: "in-progress" }),
    c.effect("runScript", { ...state, migrated: true }),
    c.effect("writeLabel", { ...state, label: "checkpoint" }),
  ],
}),
```

`checkMachine` explores both outcomes of every effect. A failed effect stops the command, drops the commands it would have emitted and leaves the state as it was before that effect, so the writes before it stay. Where a failure should leave something else, write it: `c.effect("runScript", after, { failure: state })` rolls the whole command back. Invariants, transition properties and preconditions are held on every outcome, the states a failure leaves are reachable states from which every command is explored (so an invariant such as "a half-finished deploy always has a label `resolve` accepts" is held there too), and a counterexample names the effect that failed (`... failed after runScript failed`). These properties are held on the state each outcome ends in, not on the state between two effects of one command that went on to fail (see `crashes` below), and the checker does not say whether a sequence of commands eventually converges. A command that stopped at a failed effect may have written nothing yet, so a precondition that held is not held against it for leaving the state unchanged. `runMachine(machine, state, command, { fails: effect => effect.name === "runScript" })` follows the machine with the effects you say failed, and each step lists what `performed`; `chisel run-machine ... --fail runScript` does the same. `maxOutcomes` bounds the outcomes explored for one command (default 1000). The TLA+ translation makes each effect a choice between its success and its failure, and `--engine tla` and `prove-machine` read effects the same way.

A process can also die between two effects, and then no failure handling runs. `specifyMachine(machine, { crashes: true })` makes `checkMachine` explore a death before the first effect of each command and after each effect. The state the death leaves is a reachable state from which every command is explored, a death skips the failure handling (a `failure` state names what a failed effect leaves, not what a death leaves, so the writes of the effects already done stay), a death after the last effect loses the commands the command would have emitted, and the commands still queued behind it die with the process, so the state a death leaves is where the next command starts. Take a checkout that reserves stock and then charges the customer, each effect rolling the whole command back when it fails:

```ts
import * as c from "@toiroakr/chisel";
import { invariant, specifyMachine, checkMachine } from "@toiroakr/chisel/verification";

const checkout = c.machine("checkout", {
  state: c.object({ reserved: c.boolean(), charged: c.boolean() }),
  command: c.enum(["checkout"]), initial: [{ reserved: false, charged: false }],
  update: state => ({
    effects: [
      c.effect("reserve", { reserved: true, charged: state.charged }, { failure: state }),
      c.effect("charge", { reserved: true, charged: true }, { failure: state }),
    ],
  }),
});
const leak = invariant("a reservation is never left unpaid", state => state.reserved.$eq(false).$or(state.charged.$eq(true)));
checkMachine(specifyMachine(checkout, { invariants: [leak] }));                       // held
checkMachine(specifyMachine(checkout, { invariants: [leak], crashes: true }));       // broken: checkout died after effect 1 (reserve)
```

A command without effects has no point to die at, and a command that stopped by dying is held to its precondition as a command that stopped at a failed effect is. `runMachine` takes `dies: point => point.completed === 1` to follow such a run, and `chisel run-machine ... --die-after 1` does the same. In TLA+ a death is one more outcome of the command, so `--engine tla` and `prove-machine` read it too.

### Running a machine in production

`runMachine` only follows the machine; `driveMachine` runs it. The transition that `checkMachine`, `model-check` and `prove-machine` read decides each next effect, and the `perform` you pass makes the outside world reach the state the effect names, so production code holds no second copy of the order of the steps or of what a failure leaves:

```ts
const { state, failures } = await c.driveMachine(deploy, current, { type: "create", name: "User" }, {
  perform: async effect => { await reconcile(effect.before, effect.after); },
});
```

`perform` gets the effect's name, its index and command, the state before it and the state it is to leave. When it returns, the effect succeeded; when it throws or rejects, the effect failed, and the command ends in the effect's failure state and drops the commands it would have emitted, exactly the outcome `checkMachine` explored. The error is listed in `failures` instead of thrown. `perform` may return `{ commands }`: what it observed, run as commands after those the transition emitted. Every command of the domain is explored in every reachable state, so these are checked like any other. A transition still cannot call a dependency; what reaches outside the machine is an effect.

Two runs of one flow can also work on the same state at once. `checkInterleavings(specification, { copies: [commandA, commandB] })` runs one copy per command against a single shared state. A copy reads the state when it starts a command, then performs that command's effects one step at a time, and every order in which the steps of the copies interleave is explored. An effect writes only the fields it changes from what its copy last saw (or the fields `writes: ["stock", "a"]` names, which must be fields of the state) onto the state as it is by then, so a write computed from a stale read overwrites what another copy wrote since, and `c.effect(name, after, { ifUnchanged: true })` applies only if nothing was written since the copy read the state, otherwise the copy ends `refused` with the shared state unchanged. Take two customers buying the last unit of a stock, each copy reading the stock and then writing it with its own flag:

```ts
const shop = c.machine("shop", {
  state: c.object({ stock: c.int().min(0).max(1), a: c.boolean(), b: c.boolean() }),
  command: c.variants("type", { buy: c.object({ customer: c.enum(["a", "b"]) }) }),
  initial: [{ stock: 1, a: false, b: false }],
  update: (state, command) => ({
    effects: c.choose(state.stock.$gte(1), [
      c.effect("take", {
        stock: state.stock.$minus(1),
        a: c.choose(command.customer.$eq("a"), true, state.a),
        b: c.choose(command.customer.$eq("b"), true, state.b),
      }, { ifUnchanged: true }),                                 // drop the option to see the lost update
    ], []),
  }),
});
const once = invariant("the last unit is sold once", state => state.a.$eq(false).$or(state.b.$eq(false)));
const specification = specifyMachine(shop, { invariants: [once] });
checkInterleavings(specification, { copies: [{ type: "buy", customer: "a" }, { type: "buy", customer: "b" }] });
// held; terminals: finished/refused, refused/finished, and the sequential finished/finished
```

Without `ifUnchanged` both copies read a stock of 1 and both write, the report is `broken`, and the counterexample lists the order of the steps (`read`, `read`, `write`, `write`, each with its `copy`). The report's `terminals` list how each copy ended and the state left, so a claim such as "one copy always ends refused when they overlap" can be read off it. A command that declares a state instead of effects reads and writes in one step. `maxCopies` (default 2) and `maxStates` keep the search bounded and leave the result `undetermined` when exceeded, and failures and process deaths are not combined with interleavings. `checkInterleavingsTla` (and `chisel model-check --engine tla`) checks the same invariants and transition properties with each copy as a process of the TLA+ model; it needs a state that is an object, reports `undetermined` for a command that emits commands, and does not list the terminals. Declaring `interleavings: { copies: [...], starts?, maxCopies? }` in `specifyMachine` makes `chisel model-check` check them too, as `<name> (interleavings)`; the copies and starts are checked against the schemas where they are declared.

When the code you ship is an existing implementation, not a machine, the machine you check and the code can drift apart. `replayMachine(machine, subject)` (a specification works too) runs the model's transitions against the code. After the shortest command sequence to every state the machine reaches it replays each command, one command at a time from a `reset`, so the transitions that only come back to a state already seen are run as well, and after every command it reads the code's state back and compares it with the machine's using `deepEqual`. The subject is three functions, with the external parts of the code faked by the caller:

```ts
let store, service;
const subject = {
  reset: state => { store = fakeStore(state); service = new OrderService(store); },
  run: async (command, faults) => {
    for (const fault of faults) store.inject(fault); // e.g. fail the effect `markPaid`, or die after one effect
    await (command.type === "pay" ? service.pay() : service.ship());
  },
  read: () => service.snapshot(),
};
await replayMachine(orderFlow, subject); // { status: "passed", replayed: 6, states: 3 }
```

Where the machine and the code disagree the report is `failed` and `failure` holds the shortest sequence: `steps` with each command, the state the machine expected and the state the code answered, and a `reason` such as `After pay, ship, pay the machine reaches {"status":"shipped",...} but the subject reads {"status":"paid",...}`. A throw from `run` is accepted only where the machine does not run the command: where its `requires` precondition is false (a code that refuses with no change passes too, since the state is compared either way) or where an effect failed or the process died. Any other throw is a disagreement. An effect the machine fails, or a process death with `crashes: true`, is replayed too, and `faults` lists what to inject for the command (`{ kind: "fails", effect: "markPaid", index: 1, command, step: 0 }` or `{ kind: "dies", after: 1, command, step: 0 }`, where `step` is the place of `command` among the commands the run executed, 0 being the one replayed and the rest the ones it emitted); `faults: false` replays only the runs where every effect succeeds. A throw from `reset` or `read` reaches the caller, since the test harness is broken, not the code. `maxReplays` (default 10000), `maxStates`, `maxCommands`, `maxOutcomes` and `domainLimit` keep it bounded and leave the report `undetermined` when exceeded.


To fail CI unless the finite state check completes, export a machine and run:

```sh
chisel model-check examples/order-machine.spec.ts
chisel model-check examples/order-machine.spec.ts --engine tla
chisel tla examples/order-machine.spec.ts --output-dir ./model
chisel prove-machine examples/open-machine.spec.ts
chisel model-check examples/order-machine.spec.ts --json --max-states 10000
chisel run-machine examples/order-machine.ts --state '{"phase":"draft","ordered":2,"received":0}' --command '{"type":"submit"}'
```

`run-machine` returns the next state and all internal steps as JSON; it does not save them. When a module exports multiple machines, `--name` selects one for `run-machine`. `model-check` checks all exported machines by default and exits nonzero for `broken` or `undetermined`. Give multiple specifications of one machine distinct `name` values in `specifyMachine(machine, { name, invariants, transitions })` to select them with `--name`.

`--engine tla` also checks `requires` (a step whose precondition disagrees with whether it changes the state is a violation), and `prove-machine` proves each precondition as two obligations, one for "changes only if it holds" and one for "holds only if it changes". The matrix is produced by the native checker only. The proof compares object states field by field; any other value, such as a state that is a sum, an array field or a sum held in a field, is compared as a whole, which the prover may not discharge, so those obligations can stay `undetermined`.

`--engine tla` compiles the same expression-based update and invariant into a TLA+ `Step`, `Init`, and `Next` and checks them with `tla-ts`. It models emitted commands as a pending queue, so intermediate states are checked. `chisel tla` returns the module and config as JSON, or writes both `.tla` and `.cfg` files with `--output-dir`. TLA+ translation requires exhaustively enumerable state and command schemas and refuses unsupported operators instead of claiming a result. For open state spaces the native `model-check` remains the available finite reachability check when commands can be enumerated; its result is `undetermined` if exploration does not complete. Existing output files are preserved; pass `--force` to replace both files. Use `--max-commands` to choose the generated command budget.

`prove-machine` emits universal inductive obligations for the initial states, the state contract, emitted commands, invariants, and transition properties, then calls tla-ts's proof engine. It reports `proved` only if every obligation is discharged. This can prove some machines with open state and command domains (see [`examples/open-machine.spec.ts`](examples/open-machine.spec.ts)); unsupported schema and expression constructs, or obligations the prover cannot discharge, remain `undetermined`. A proof is over the TLA+ interpretation of the supported expression subset; `runMachine` is still the executable implementation. Use `model-check` for counterexample traces and `prove-machine` for inductive claims.

`checkMachine` enumerates command values from their schema, then explores reachable states breadth first. A failing invariant or invalid state reports `broken` with the shortest *initial command sequence among explored paths* reaching it. An open command domain or a `maxStates` / `domainLimit` / `maxCommands` cutoff reports `undetermined`. `held` means all commands from the declared finite domain and all reachable states were checked. No claim is made about commands outside the schema or states outside the declared initial states. The reducer is built from Chisel terms and expressions; external dependency calls are refused. Emitted commands are internal transitions, not I/O. `runMachine` validates input and output schemas, while the verification tools check invariants and transition properties; `maxCommands` bounds recursive emissions. This executes the checked model itself without a separate runtime implementation. `world` and `explore` below remain useful when input domains cannot be enumerated, but their successful walks are samples.

## Invariants a world keeps

Examples show that each behavior answers as its rows say. Some properties hold of a record only because the guards of several operations keep them together, and no single guard says so: a purchase order never receives more than it ordered because receiving checks what is open and changing the quantity checks what is received. Leave out either check and every example of each operation still passes, yet create, approve, issue, receive 3 of 8, then change the quantity to 2 reaches an order that has received more than it ordered.

A world declares the state its operations share, the states it starts from, the operations that move it, and what must hold of every state they reach, apart from the state's type: the type says what a state may hold, an invariant what a reachable state does hold.

```ts
type State = c.Infer<typeof Orders>;
type Order = State["orders"][number];

const purchasing = c.world("purchasing", {
  state: Orders,
  initial: [{ orders: [] }],
  operations: [
    { implementation: creating, input: (state, draw) => ({ kind: "create", id: `po-${state.orders.length + 1}`, quantity: draw.int(1, 10) }), next: appended },
    { implementation: receiving, input: (state, draw) => onOneOrder(draw.pick(state.orders), draw.int(1, 10)), next: replaced },
    { implementation: counting, state: "state" },
  ],
  invariants: [
    c.invariant<State>("no order receives more than it ordered", state => state.orders.$all(order => order.received.$lte(order.quantity))),
  ],
  transitions: [
    c.transition<State>("no order is lost", (before, after) => after.orders.$length().$gte(before.orders.$length())),
    c.transition<Order>("a closed order stays closed", { each: "orders", by: "id" }, (before, after) =>
      before.status.$ne("CLOSED").$or(after.status.$eq("CLOSED"))),
  ],
});

const report = await c.explore(purchasing, { runs: 100, steps: 20, seed: 1 });
```

An invariant is a condition over the state, written with the term operators as a guard is, or a model expression answering a boolean when it needs `fold`, `bind` or `plus` to say; a transition relates the state before an operation to the state after it, as an action property `[][P]_vars` does in TLA+: a step that leaves the state as it was is not held to it. With `each` and `by`, a transition relates one record before and after: the records at the field `each` names are paired by their field `by` (or, in a record, by their keys), as `\A id : orders[id] … orders'[id]` pairs them in TLA+, and each pair that changed is held to it; a record only before or only after is not paired, so that one disappearing is said by a transition over the whole state. Keys are compared as values, so a key may be an object, and a step whose state before or after holds two records with one key breaks the transition, since it cannot tell which record became which. `world` refuses a transition whose `each` reaches no array or record of the state, or whose `by` the records do not declare, since it would find no pair and hold of every walk. A property of how a state may change can also be an invariant of a state that keeps its history (received quantities that equal the receipts recorded); a transition says what needs the change itself: a status the state machine has no arrow to, a field that changed without a revision, a posted record that disappeared. An operation either acts on the whole world, taking the state at the input field `state` names and answering the next one at the same field of its result (an answer without the field, a refusal, leaves the state as it was; one holding it, even as `null`, is checked as the next state; `world` refuses an operation whose input or result declares the field in no case; a sum's discriminant may be the field, the state then naming the input case it is handed to) while the rest of its input is drawn at random, or acts on part of it, such as one order, with `input` building its input from the state through `draw` (`pick`, `int`, `value` of a schema; undefined when there is nothing to act on) and `next` placing the answer back in the world. Both are handed a copy of the state, which they may change in place: the state before the step is kept for the transitions.

`explore` first checks every invariant of every starting state (a broken one is reported with no steps and `runs: 0`), then starts each of `runs` walks from one of the starting states and takes `steps` operations chosen at random, so it only ever checks states the operations reach. At every state it checks the state's type and every invariant, and across every step every transition. The report is `held`; `broken` with the invariant broken (or the operation that failed) and the steps from the starting state, each with its operation, input and the state before and after; or `undetermined` with a reason when nothing broke but an operation never ran (it had nothing to act on in any state reached, or no step chose it) or was reached where a case is still `todo` or implemented outside Chisel, since the walks said nothing about it. It says how often each operation ran, moved the state, had nothing to act on (`skipped`) and could not be run (`pending`). `runs` and `steps` must be positive integers. A broken walk is shortened before it is reported: each step records the random numbers it drew, and steps are dropped one at a time while the rest, replayed with their numbers, still break the same invariant. The same `seed`, an integer from 0 to 4294967295 (1 by default), draws the same walks. A walk that finds nothing is evidence, not a proof, as sampled successes never are.

## Composition

`c.compose(name, [firstImplementation, secondImplementation, ...more])` connects behaviors the way Souther's `>->` does: of the cases a stage answers, those the next stage takes as input flow on to it, and the rest depart the main line and are answered as they are. It takes the stages' implementations and returns the composition's declaration and its implementation together.

```ts
const [quote, quoteImplementation] = c.compose("quote", [validateImplementation, priceImplementation]);
// validate: order -> valid | invalid, price: valid -> quoted
// quote: order -> invalid | quoted

export const quoteSpec = c.spec("quote", {
  examples: c.examples(quote, { /* rows expecting quoted, and invalid */ }),
  implementation: quoteImplementation,
});
```

A stage need not be written yet: `generate` prints an implementation whose every case is `c.todo(...)`, so a composition can be declared and given examples before any stage is implemented. A stage Chisel will never run, one answered by another service, is `c.external(behavior, reason)`: it is not `todo` (nothing is owed), and `check` reports the rows it cannot run (`incompleteness`, printed as rows it could not run) and leaves the verdict `undetermined`; the production code is checked with `c.test` instead.

The composition is an ordinary behavior, so a row may expect a case that departed at an early stage, which no stage's own examples can state. A stage may itself be a composition's implementation. The stages must name their cases by one discriminant; a case that would both depart one stage and be answered by a later one is refused, since a value cannot say which rail it is on. A case that flows on must not carry a field the next stage does not declare, at any depth (`validate answers @valid.total, which price does not declare`), nor a case of a nested sum the next stage does not declare (`@valid.payment@card`); and a field the next stage requires must always be answered (`validate does not always answer @valid.total, which price requires`), so leaving it out or answering it only as optional is refused too. The next stage would refuse such a value the first time the composition runs, so it is refused when composed instead. The same holds for types: every value the first stage may answer must be one the next stage takes, so a leaf of another type (`validate answers @valid.total as number, which price takes as integer`), a container of another kind, a literal of another value, a string where the next stage takes one literal, or an enum where it takes an enum missing one of its values is refused, while an integer where it takes a number, a decimal where it takes a decimal keeping at least as many digits, or a literal where it takes that literal's type, is accepted. Invariants are left to run time: an `int()` answered where the next stage takes `int().min(1)` composes. A literal is the exception, since it has only one value: it is parsed with the next stage's schema, so `literal(0)` answered there is refused. A departed case stays departed through the later stages. Effects and dependencies are united. A composition has no arms or ways of its own, so those measures are `not applicable` for it; its adequacy is measured over its own input and result cases.

## Conformance

`test` runs the human-approved examples against an external controller or service. This keeps model evaluation separate from checking whether infrastructure code conforms to the model. It returns the rows whose answer disagreed and the rows it skipped because their answer is still `todo`, so a test can choose whether an open answer may pass:

```ts
it("the order API answers as the examples say", async () => {
  expect(await c.test(cancelOrderExamples, callOrderApi)).toStrictEqual({
    failures: [],
    skipped: [], // drop this line to let rows still marked todo pass
  });
});
```

Before calling the subject, `test` validates the row's input, expected result and expected effects, including their invariants and any applicable `ensures` clause. The answer must also satisfy the result/effect schemas and `ensures`, even when the row expects only `caseOf(...)`. Invalid values and exceptions are reported as failures of that row. An unanswered row is skipped without calling the subject.

When each row needs its own database setup or transaction, the caller can own the loop:

```ts
for (const row of cancelOrderExamples.rows) {
  await arrangeDatabase(row.name);
  const outcome = await c.evaluate(cancelOrderExamples, row.name, callOrderApi);
  expect(outcome.status).toBe("passed");
}
```

`evaluate` returns `{ name, status: "passed", actual }`, `{ name, status: "failed", message, actual? }`, or `{ name, status: "skipped", reason }`. A failed row includes the answer when the subject returned one. A missing row name throws `SpecificationError` instead of silently skipping the test. `test` uses the same evaluation and keeps its existing `{ failures, skipped }` return shape. Neither function runs `with` or `fakes` against production code; the subject and the caller provide that environment.

## JSON boundaries and running a model

`decode(schema, jsonValue)` converts parsed JSON into domain values and validates them. `encode(schema, domainValue)` validates domain values and returns JSON-compatible data. Both return the same `{ success, value }` / `{ success: false, issues }` shape as `schema.parse`; neither parses or prints JSON text itself. `schema.parse` continues to accept domain values only.

```ts
const Amount = c.decimal(2);
const decoded = c.decode(Amount, "9007199254740993.25");
if (decoded.success) {
  const encoded = c.encode(Amount, decoded.value);
}
```

Decimals cross as strings, never JSON numbers, so large amounts retain their digits. Temporal values cross as strings accepted by their corresponding Temporal `from` method and are encoded with `toString()`. Objects, variants, arrays, records and optional fields are converted recursively. Unknown object keys remain errors. A missing optional object field stays missing, and `null` remains a value rather than meaning absence. An absent array element, absent record value or absent root cannot be encoded: silently replacing it with `null` or dropping a record entry would change the value. Non-finite numeric literals cannot be encoded either.

To run a model, export its implementation directly, or export a `spec` that contains it:

```sh
chisel run ./cancel-order.spec.ts --behavior cancel-order \
  --input '{"state":"paid","orderId":"o-1","paymentId":"p-1"}'
chisel check ./cancel-order.spec.ts --behavior cancel-order --json
chisel generate ./cancel-order.spec.ts --behavior cancel-order
```

`run` decodes the input using the behavior's schema, calls `perform` and prints `{ result, effects }` as JSON. Effects are returned as data. It requires `--input` and exactly one implementation; `--behavior` may be omitted when the loaded file exposes only one implementation. Aliases of the same implementation do not make it ambiguous. Dependencies must be supplied using `perform` from TypeScript, and external implementations cannot be run by this command. Invalid JSON, invalid input/output, an unknown behavior, a missing implementation or ambiguous implementations exit with status 1.

For all three commands, `--behavior` matches the name passed to `behavior(...)`, not the exported variable name. `check` and `generate` include every specification for that behavior. The file is still loaded as a TypeScript module before selection.

Composition verification also checks forwarded results against the next stage's input contract. If that inclusion cannot be proved, the pipeline remains undetermined even when each stage verifies independently. `reportDocument` returns JSON-compatible values, including string representations of int64 witnesses and counterexamples.

The [Souther comparison and design decisions](docs/souther-comparison.html) records the source revisions, changes and remaining differences.

## Publishing

The `release.yml` workflow publishes `@toiroakr/chisel` when a `v*` tag is pushed. The tag must match the version in `package.json` (for example, `v0.2.0` for version `0.2.0`). Publishing runs the type check, tests, and build through `prepublishOnly`. The workflow can also be rerun manually by selecting the release tag.

Configure an npm Trusted Publisher for `@toiroakr/chisel` with:

- Provider: GitHub Actions
- Organization or user: `toiroakr`
- Repository: `chisel`
- Workflow filename: `release.yml`
- Environment name: leave empty
- Permission: allow publishing

The workflow authenticates with OIDC and publishes provenance; no npm token secret is required.
