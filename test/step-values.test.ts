import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const emptyEffects = c.variants("kind", {});
const 集計 = c.behavior("集計", {
  input: c.variants("kind", { request: c.object({ product: c.boolean(), xs: c.array(c.int().min(1).max(9)).max(4) }) }),
  result: c.int(),
  effects: emptyEffects,
});
// The step is chosen once, by the request, and applied at each element.
const 選んだ段階 = c.implement(集計, {
  cases: {
    request: c.model("選んだ段階", input => ({
      result: c.fold(c.int().min(1).max(9), c.int(), input.xs, 1,
        c.choose(input.product.$eq(true),
          c.step<[number, number], number>((total, x) => c.arithmetic("multiply", total, x)),
          c.step<[number, number], number>((total, x) => c.arithmetic("add", total, x)))),
      effects: [],
    })),
  },
});
const row = (product: boolean, xs: number[], result: number) => ({ given: { kind: "request" as const, product, xs }, expect: { result, effects: [] } });

describe("a step handed over as a value (ADR-0127)", () => {
  it("is worked out once and applied at each element", async () => {
    await expect(c.perform(選んだ段階, { kind: "request", product: true, xs: [2, 3, 4] })).resolves.toStrictEqual({ result: 24, effects: [] });
    await expect(c.perform(選んだ段階, { kind: "request", product: false, xs: [2, 3, 4] })).resolves.toStrictEqual({ result: 10, effects: [] });
    await expect(c.perform(選んだ段階, { kind: "request", product: false, xs: [] })).resolves.toStrictEqual({ result: 1, effects: [] });
  });

  it("measures the choice of the step as a choice outside the walk", async () => {
    const report = await c.check(c.spec("集計", { examples: c.examples(集計, { 積: row(true, [2, 3], 6) }), implementation: 選んだ段階 }));

    expect(report.measures.rules.status === "complete" ? report.measures.rules.rules.map(rule => `${rule.way}: ${rule.status}`) : report.measures.rules).toStrictEqual([
      "$.product == true holds → otherwise: met",
      "$.product == true fails → otherwise: gap",
    ]);
  });

  it("owes each fold the step may be the rows that tell its rewrites apart", async () => {
    const report = await c.check(c.spec("集計", { examples: c.examples(集計, { 積: row(true, [2, 3], 6), 和: row(false, [5], 6) }), implementation: 選んだ段階 }));

    expect(report.walks.map(walk => [walk.rewrite, walk.status])).toStrictEqual([
      ["after one step", "told"],
      ["from the seed", "told"],
      ["after one step", "not told"],
      ["from the seed", "not told"],
    ]);
  });

  it("proves each step it may be against the accumulator's schema", () => {
    const digit = c.int().min(1).max(9);
    const 端 = c.behavior("端", { input: c.variants("kind", { request: c.object({ largest: c.boolean(), xs: c.array(digit) }) }), result: digit, effects: emptyEffects });
    const implementation = c.implement(端, {
      cases: {
        request: c.model("端", input => ({
          result: c.fold(digit, digit, input.xs, 5, c.choose(input.largest.$eq(true),
            c.step<[number, number], number>((kept, x) => c.choose(x.$gt(kept), x, kept)),
            c.step<[number, number], number>((kept, x) => c.choose(x.$lt(kept), x, kept)))),
          effects: [],
        })),
      },
    });
    expect(c.verify(implementation).status).toBe("verified");
  });

  it("refuses anything else handed over as the step", () => {
    expect(() => c.fold(c.int(), c.int(), [1], 0, 3 as never)).toThrow("A walk takes a step written in place, one made with step(), or a choice among such steps");
  });

  it("is handed to map as well", async () => {
    const 写す = c.behavior("写す", {
      input: c.variants("kind", { request: c.object({ double: c.boolean(), xs: c.array(c.int().min(0).max(9)) }) }),
      result: c.array(c.int()),
      effects: emptyEffects,
    });
    const implementation = c.implement(写す, {
      cases: {
        request: c.model("写す", input => ({
          result: c.map(c.int().min(0).max(9), c.int(), input.xs, c.choose(input.double.$eq(true), c.step<[number], number>(x => c.arithmetic("multiply", x, 2)), c.step<[number], number>(x => x))),
          effects: [],
        })),
      },
    });
    await expect(c.perform(implementation, { kind: "request", double: true, xs: [1, 2] })).resolves.toStrictEqual({ result: [2, 4], effects: [] });
    await expect(c.perform(implementation, { kind: "request", double: false, xs: [1, 2] })).resolves.toStrictEqual({ result: [1, 2], effects: [] });
  });
});
