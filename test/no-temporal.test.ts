import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { formatTypeScriptValue } from "../src/codegen.js";

const holder = globalThis as { Temporal?: unknown };
let saved: unknown;
beforeEach(() => {
  saved = holder.Temporal;
  delete holder.Temporal;
});
afterEach(() => {
  holder.Temporal = saved;
});

const shipping = c.behavior("shipping", {
  input: c.variants("kind", { order: c.object({ total: c.int().min(0), member: c.boolean() }) }),
  result: c.variants("fee", { free: c.object({}), paid: c.object({ amount: c.int() }) }),
  effects: c.variants("kind", {}),
});
const implementation = c.implement(shipping, {
  cases: {
    order: c.model("fee", input => ({
      result: c.choose(input.member.$eq(true).$or(input.total.$gte(5000)), { fee: "free" }, { fee: "paid", amount: 500 }),
      effects: [],
    })),
  },
});

describe("without a Temporal global", () => {
  it("performs, checks, generates, formats and decodes a behavior that holds no temporal value", async () => {
    expect(holder.Temporal).toBeUndefined();
    expect(await c.perform(implementation, { kind: "order", total: 100, member: false }))
      .toStrictEqual({ result: { fee: "paid", amount: 500 }, effects: [] });
    const report = await c.check(c.spec("shipping", {
      implementation,
      examples: c.examples(shipping, {
        member: { given: { kind: "order", total: 0, member: true }, expect: { result: { fee: "free" }, effects: [] } },
      }),
    }));
    expect(report.failures).toStrictEqual([]);
    const generated = c.generate(c.examples(shipping, {}), implementation);
    expect(generated.rows.length).toBeGreaterThan(0);
    expect(formatTypeScriptValue(generated.rows[0]!.given)).toContain("kind");
    expect(c.decode(shipping.input, { kind: "order", total: 1, member: false }).success).toBe(true);
  });

  it("says how to get Temporal where a temporal value is decoded", () => {
    expect(() => c.decode(c.date(), "2026-01-01")).toThrow(/Node\.js 26 or later, or install a Temporal polyfill/);
  });
});
