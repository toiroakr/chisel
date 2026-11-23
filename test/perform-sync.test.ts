import { describe, expect, it } from "vitest";
import * as c from "../src/runtime.js";
import { traceSync } from "../src/behavior.js";

const fee = c.behavior("fee", {
  input: c.variants("kind", { order: c.object({ total: c.int().min(0), member: c.boolean() }), gift: c.object({}) }),
  result: c.variants("fee", { free: c.object({}), paid: c.object({ amount: c.int() }) }),
  effects: c.variants("kind", {}),
  dependencies: { threshold: c.dependency(c.int()) },
});

const implementation = c.implement(fee, {
  cases: {
    order: c.model("order fee", (input, deps) => ({
      result: c.choose(input.member.$eq(true).$or(input.total.$gte(deps.threshold)), { fee: "free" }, { fee: "paid", amount: 500 }),
      effects: [],
    })),
    gift: c.todo("not decided"),
  },
});

describe("performSync", () => {
  it("answers what perform answers, without a promise", async () => {
    const input = { kind: "order", total: 100, member: false } as const;
    const answer = c.performSync(implementation, input, { threshold: 50 });
    expect(answer).toStrictEqual({ result: { fee: "free" }, effects: [] });
    expect(answer).toStrictEqual(await c.perform(implementation, input, { threshold: 50 }));
    expect(c.performSync(implementation, input, { threshold: 5000 })).toStrictEqual({ result: { fee: "paid", amount: 500 }, effects: [] });
  });

  it("refuses an input the schema refuses and a case still to do, as perform does", () => {
    expect(() => c.performSync(implementation, { kind: "order", total: -1, member: false }, { threshold: 1 })).toThrow(c.SpecificationError);
    expect(() => c.performSync(implementation, { kind: "gift" }, { threshold: 1 })).toThrow(c.TodoDecision);
  });

  it("refuses a dependency answering a promise, which only perform awaits", async () => {
    const lookup = c.behavior("lookup", {
      input: c.variants("kind", { ask: c.object({ key: c.string() }) }),
      result: c.int(),
      effects: c.variants("kind", {}),
      dependencies: { find: c.dependency(c.string(), c.int()) },
    });
    const found = c.implement(lookup, { cases: { ask: c.model("ask", (input, deps) => ({ result: c.call(deps.find, input.key), effects: [] })) } });
    const input = { kind: "ask", key: "a" } as const;
    expect(c.performSync(found, input, { find: () => 1 })).toStrictEqual({ result: 1, effects: [] });
    const supplied = { find: (() => Promise.resolve(1)) as unknown as (key: string) => number };
    expect(() => c.performSync(found, input, supplied)).toThrow(/answered a promise; use perform/);
    expect(await c.perform(found, input, supplied)).toStrictEqual({ result: 1, effects: [] });
  });

  it("stops at the first dependency answering a promise, so a later dependency is never called", async () => {
    const pay = c.behavior("pay", {
      input: c.variants("kind", { go: c.object({ key: c.string() }) }),
      result: c.int(),
      effects: c.variants("kind", {}),
      dependencies: { check: c.dependency(c.string(), c.int()), charge: c.dependency(c.string(), c.int()) },
    });
    const paid = c.implement(pay, {
      cases: { go: c.model("go", (input, deps) => ({ result: c.arithmetic("add", c.call(deps.check, input.key), c.call(deps.charge, input.key)), effects: [] })) },
    });
    const charged: string[] = [];
    const supplied = { check: (() => Promise.resolve(1)) as unknown as (key: string) => number, charge: (key: string) => (charged.push(key), 2) };
    expect(() => c.performSync(paid, { kind: "go", key: "a" }, supplied)).toThrow(/answered a promise; use perform/);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(charged).toStrictEqual([]);
  });

  it("ends a trace at the first dependency answering a promise, so a later dependency is never called", async () => {
    const pay = c.behavior("pay", {
      input: c.variants("kind", { go: c.object({ key: c.string() }) }),
      result: c.int(),
      effects: c.variants("kind", {}),
      dependencies: { check: c.dependency(c.string(), c.int()), charge: c.dependency(c.string(), c.int()) },
    });
    const paid = c.implement(pay, {
      cases: { go: c.model("go", (input, deps) => ({ result: c.arithmetic("add", c.call(deps.check, input.key), c.call(deps.charge, input.key)), effects: [] })) },
    });
    const charged: string[] = [];
    const supplied = { check: (() => Promise.resolve(1)) as unknown as (key: string) => number, charge: (key: string) => (charged.push(key), 2) };
    const traced = traceSync(paid, { kind: "go", key: "a" }, supplied);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect([charged, traced.ended, traced.error]).toStrictEqual([[], undefined, undefined]);
  });
});
