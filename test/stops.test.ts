import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { reportDocument } from "../src/index.js";
import { validate } from "./support/json-schema.js";
import schema from "../schema/report.schema.json" with { type: "json" };

const emptyEffects = c.variants("kind", {});

describe("a stop is said of the step the run stops at", () => {
  it("names a division a run may stop at, with an input that stops there and what to declare", async () => {
    const 平均 = c.behavior("平均", {
      input: c.variants("kind", { request: c.object({ total: c.int().min(0).max(10), count: c.int().min(0).max(3) }) }),
      result: c.rational(),
      effects: emptyEffects,
    });
    const 割る = c.implement(平均, {
      cases: { request: c.model("割る", input => ({ result: c.quotient(input.total, input.count), effects: [] })) },
    });
    const report = await c.check(c.spec("平均", { examples: c.examples(平均, {}), implementation: 割る }));

    expect(report.stops.map(({ input, ...stop }) => ({ ...stop, stopsAtNought: (input as { count: number }).count === 0 }))).toStrictEqual([
      {
        decision: "割る",
        at: "quotient($.total, $.count)",
        status: "may stop",
        reason: "この入力の実行はquotient($.total, $.count)で止まる",
        keeping: "$.countに .refine(v => v.$ne(0)) を宣言すれば、quotient($.total, $.count)で止まる実行はなくなる",
        stopsAtNought: true,
      },
    ]);
    expect(report.verdict).toBe("not_satisfied");
    expect(validate(schema as never, reportDocument([report], { id: "x", name: "x" }))).toStrictEqual([]);
  });

  it("shows a step never stops where every valid input was run", async () => {
    const 平均 = c.behavior("平均", {
      input: c.variants("kind", { request: c.object({ total: c.int().min(0).max(10), count: c.int().min(1).max(3) }) }),
      result: c.rational(),
      effects: emptyEffects,
    });
    const 割る = c.implement(平均, {
      cases: { request: c.model("割る", input => ({ result: c.quotient(input.total, input.count), effects: [] })) },
    });
    const report = await c.check(c.spec("平均", { examples: c.examples(平均, {}), implementation: 割る }));

    expect(report.stops.map(stop => [stop.at, stop.status])).toStrictEqual([["quotient($.total, $.count)", "never stops"]]);
  });

  it("shows a sum never stops where the bounds of what it reads keep it exact, and finds an input that takes an unbounded one past it", async () => {
    const 足す = c.behavior("足す", {
      input: c.variants("kind", {
        bounded: c.object({ a: c.int().min(0).max(1000000), b: c.int().min(0).max(1000000), note: c.string() }),
        open: c.object({ a: c.int(), b: c.int(), note: c.string() }),
      }),
      result: c.int(),
      effects: emptyEffects,
    });
    const implementation = c.implement(足す, {
      cases: {
        bounded: c.model("和", input => ({ result: c.arithmetic("add", input.a, input.b), effects: [] })),
        open: c.model("開いた和", input => ({ result: c.arithmetic("add", input.a, input.b), effects: [] })),
      },
    });
    const report = await c.check(c.spec("足す", { examples: c.examples(足す, {}), implementation }));

    expect(report.stops.map(stop => [stop.decision, stop.status])).toStrictEqual([
      ["和", "never stops"],
      ["開いた和", "may stop"],
    ]);
  });
});

describe("what keeps a division from stopping", () => {
  it("offers no invariant for a divide, which may stop on more than nought", async () => {
    const 割る = c.behavior("割る", {
      input: c.variants("kind", { request: c.object({ a: c.int64().min(0n).max(9n), b: c.int64().min(0n).max(3n) }) }),
      result: c.int64(),
      effects: emptyEffects,
    });
    const implementation = c.implement(割る, { cases: { request: c.model("割る", input => ({ result: c.arithmetic("divide", input.a, input.b), effects: [] })) } });
    const report = await c.check(c.spec("割る", { examples: c.examples(割る, {}), implementation }));

    expect(report.stops.map(stop => [stop.status, stop.keeping])).toStrictEqual([["may stop", undefined]]);
  });
});
