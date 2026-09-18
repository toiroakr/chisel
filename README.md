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

Chisel emits TypeScript rows for every uncovered input variant.

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

Changing the data or behavior model makes stale examples fail to compile. Running `generate` again emits rows for newly introduced variants.

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

`check` reports the current state without failing by default. `--strict` exits with status 1 while examples are unanswered, input/result/effect variants are uncovered, the implementation is absent or pending, control policies are incomplete, or the implementation disagrees with an example.

## Progressive demo

The [hotel reservation demo](./examples/progressive-demo/README.md) runs the complete declaration → generation → human answer → refinement → implementation sequence.

```sh
npm run demo
```

## Analysis boundary

The current analyzer measures declared input, result, and effect variants. Free-form TypeScript inside a decision may contain branches Chisel cannot discover, so internal decision coverage remains `undetermined`. A future rule and partition API can make those branches enumerable.

## Conformance

`verifyConformance` runs the human-approved examples against an external controller or service. This keeps model evaluation separate from checking whether infrastructure code conforms to the model.
