import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const stock = c.behavior("stock", {
  input: c.variants("kind", { ask: c.object({ item: c.string() }) }),
  result: c.variants("outcome", { available: c.object({ quantity: c.int().min(1) }), missing: c.object({}) }),
  effects: c.variants("type", {}),
});
const order = c.behavior("order", {
  input: c.variants("kind", { place: c.object({ items: c.array(c.string()) }) }),
  result: c.variants("outcome", { placed: c.object({ quantities: c.array(c.int()) }), short: c.object({}) }),
  effects: c.variants("type", {}),
  requires: { stock: c.dependency(stock) },
});
type Answer = c.Execution<c.BehaviorResult<typeof order>, c.BehaviorEffect<typeof order>>;
// Asks the stock of every item, one after another, and is short when one is missing.
const placing = c.implement(order, {
  cases: {
    place: c.model("place what is in stock", (request, deps) => {
      const Asked = c.object({ quantity: c.int() });
      const quantities = c.map(c.string(), Asked, request.items, item =>
        c.matchValue(stock.result, c.call(deps.stock, { kind: "ask", item }), {
          available: answer => ({ quantity: answer.quantity }),
          missing: () => ({ quantity: 0 }),
        }),
      );
      return c.bind(c.array(Asked), quantities, asked =>
        c.choose<Answer>(
          asked.$all(one => one.quantity.$gt(0)),
          { result: { outcome: "placed", quantities: c.map(Asked, c.int(), asked, one => one.quantity) }, effects: [] },
          { result: { outcome: "short" }, effects: [] },
        ),
      );
    }),
  },
});

const later = <T>(value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), 1));

describe("a dependency that answers a promise", () => {
  it("is awaited, and its answer is read as a value would be", async () => {
    const shelf: Record<string, number> = { apple: 3, pear: 5 };
    const execution = await c.perform(placing, { kind: "place", items: ["apple", "pear"] }, {
      stock: async ({ item }) => (await later(shelf[item])) ? { outcome: "available", quantity: shelf[item]! } : { outcome: "missing" },
    });
    expect(execution).toStrictEqual({ result: { outcome: "placed", quantities: [3, 5] }, effects: [] });
    const short = await c.perform(placing, { kind: "place", items: ["apple", "plum"] }, {
      stock: async ({ item }) => (await later(shelf[item])) ? { outcome: "available", quantity: shelf[item]! } : { outcome: "missing" },
    });
    expect(short.result).toStrictEqual({ outcome: "short" });
  });

  it("is called in the order the model reads, each after the one before has settled", async () => {
    const calls: string[] = [];
    await c.perform(placing, { kind: "place", items: ["a", "b", "c"] }, {
      stock: async ({ item }) => {
        calls.push(`ask ${item}`);
        await later(undefined);
        calls.push(`answered ${item}`);
        return { outcome: "available", quantity: 1 };
      },
    });
    expect(calls).toStrictEqual(["ask a", "answered a", "ask b", "answered b", "ask c", "answered c"]);
  });

  it("may be mixed with one that answers a value", async () => {
    let call = 0;
    const execution = await c.perform(placing, { kind: "place", items: ["a", "b"] }, {
      stock: () => (++call === 1 ? later({ outcome: "available" as const, quantity: 2 }) : { outcome: "available" as const, quantity: 4 }),
    });
    expect(execution.result).toStrictEqual({ outcome: "placed", quantities: [2, 4] });
  });

  it("is checked against the dependency's contract once it settles", async () => {
    await expect(c.perform(placing, { kind: "place", items: ["a"] }, {
      stock: async () => ({ outcome: "available", quantity: 0 }),
    })).rejects.toThrow(/Invalid dependency stock result/);
  });

  it("fails the run with the error it rejects with", async () => {
    const failure = new Error("the database is down");
    await expect(c.perform(placing, { kind: "place", items: ["a"] }, { stock: () => Promise.reject(failure) })).rejects.toBe(failure);
  });

  it("is held to the ensures of the behavior it stands for", async () => {
    const bounded = c.behavior("bounded", {
      input: c.variants("kind", { ask: c.object({ at: c.int() }) }),
      result: c.int(),
      effects: c.variants("type", {}),
      ensures: clause => [clause.always("at least what was asked", (asked, value) => value.$gte(asked.at))],
    });
    const asking = c.behavior("asking", {
      input: c.variants("kind", { go: c.object({ at: c.int() }) }),
      result: c.int(),
      effects: c.variants("type", {}),
      requires: { bounded: c.dependency(bounded) },
    });
    const implementation = c.implement(asking, {
      cases: { go: c.model("ask", (request, deps) => ({ result: c.call(deps.bounded, { kind: "ask", at: request.at }), effects: [] })) },
    });
    expect((await c.perform(implementation, { kind: "go", at: 2 }, { bounded: async ({ at }) => at + 1 })).result).toBe(3);
    await expect(c.perform(implementation, { kind: "go", at: 2 }, { bounded: async ({ at }) => at - 1 })).rejects.toThrow(
      "Dependency bounded breaks ensures at least what was asked",
    );
  });

  it("leaves checking a specification with fakes as it was", async () => {
    const specification = c.spec("order", {
      examples: c.examples(order, {
        "places what is in stock": { given: { kind: "place", items: ["apple"] }, expect: { result: { outcome: "placed", quantities: [3] }, effects: [] } },
        "is short of a missing item": { given: { kind: "place", items: ["plum"] }, expect: { result: { outcome: "short" }, effects: [] } },
      }),
      implementation: placing,
      fakes: [c.fake(order, "stock", [[{ kind: "ask", item: "apple" }, { outcome: "available", quantity: 3 }]], { otherwise: { outcome: "missing" } })],
    });
    expect((await c.check(specification)).failures).toStrictEqual([]);
  });
});
