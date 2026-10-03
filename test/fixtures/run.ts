import * as c from "../../src/index.js";

export const invoice = c.behavior("invoice", {
  input: c.variants("type", { request: c.object({ amount: c.decimal(2), date: c.date() }) }),
  result: c.variants("type", { invoice: c.object({ amount: c.decimal(2), date: c.date() }) }),
  effects: c.variants("type", { issued: c.object({ date: c.date() }) }),
});

export const implementation = c.implement(invoice, {
  cases: {
    request: c.action("issue", {
      run: input => ({ result: { type: "invoice", amount: input.amount, date: input.date }, effects: [{ type: "issued", date: input.date }] }),
    }),
  },
  controls: { issued: { execution: "direct", idempotency: "not-required", compensation: "none" } },
});

export const declaration = c.behavior("unimplemented", {
  input: c.variants("type", { query: c.object({}) }), result: c.int(), effects: c.variants("type", {}),
});
