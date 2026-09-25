import {
  behavior,
  spec,
  example,
  examples,
  implement,
  literal,
  object,
  pending,
  string,
  variants,
} from "../src/index.js";

const OrderId = string("OrderId");
const PaymentId = string("PaymentId");
const ShipmentId = string("ShipmentId");

const Order = variants("state", {
  unpaid: object({ orderId: OrderId }),
  paid: object({ orderId: OrderId, paymentId: PaymentId }),
  preparing: object({ orderId: OrderId, paymentId: PaymentId }),
  shipped: object({ orderId: OrderId, shipmentId: ShipmentId }),
  cancelled: object({ orderId: OrderId }),
});

const CancelResult = variants("type", {
  accepted: object({
    order: object({
      state: literal("cancelled"),
      orderId: OrderId,
    }),
  }),
  rejected: object({ reason: string("CancelRejection") }),
});

const CancelEffect = variants("type", {
  refund: object({
    paymentId: PaymentId,
    idempotencyKey: string("IdempotencyKey"),
  }),
  restock: object({
    orderId: OrderId,
    idempotencyKey: string("IdempotencyKey"),
  }),
});

export const cancelOrder = behavior({
  name: "cancel-order",
  input: Order,
  result: CancelResult,
  effects: CancelEffect,
  dependsOn: ["refund", "restock"],
});

const implementation = implement(cancelOrder, {
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
    preparing: pending("Whether preparation can be cancelled is undecided"),
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
    refund: pending("Compensation after a successful refund is undecided"),
    restock: {
      execution: "outbox",
      idempotency: "required",
      compensation: "automatic",
    },
  },
});

const cancellationExamples = examples(cancelOrder, [
  example(cancelOrder, "cancel an unpaid order", {
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
  }),
  example(cancelOrder, "cancel a paid order", {
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
  }),
  example(cancelOrder, "reject a shipped order", {
    given: { state: "shipped", orderId: "o-3", shipmentId: "s-3" },
    expect: {
      result: { type: "rejected", reason: "already-shipped" },
      effects: [],
    },
  }),
  example(cancelOrder, "reject an already cancelled order", {
    given: { state: "cancelled", orderId: "o-4" },
    expect: {
      result: { type: "rejected", reason: "already-cancelled" },
      effects: [],
    },
  }),
]);

export const orderCancellation = spec({
  name: "order cancellation",
  examples: cancellationExamples,
  implementation,
});
