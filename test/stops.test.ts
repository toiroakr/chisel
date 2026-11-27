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

  it("tells two temporal steps over the same operands apart by their unit", async () => {
    const 日付 = c.behavior("日付", {
      input: c.variants("kind", { request: c.object({ d: c.date(), n: c.int().min(0).max(2) }) }),
      result: c.object({ a: c.date(), b: c.date() }),
      effects: emptyEffects,
    });
    const 進める = c.implement(日付, {
      cases: { request: c.model("進める", (input: any) => ({ result: { a: c.plus(input.d, input.n, "days"), b: c.plus(input.d, input.n, "years") }, effects: [] })) },
    });
    const report = await c.check(c.spec("日付", { examples: c.examples(日付, {}), implementation: 進める }));

    expect(report.stops.map(stop => stop.at)).toStrictEqual(['plus($.d, $.n, "days")', 'plus($.d, $.n, "years")']);
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

describe("a signed 64-bit result", () => {
  const 足す = c.behavior("足す", {
    input: c.variants("kind", {
      small: c.object({ a: c.int64().min(0n).max(9n), b: c.int64().min(0n).max(9n) }),
      wide: c.object({ a: c.int64().min(0n), b: c.int64().min(0n) }),
    }),
    result: c.int64(),
    effects: emptyEffects,
  });
  const implementation = c.implement(足す, {
    cases: {
      small: c.model("小さい和", input => ({ result: c.arithmetic("add", input.a, input.b), effects: [] })),
      wide: c.model("広い和", input => ({ result: c.arithmetic("add", input.a, input.b), effects: [] })),
    },
  });

  it("completes where the bounds keep it within the range, and not where a sum may pass its end", async () => {
    const report = await c.check(c.spec("足す", { examples: c.examples(足す, {}), implementation }));
    expect(report.stops.map(stop => [stop.decision, stop.status === "never stops"])).toStrictEqual([["小さい和", true], ["広い和", false]]);
  });
});

describe("what keeps a division from stopping", () => {
  it("offers no invariant for a divide, which may stop on more than nought", async () => {
    const 割る = c.behavior("割る", {
      input: c.variants("kind", { request: c.object({ a: c.int64().min(0n).max(9n), b: c.int64().min(1n).max(3n) }) }),
      result: c.int64(),
      effects: emptyEffects,
    });
    const implementation = c.implement(割る, { cases: { request: c.model("割る", input => ({ result: c.arithmetic("divide", input.a, input.b), effects: [] })) } });
    const report = await c.check(c.spec("割る", { examples: c.examples(割る, {}), implementation }));

    expect(report.stops.map(stop => [stop.status, stop.keeping])).toStrictEqual([["may stop", undefined]]);
    // The divisor holds no nought, so it is the answer that is inexact where the run stops.
    const { a, b } = report.stops[0]!.input as { a: bigint; b: bigint };
    expect([b !== 0n, a % b !== 0n]).toStrictEqual([true, true]);
  });
});

describe("a pipeline of stages", () => {
  const 割る前 = c.behavior("割る前", {
    input: c.variants("状態", { 申込: c.object({ 合計: c.int().min(0).max(10), 人数: c.int().min(0).max(3) }) }),
    result: c.variants("結果", { 有効: c.object({ 合計: c.int().min(0).max(10), 人数: c.int().min(0).max(3) }) }),
    effects: emptyEffects,
  });
  const 割る後 = c.behavior("割る後", {
    input: c.variants("結果", { 有効: c.object({ 合計: c.int().min(0).max(10), 人数: c.int().min(0).max(3) }) }),
    result: c.variants("結果", { 見積: c.object({ 平均: c.rational() }) }),
    effects: emptyEffects,
  });
  const 前 = c.implement(割る前, { cases: { 申込: c.model("そのまま", input => ({ result: { 結果: "有効", 合計: input.合計, 人数: input.人数 }, effects: [] })) } });
  const 後 = c.implement(割る後, { cases: { 有効: c.model("平均を出す", input => ({ result: { 結果: "見積", 平均: c.quotient(input.合計, input.人数) }, effects: [] })) } });

  it("judges the steps of each stage, a stop of a later one left unresolved since the earlier stage may never hand that input on", async () => {
    const [composition, pipeline] = c.compose("割る", [前, 後]);
    const report = await c.check(c.spec("割る", { examples: c.examples(composition, {}), implementation: pipeline }));
    expect(report.stops.map(stop => [stop.decision, stop.at, stop.status])).toStrictEqual([["平均を出す", "quotient($.合計, $.人数)", "not resolved"]]);
    expect(report.verdict).not.toBe("satisfied");
  });
});
