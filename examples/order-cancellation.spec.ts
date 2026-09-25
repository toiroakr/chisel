import * as c from "../src/index.js";

const OrderId = c.string("OrderId");
const PaymentId = c.string("PaymentId");
const ShipmentId = c.string("ShipmentId");

const Order = c.variants("state", {
  unpaid: c.object({ orderId: OrderId }),
  paid: c.object({ orderId: OrderId, paymentId: PaymentId }),
  preparing: c.object({ orderId: OrderId, paymentId: PaymentId }),
  shipped: c.object({ orderId: OrderId, shipmentId: ShipmentId }),
  cancelled: c.object({ orderId: OrderId }),
});

const CancelResult = c.variants("type", {
  accepted: c.object({
    order: c.object({
      state: c.literal("cancelled"),
      orderId: OrderId,
    }),
  }),
  rejected: c.object({ reason: c.string("CancelRejection") }),
});

const CancelEffect = c.variants("type", {
  refund: c.object({
    paymentId: PaymentId,
    idempotencyKey: c.string("IdempotencyKey"),
  }),
  restock: c.object({
    orderId: OrderId,
    idempotencyKey: c.string("IdempotencyKey"),
  }),
});

export const cancelOrder = c.behavior("cancel-order", {
  input: Order,
  result: CancelResult,
  effects: CancelEffect,
  dependsOn: ["refund", "restock"],
});

const implementation = c.implement(cancelOrder, {
  cases: {
    unpaid: {
      kind: "decision",
      id: "cancel-unpaid",
      run: order => ({
        result: {
          type: "accepted",
          order: { state: "cancelled", orderId: order.orderId },
        },
        effects: [
          {
            type: "restock",
            orderId: order.orderId,
            idempotencyKey: `cancel:${order.orderId}:restock`,
          },
        ],
      }),
    },
    paid: {
      kind: "decision",
      id: "cancel-paid",
      dependsOn: ["refund", "restock"],
      run: order => ({
        result: {
          type: "accepted",
          order: { state: "cancelled", orderId: order.orderId },
        },
        effects: [
          {
            type: "refund",
            paymentId: order.paymentId,
            idempotencyKey: `cancel:${order.orderId}:refund`,
          },
          {
            type: "restock",
            orderId: order.orderId,
            idempotencyKey: `cancel:${order.orderId}:restock`,
          },
        ],
      }),
    },
    preparing: c.todo("Whether preparation can be cancelled is undecided"),
    shipped: {
      kind: "decision",
      id: "reject-shipped",
      run: () => ({
        result: { type: "rejected", reason: "already-shipped" },
        effects: [],
      }),
    },
    cancelled: {
      kind: "decision",
      id: "reject-cancelled",
      run: () => ({
        result: { type: "rejected", reason: "already-cancelled" },
        effects: [],
      }),
    },
  },
  controls: {
    refund: c.todo("Compensation after a successful refund is undecided"),
    restock: {
      execution: "outbox",
      idempotency: "required",
      compensation: "automatic",
    },
  },
});

const cancellationExamples = c.examples(cancelOrder, {
  "cancel an unpaid order": {
    given: { state: "unpaid", orderId: "o-1" },
    expect: {
      result: {
        type: "accepted",
        order: { state: "cancelled", orderId: "o-1" },
      },
      effects: [
        {
          type: "restock",
          orderId: "o-1",
          idempotencyKey: "cancel:o-1:restock",
        },
      ],
    },
  },
  "cancel a paid order": {
    given: { state: "paid", orderId: "o-2", paymentId: "p-2" },
    expect: {
      result: {
        type: "accepted",
        order: { state: "cancelled", orderId: "o-2" },
      },
      effects: [
        {
          type: "refund",
          paymentId: "p-2",
          idempotencyKey: "cancel:o-2:refund",
        },
        {
          type: "restock",
          orderId: "o-2",
          idempotencyKey: "cancel:o-2:restock",
        },
      ],
    },
  },
  "reject a shipped order": {
    given: { state: "shipped", orderId: "o-3", shipmentId: "s-3" },
    expect: {
      result: { type: "rejected", reason: "already-shipped" },
      effects: [],
    },
  },
  "reject an already cancelled order": {
    given: { state: "cancelled", orderId: "o-4" },
    expect: {
      result: { type: "rejected", reason: "already-cancelled" },
      effects: [],
    },
  },
});

export const orderCancellation = c.spec("order cancellation", {
  examples: cancellationExamples,
  implementation,
});
