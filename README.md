# Chisel

Chisel is an experimental TypeScript toolkit for growing an executable business specification from a closed data model, generated examples, and human-provided expectations.

The workflow is deliberately ordered:

```text
declare data and behavior
→ generate unanswered examples
→ let a human fill expected results
→ refine data and behavior
→ implement an executable model
→ check the model against the examples
```

## 1. Declare data and behavior

The examples import Chisel as a namespace, `import * as c from "chisel"`, the way zod and valibot are used as `z` and `v`; the names below are written without the prefix.

The first version describes the domain vocabulary and the behavior boundary, not its implementation. `variants(discriminant, { case: object(...) })` declares a discriminated union: a value is exactly one of the named cases, told apart by the discriminant field (Souther calls this a sum type). An `object` holds exactly the fields it declares: a value carrying another key is refused, not trimmed, so a model answering with a stray field fails `check` instead of passing it.

```ts
import * as c from "chisel";

const Order = c.variants("state", {
  unpaid: c.object({ orderId: c.string("OrderId") }),
  paid: c.object({
    orderId: c.string("OrderId"),
    paymentId: c.string("PaymentId"),
  }),
});

const CancelResult = c.variants("type", {
  accepted: c.object({ orderId: c.string("OrderId") }),
  rejected: c.object({ reason: c.string("Reason") }),
});

const CancelEffect = c.variants("type", {
  refund: c.object({ paymentId: c.string("PaymentId") }),
  restock: c.object({ orderId: c.string("OrderId") }),
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
      orderId: "<OrderId>",
    },
    expect: c.todo(
      "Expected result for unpaid must be decided by a human",
    ),
  },
  "cancel-order: paid": {
    given: {
      state: "paid",
      orderId: "<OrderId>",
      paymentId: "<PaymentId>",
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

To build a row outside the table (a helper, or a row shared by several specifications), `example(behavior, { given, expect })` types it by the behavior, and it is put in a table under a name: `examples(cancelOrder, { "paid": paidRow })`. Rows are kept in the order written, except that names which are plain integers (`"1"`, `"100"`) come first, as JavaScript orders such keys.

Changing the data or behavior model makes stale examples fail to compile. Running `generate` again emits rows for newly introduced variants, classes and border points, each composed from an answered row with only the position in question moved.

## 4. Implement the model

Once expectations are known, `implement()` supplies the executable model: one `action(name, { guards?, run })` per input case. `run` computes the answer; `guards` (below) lists the conditions checked before it, each with the answer to give when it fails. The name is how reports refer to the action.

```ts
const implementation = c.implement(cancelOrder, {
  cases: {
    unpaid: c.action("cancel-unpaid", {
      run: order => ({
        result: { type: "accepted", orderId: order.orderId },
        effects: [{ type: "restock", orderId: order.orderId }],
      }),
    }),
    paid: c.action("cancel-paid", {
      run: order => ({
        result: { type: "accepted", orderId: order.orderId },
        effects: [
          { type: "refund", paymentId: order.paymentId },
          { type: "restock", orderId: order.orderId },
        ],
      }),
    }),
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

## Commands

Chisel requires Node.js 26 or later and uses its built-in Temporal API.

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

`check` reports the current state without failing by default. `--strict` exits with status 1 while examples are unanswered, input/result/effect variants, classes or border points are uncovered, the implementation is absent or pending, control policies are incomplete, or the implementation disagrees with an example. It never fails because a measure could not be made: that is reported as an `undetermined` verdict instead.

## Progressive demo

The [hotel reservation demo](./examples/progressive-demo/README.md) runs the complete declaration → generation → human answer → refinement → implementation sequence.

```sh
npm run demo
```

## Analysis

The analyzer follows the example-adequacy model of [Souther](https://github.com/souther-lang/souther). It measures what the model itself states and nothing else:

- **Cases** of the input, result and effect variants. Evidence is graded: an input case is `specified` by a row, `executed` when the model ran on it and `verified` when the row held; a result or effect case is `specified`, `observed` or `verified`.
- **Classes** of each input position, derived from the types: an `optional` field is absent or present, a `boolean` true or false, a `variants` field one of its cases. A class an `eq`/`ne` invariant refuses is `excluded` and counted neither way. The same holds for an input case an invariant on the input sum refuses (`variants(...).invariant(v => ne(v.state, "archived"))`), and a rule on a field every case shares draws its border under each case. A position no rule draws a line through is `not derivable`, which is a fact about the model rather than a gap.
- **Borders** drawn by an invariant that compares a value or a `length` with a constant, with the four domain-testing points `ON`, `OFF`, `IN` and `OUT`. Outside an invariant nothing can be constructed, so `OFF` and `OUT` are excluded; `ON` and `IN` are owed a row. `int`, lengths and instants have a neighbouring value; `number` and `string` do not, so their `OFF` point is not named. A point one bound owes is excluded when another bound refuses it, and bounds that leave nothing admitted (`$ >= 10` with `$ <= 5`) are reported as a model error rather than as gaps. A length is never negative, so a point that would lie below zero has no point there (`none: a length is never negative`) and no row is asked for at it, whether the border comes from an invariant or a guard.

```ts
const Line = c.object({
  quantity: c.int().invariant(v => c.gte(v, 1)),
  unitPrice: c.int().invariant(v => c.gte(v, 0)),
});
const Lines = c.array(Line).invariant(v => c.gte(c.length(v), 1));
```

- **Arms and rules** of an action's `guards`, and the borders and classes its guards draw. A guard compares with the same vocabulary as an invariant; its else is an ordinary result case, so a business rejection is data, not an exception:

```ts
const implementation = c.implement(checkout, {
  cases: {
    withItems: c.action("check stock, then confirm", {
      guards: cart => [
        c.guard(c.all(cart.lines, line => c.lte(line.quantity, line.stock)), () => ({
          result: { type: "rejected", reason: "out of stock" },
          effects: [],
        })),
      ],
      run: cart => confirm(cart),
    }),
  },
});
```

  Every guard has a `holds` and an `else` arm, and every case of a `match` is an arm (a `match` that leaves out a case of the `variants` it matches on, or names one it does not have, fails to compile); each way through the guards is a rule. A way or an arm no row took is a gap only when some row could take it: where the conditions it passes contradict each other or the invariants of the values they read (`$.x >= 10` holds and `$.x >= 5` fails), no row is owed; where a condition Chisel cannot read (`all`/`any`) shares a value with another, it is undecided, which leaves the verdict `undetermined` rather than `not_satisfied`. Both are counted under their reason instead of listed. A guard border point is settled the same way, from the conditions a row has passed before it reaches the comparison. A guard comparing a position with a constant divides it into classes and owes all four border points; one comparing two positions with an order draws its border on their difference, while an equality between two positions draws none, since its `holds` and `else` arms already ask for a row on each side of the line. A guard point is met only by a row that reached the comparison.

A free-form `run` closure may contain branches Chisel cannot read, so its arms are reported as `not measured` and a specification with no gap is `undetermined` rather than `satisfied`. The same holds for a comparison inside `rules` that Chisel cannot draw a line from.

## Postconditions and dependencies

A behavior can state what it ensures of its answer, and declare the outside world it needs:

```ts
const findMember = c.behavior("find-member", {
  input, result, effects,
  requires: { now: c.dependency(c.instant()), lookup: c.dependency(c.string("MemberId"), c.boolean()) },
  ensures: clause => [
    clause.when("a found member is the one asked for", ["found"], (asked, answer) =>
      c.and(c.gt(asked.id, 0), c.eq(answer.id, asked.id)),
    ),
  ],
});
```

Every answer an example writes, the model produces or a conformance subject returns is held to the clauses, and a comparison of the input with a constant draws a border. Clause names must be distinct, and `check` says of every part of every rule how much of it the checker can read (`derivable`, `exact match`, `always holds`, `never holds` or `runtime only`) and which answer cases no clause states anything about. Example rows stand in for value dependencies with `with: { now: ... }`, and a specification stands in for function dependencies with `fakes: [fake(findMember, "lookup", [["m-1", true]], { otherwise: false })]`. An action reads a value dependency in a guard condition through the second argument of its `guards` builder, `action("future only", { guards: (request, deps) => [guard(lt(deps.now, request.at), ...)], run: ... })`: the condition is evaluated against the stand-in a row writes with `with`, and the comparison is measured like any other (here, a border on `deps.now − @case.at`). Function dependencies stay out of conditions. A function dependency can be another behavior, `requires: { stock: dependency(checkStockExamples) }`: a fake table for it is then held to that behavior's `ensures` (a row that breaks one is an error) and to its recorded rows (a row answering differently from one is a warning).

`check` also counts the pairs of classes the rows reach (an observation, never an obligation), over the same classes the report lists (including those guard thresholds draw, and leaving excluded classes out), and `check --json` writes the whole report as one document, described by the closed JSON Schema in [`schema/report.schema.json`](schema/report.schema.json) (published as `chisel/report.schema.json`). Every measure carries `status`, `reason` exactly where it is `unavailable`, and `weakening` exactly where something weakened it; every border point, arm and way carries a stable `obligationId`; `incompleteness` lists the rows that were not observed (not run for want of a stand-in, or not come back); and `sources` names the spec file each report's `source` refers to. `schemaVersion` is raised only when a field is removed or renamed.

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

The composition is an ordinary behavior, so a row may expect a case that departed at an early stage, which no stage's own examples can state. A stage may itself be a composition's implementation. The stages must name their cases by one discriminant; a case that would both depart one stage and be answered by a later one is refused, since a value cannot say which rail it is on. A case that flows on must not carry a field the next stage does not declare, at any depth (`validate answers @valid.total, which price does not declare`), nor a case of a nested sum the next stage does not declare (`@valid.payment@card`); and a field the next stage requires must always be answered (`validate does not always answer @valid.total, which price requires`), so leaving it out or answering it only as optional is refused too. The next stage would refuse such a value the first time the composition runs, so it is refused when composed instead. Only a record answered where the next stage takes an object is left to run time, since its keys are known only then. A departed case stays departed through the later stages. Effects and dependencies are united. A composition has no arms or ways of its own, so those measures are `not applicable` for it; its adequacy is measured over its own input and result cases.

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
