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

The first version describes the domain vocabulary and the behavior boundary, not its implementation.

```ts
import { behavior, object, string, sum } from "chisel";

const Order = sum("state", {
  unpaid: object({ orderId: string("OrderId") }),
  paid: object({
    orderId: string("OrderId"),
    paymentId: string("PaymentId"),
  }),
});

const CancelResult = sum("type", {
  accepted: object({ orderId: string("OrderId") }),
  rejected: object({ reason: string("Reason") }),
});

const CancelEffect = sum("type", {
  refund: object({ paymentId: string("PaymentId") }),
  restock: object({ orderId: string("OrderId") }),
});

export const cancelOrder = behavior({
  name: "cancel-order",
  input: Order,
  result: CancelResult,
  effects: CancelEffect,
  dependsOn: ["refund", "restock"],
});
```

## 2. Generate unanswered examples

```sh
chisel generate ./cancel-order.spec.ts
```

Chisel emits TypeScript rows for every uncovered input variant, then for every class and border point no row stands in yet (see [Analysis](#analysis)).

```ts
export const cancelOrderExamples = examples(cancelOrder, [
  example(cancelOrder, "cancel-order: unpaid", {
    given: {
      state: "unpaid",
      orderId: "<OrderId>",
    },
    expect: unanswered(
      "Expected result for unpaid must be decided by a human",
    ),
  }),
  example(cancelOrder, "cancel-order: paid", {
    given: {
      state: "paid",
      orderId: "<OrderId>",
      paymentId: "<PaymentId>",
    },
    expect: unanswered(
      "Expected result for paid must be decided by a human",
    ),
  }),
]);
```

## 3. Fill expectations

A human replaces `unanswered()` with the expected result and effect trace.

```ts
example(cancelOrder, "cancel a paid order", {
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
});
```

Changing the data or behavior model makes stale examples fail to compile. Running `generate` again emits rows for newly introduced variants, classes and border points, each composed from an answered row with only the position in question moved.

## 4. Implement the model

Once expectations are known, `implement()` supplies the executable model.

```ts
const implementation = implement(cancelOrder, {
  cases: {
    unpaid: {
      kind: "decision",
      id: "cancel-unpaid",
      run: order => ({
        result: { type: "accepted", orderId: order.orderId },
        effects: [{ type: "restock", orderId: order.orderId }],
      }),
    },
    paid: {
      kind: "decision",
      id: "cancel-paid",
      run: order => ({
        result: { type: "accepted", orderId: order.orderId },
        effects: [
          { type: "refund", paymentId: order.paymentId },
          { type: "restock", orderId: order.orderId },
        ],
      }),
    },
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

export const cancellation = defineSpecification({
  name: "order cancellation",
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

- **Cases** of the input, result and effect sums. Evidence is graded: an input case is `specified` by a row, `executed` when the model ran on it and `verified` when the row held; a result or effect case is `specified`, `observed` or `verified`.
- **Classes** of each input position, derived from the types: an `optional` field is absent or present, a `boolean` true or false, a sum field one of its cases. A class an `eq`/`ne` invariant refuses is `excluded` and counted neither way. A position no rule draws a line through is `not derivable`, which is a fact about the model rather than a gap.
- **Borders** drawn by an invariant that compares a value or a `length` with a constant, with the four domain-testing points `ON`, `OFF`, `IN` and `OUT`. Outside an invariant nothing can be constructed, so `OFF` and `OUT` are excluded; `ON` and `IN` are owed a row. `integer`, lengths and instants have a neighbouring value; `number` and `string` do not, so their `OFF` point is not named. A point one bound owes is excluded when another bound refuses it, and bounds that leave nothing admitted (`$ >= 10` with `$ <= 5`) are reported as a model error rather than as gaps. A length is never negative, so a point that would lie below zero has no point there (`none: a length is never negative`) and no row is asked for at it, whether the border comes from an invariant or a guard.

```ts
const Line = object({
  quantity: integer().invariant(v => ge(v, 1)),
  unitPrice: integer().invariant(v => ge(v, 0)),
});
const Lines = array(Line).invariant(v => ge(length(v), 1));
```

- **Arms and rules** of a decision written with `rules`, and the borders and classes its guards draw. A guard compares with the same vocabulary as an invariant; its else is an ordinary result case, so a business rejection is data, not an exception:

```ts
const implementation = implement(checkout, {
  cases: {
    withItems: rules(
      "check stock, then confirm",
      cart => [
        guard(all(cart.lines, line => le(line.quantity, line.stock)), () => ({
          result: { type: "rejected", reason: "out of stock" },
          effects: [],
        })),
      ],
      cart => confirm(cart),
    ),
  },
});
```

  Every guard has a `holds` and an `else` arm, and every case of a `match` is an arm; each way through the guards is a rule. A guard comparing a position with a constant divides it into classes and owes all four border points; one comparing two positions draws its border on their difference. A guard point is met only by a row that reached the comparison.

A free-form `run` closure may contain branches Chisel cannot read, so its arms are reported as `not measured` and a specification with no gap is `undetermined` rather than `satisfied`. The same holds for a comparison inside `rules` that Chisel cannot draw a line from.

## Postconditions and dependencies

A behavior can state what it ensures of its answer, and declare the outside world it needs:

```ts
const findMember = behavior({
  name: "find-member",
  input, result, effects,
  requires: { now: dependency(instant()), lookup: dependency(string("MemberId"), boolean()) },
  ensures: clause => [
    clause.when("a found member is the one asked for", ["found"], (asked, answer) =>
      and(gt(asked.id, 0), eq(answer.id, asked.id)),
    ),
  ],
});
```

Every answer an example writes, the model produces or a conformance subject returns is held to the clauses, and a comparison of the input with a constant draws a border. Example rows stand in for value dependencies with `with: { now: ... }`, and a specification stands in for function dependencies with `fakes: [fake(findMember, "lookup", [["m-1", true]], { otherwise: false })]`.

`check` also counts the pairs of classes the rows reach (an observation, never an obligation), over the same classes the report lists (including those guard thresholds draw, and leaving excluded classes out), and `check --json` writes the whole report as one document.

## Conformance

`verifyConformance` runs the human-approved examples against an external controller or service. This keeps model evaluation separate from checking whether infrastructure code conforms to the model.
