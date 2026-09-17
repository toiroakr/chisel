# Chisel

Chisel is an experimental TypeScript toolkit for growing an executable business specification from a coarse model and concrete examples.

It keeps four concerns connected:

- a closed runtime model that can also infer TypeScript types;
- explicit pending decisions that are allowed while exploring a domain;
- typed input, result, and effect examples;
- an adequacy report that can become a strict CI gate.

The model is intentionally value-first. TypeScript types are erased at runtime, so a type alias alone cannot tell a tool which variants still need examples.

## Example

```ts
import {
  behavior,
  defineSpecification,
  example,
  examples,
  object,
  pending,
  string,
  sum,
} from "chisel";

const Order = sum("state", {
  unpaid: object({ orderId: string("OrderId") }),
  paid: object({
    orderId: string("OrderId"),
    paymentId: string("PaymentId"),
  }),
  preparing: object({
    orderId: string("OrderId"),
    paymentId: string("PaymentId"),
  }),
});

const Result = sum("type", {
  accepted: object({ orderId: string("OrderId") }),
  rejected: object({ reason: string("Reason") }),
});

const Effect = sum("type", {
  refund: object({ paymentId: string("PaymentId") }),
  restock: object({ orderId: string("OrderId") }),
});

const cancelOrder = behavior({
  name: "cancel-order",
  input: Order,
  result: Result,
  effects: Effect,
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
    preparing: pending("Cancellation policy is undecided"),
  },
  controls: {
    refund: pending("Refund compensation is undecided"),
    restock: {
      execution: "outbox",
      idempotency: "required",
      compensation: "automatic",
    },
  },
});

const rows = examples(cancelOrder, [
  example<typeof cancelOrder>("cancel an unpaid order", {
    given: { state: "unpaid", orderId: "o-1" },
    expect: {
      result: { type: "accepted", orderId: "o-1" },
      effects: [{ type: "restock", orderId: "o-1" }],
    },
  }),
]);

export const cancellation = defineSpecification({
  name: "order cancellation",
  examples: rows,
});
```

Adding another `Order` variant makes `cases` fail to compile until the new decision is implemented or marked as pending. Changing a result or effect shape makes stale examples fail to compile.

## Commands

```sh
npm install
npm run check
npm run example:check
npm run example:generate
npm run example:strict
```

The CLI can load a TypeScript specification directly:

```sh
npx chisel check ./order.spec.ts
npx chisel check ./order.spec.ts --strict
npx chisel generate ./order.spec.ts
```

`check` always prints the current state. With `--strict`, incomplete specifications exit with status 1. `generate` emits placeholder inputs for uncovered input variants while leaving the expected result for a human to decide.

## Adequacy

The current analyzer checks:

- coverage of every input variant;
- coverage of every result variant;
- coverage of every effect variant;
- pending behavior decisions;
- missing or pending control policies;
- model/example mismatches.

Free-form TypeScript inside a decision can contain branches that Chisel cannot discover. The report therefore marks internal decision coverage as `undetermined` instead of claiming that line or branch coverage proves semantic completeness. A future rule/partition API can make those decisions enumerable without requiring a TypeScript compiler plugin.

## Conformance

`verifyConformance` runs the same examples against an external implementation. This separates two questions:

1. does the executable model agree with the human-approved examples?
2. does the controller, database, or service implementation conform to that model?

The expected effect list is part of the contract, so ordering, idempotency keys, and compensation-related decisions can be reviewed rather than hidden inside infrastructure code.
