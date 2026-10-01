import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  action,
  array,
  behavior,
  check,
  compose,
  decimal,
  dependency,
  examples,
  external,
  formatTypeScriptValue,
  generate,
  implement,
  int,
  number,
  object,
  SpecificationError,
  spec,
  test as conformance,
  variants,
} from "../src/index.js";
import type { AnySchema } from "../src/index.js";

const d = (text: string) => new Decimal(text);

describe("decimal", () => {
  it("parses a Decimal with at most its scale of digits after the point", () => {
    const 単価 = decimal(2);

    expect(単価.parse(d("999.99"))).toStrictEqual({ success: true, value: d("999.99") });
    expect(単価.parse(d("1000"))).toStrictEqual({ success: true, value: d("1000") });
    expect(単価.parse(d("999.999"))).toStrictEqual({
      success: false,
      issues: [{ path: "$", message: "Expected a Decimal with at most 2 decimal places" }],
    });
    expect(単価.parse(999.99)).toStrictEqual({ success: false, issues: [{ path: "$", message: "Expected a Decimal" }] });
    expect(単価.parse(d("NaN")).success).toBe(false);
  });

  it("keeps two values apart however large they are", () => {
    expect(decimal(2).parse(d("80000000000000.01"))).toStrictEqual({ success: true, value: d("80000000000000.01") });
    expect(d("80000000000000.01").equals(d("80000000000000.02"))).toBe(false);
  });

  it("reads -0 as 0, so it matches a row writing 0", () => {
    expect(decimal(2).parse(d("-0"))).toStrictEqual({ success: true, value: d("0") });
  });

  it("reads -0 as a 0 of the copy of decimal.js the value was built with", () => {
    const Other = Decimal.clone();
    expect(decimal(2).parse(new Other("-0"))).toStrictEqual({ success: true, value: new Other("0") });
  });

  it("refuses a scale that is not a whole number of digits", () => {
    expect(() => decimal(-1)).toThrow(new Error("decimal takes a whole number of digits, not -1"));
    expect(() => decimal(1.5)).toThrow(new Error("decimal takes a whole number of digits, not 1.5"));
  });

  it("takes the shorthands of the ordered types", () => {
    const 重さ = decimal(3).min(d("0.5"));

    expect(重さ.parse(d("0.5")).success).toBe(true);
    expect(重さ.parse(d("0.499")).success).toBe(false);
  });

  it("stands in with a value inside a range narrower than one, wherever the rule is written", () => {
    expect(decimal(2).gt(d("0.5")).lt(d("1")).placeholder()).toStrictEqual(d("0.51"));
    expect(
      object({ 割合: decimal(2) })
        .refine(v => v.割合.$gt(d("0.5")).$and(v.割合.$lt(d("1"))))
        .placeholder(),
    ).toStrictEqual({ 割合: d("0.51") });
    expect(
      variants("状態", { 見積: object({ 割合: decimal(2) }) })
        .refine(v => v.割合.$gt(d("0.5")).$and(v.割合.$lt(d("1"))))
        .placeholder(),
    ).toStrictEqual({ 状態: "見積", 割合: d("0.51") });
  });

  it("is written as decimal.js builds it", () => {
    expect(formatTypeScriptValue({ 合計: d("999.99") })).toBe('{\n  合計: new Decimal("999.99"),\n}');
  });
});

const 出荷 = variants("状態", { 依頼: object({ 重さ: decimal(3) }) });
const 出荷する = behavior("出荷する", {
  input: 出荷,
  result: variants("結果", { 出荷した: object({}), 少なすぎる: object({}) }),
  effects: variants("種類", {}),
});
const 出荷した = { result: { 結果: "出荷した" as const }, effects: [] };
const 少なすぎる = { result: { 結果: "少なすぎる" as const }, effects: [] };
const 出荷の実装 = (bound: Decimal) =>
  implement(出荷する, {
    cases: {
      依頼: action("一定の重さから出荷できる", {
        guards: r => [r.重さ.$gte(bound).$else(() => 少なすぎる)],
        run: () => 出荷した,
      }),
    },
  });
const 重さの行 = (rows: Readonly<Record<string, readonly [string, boolean]>>) =>
  examples(
    出荷する,
    Object.fromEntries(
      Object.entries(rows).map(([name, [weight, shipped]]) => [
        name,
        { given: { 状態: "依頼" as const, 重さ: d(weight) }, expect: shipped ? 出荷した : 少なすぎる },
      ]),
    ),
  );
const pointsOf = async (bound: Decimal, rows: Readonly<Record<string, readonly [string, boolean]>>) => {
  const report = await check(spec("出荷する", { examples: 重さの行(rows), implementation: 出荷の実装(bound) }));
  return report.borders.flatMap(border => border.points.map(point => `${point.role} ${point.status} ${point.relation}`));
};

describe("a guard on a decimal", () => {
  it("owes a row at the value one digit past the bound", async () => {
    expect(await pointsOf(d("0.5"), { ちょうど: ["0.5", true], 重い: ["2", true], 軽い: ["0.1", false] })).toStrictEqual([
      "ON met = 0.5",
      "OFF gap = 0.499",
      "IN met > 0.5",
      "OUT met < 0.499",
    ]);
  });

  it("offers the row at that value", () => {
    const { rows } = generate(重さの行({ ちょうど: ["0.5", true] }), 出荷の実装(d("0.5")));

    expect(rows.map(row => row.given)).toContainEqual({ 状態: "依頼", 重さ: d("0.499") });
  });

  it("draws a bound written off its grid on the grid", async () => {
    expect(
      await pointsOf(d("0.0004"), { ちょうど: ["0.001", true], 重い: ["2", true], ゼロ: ["0", false], マイナス: ["-1", false] }),
    ).toStrictEqual(["ON met = 0.001", "OFF met = 0", "IN met > 0.001", "OUT met < 0"]);
  });
});

describe("a guard comparing a decimal with a value off its grid", () => {
  const 支払う = behavior("支払う", {
    input: variants("方法", { カード: object({ 合計: decimal(2) }) }),
    result: variants("結果", { 請求した: object({}) }),
    effects: variants("種類", {}),
  });
  const 請求した = { result: { 結果: "請求した" as const }, effects: [] };
  const 実装 = (guard: "$eq" | "$ne") => () =>
    implement(支払う, {
      cases: {
        カード: action("半端な額", {
          guards: r => [r.合計[guard](d("0.005")).$else(() => 請求した)],
          run: () => 請求した,
        }),
      },
    });

  it("is refused by implement for an equality, which no decimal of its scale meets", () => {
    expect(実装("$eq")).toThrow(
      new SpecificationError("guard in 半端な額 compares $.合計 with 0.005, which no decimal(2) holds: $.合計 == 0.005"),
    );
  });

  it("is refused by implement for an inequality, which every decimal of its scale meets", () => {
    expect(実装("$ne")).toThrow(
      new SpecificationError("guard in 半端な額 compares $.合計 with 0.005, which no decimal(2) holds: $.合計 != 0.005"),
    );
  });

  it("is refused by implement for an expression of decimals none of which holds the bound", () => {
    expect(() =>
      implement(支払う, {
        cases: {
          カード: action("半端な額", {
            guards: r => [r.合計.$plus(r.合計).$eq(d("0.005")).$else(() => 請求した)],
            run: () => 請求した,
          }),
        },
      }),
    ).toThrow(
      new SpecificationError(
        "guard in 半端な額 compares 2 * $.合計 with 0.005, which no decimal(2) holds: 2 * $.合計 == 0.005",
      ),
    );
  });
});

describe("a comparison of a decimal with a value off its grid outside the guards", () => {
  const 半端 = d("0.005");

  it("is refused as an invariant of the decimal itself", () => {
    expect(() => decimal(2).refine(v => v.$eq(半端))).toThrow(
      new Error("refine compares $ with 0.005, which no decimal(2) holds: $ == 0.005"),
    );
  });

  it("is refused as an invariant an object writes on its field", () => {
    expect(() => object({ 合計: decimal(2) }).refine(v => v.合計.$ne(半端))).toThrow(
      new Error("refine compares $.合計 with 0.005, which no decimal(2) holds: $.合計 != 0.005"),
    );
  });

  it("is refused for an expression of decimals, whose values lie on the grid of the finest of them", () => {
    expect(() => object({ 甲: decimal(2), 乙: decimal(2) }).refine(v => v.甲.$plus(v.乙).$eq(半端))).toThrow(
      new Error("refine compares $.甲 + $.乙 with 0.005, which no decimal(2) holds: $.甲 + $.乙 == 0.005"),
    );
  });

  it("is refused for an expression whose constant leaves the bound off its grid", () => {
    expect(() => object({ 甲: decimal(2) }).refine(v => v.甲.$plus(半端).$eq(d("0.01")))).toThrow(
      new Error("refine compares $.甲 + 0.005 with 0.01, which no decimal(2) holds: $.甲 + 0.005 == 0.01"),
    );
  });

  it("is kept for an expression one of whose decimals is fine enough to hold the bound", () => {
    expect(() =>
      object({ 甲: decimal(2), 乙: decimal(3) }).refine(v => v.甲.$plus(v.乙).$eq(半端)),
    ).not.toThrow();
  });

  it("is refused on each element of an array", () => {
    expect(() =>
      object({ 明細: array(object({ 合計: decimal(2) })) }).refine(v => v.明細.$all(line => line.合計.$eq(半端))),
    ).toThrow(new Error("refine compares $.明細[].合計 with 0.005, which no decimal(2) holds: $.明細[].合計 == 0.005"));
  });

  it("is refused in what a behavior ensures", () => {
    expect(() =>
      behavior("値引きする", {
        input: variants("状態", { 申請: object({ 合計: decimal(2) }) }),
        result: object({ 合計: decimal(2) }),
        effects: variants("種類", {}),
        ensures: clause => [
          clause.always("半端にしない", (input, value) => value.合計.$lte(input.合計).$and(value.合計.$ne(半端))),
        ],
      }),
    ).toThrow(
      new SpecificationError("Ensures 半端にしない compares value.合計 with 0.005, which no decimal(2) holds: value.合計 != 0.005"),
    );
  });
});

const 承認する = behavior("承認する", {
  input: variants("状態", { 申請中: object({ 金額: decimal(2), 上限: decimal(2) }) }),
  result: variants("結果", { 承認した: object({}), 上限を超える: object({}) }),
  effects: variants("種類", {}),
});
const 承認した = { result: { 結果: "承認した" as const }, effects: [] };
const 上限を超える = { result: { 結果: "上限を超える" as const }, effects: [] };
const 承認の実装 = implement(承認する, {
  cases: {
    申請中: action("上限まで承認できる", {
      guards: r => [r.金額.$lte(r.上限).$else(() => 上限を超える)],
      run: () => 承認した,
    }),
  },
});

describe("a guard comparing two decimals", () => {
  it("draws its border on their difference, one cent past the limit", async () => {
    const { rows } = generate(
      examples(承認する, {
        ちょうど: { given: { 状態: "申請中", 金額: d("10000"), 上限: d("10000") }, expect: 承認した },
      }),
      承認の実装,
    );
    expect(rows.map(row => row.given)).toContainEqual({ 状態: "申請中", 金額: d("10000.01"), 上限: d("10000") });

    const report = await check(
      spec("承認する", {
        examples: examples(承認する, {
          ちょうど: { given: { 状態: "申請中", 金額: d("10000"), 上限: d("10000") }, expect: 承認した },
          "1 セント超える": { given: { 状態: "申請中", 金額: d("10000.01"), 上限: d("10000") }, expect: 上限を超える },
          下回る: { given: { 状態: "申請中", 金額: d("9000.5"), 上限: d("10000") }, expect: 承認した },
          大きく超える: { given: { 状態: "申請中", 金額: d("20000.3"), 上限: d("10000") }, expect: 上限を超える },
        }),
        implementation: 承認の実装,
      }),
    );
    expect(report.borders.flatMap(border => border.points.map(point => `${point.role} ${point.status} ${point.relation}`))).toStrictEqual([
      "ON met = 0.00",
      "OFF met = 0.01",
      "IN met < 0.00",
      "OUT met > 0.01",
    ]);
  });

  it("moves the finer of two scales", () => {
    const 数える = behavior("数える", {
      input: variants("状態", { 見積: object({ 予算: decimal(1), 金額: decimal(2) }) }),
      result: variants("結果", { 足りる: object({}), 足りない: object({}) }),
      effects: variants("種類", {}),
    });
    const 足りる = { result: { 結果: "足りる" as const }, effects: [] };
    const { rows, notComposed } = generate(
      examples(数える, { ちょうど: { given: { 状態: "見積", 予算: d("6"), 金額: d("6") }, expect: 足りる } }),
      implement(数える, {
        cases: {
          見積: action("予算まで使える", {
            guards: r => [r.予算.$gte(r.金額).$else(() => ({ result: { 結果: "足りない" as const }, effects: [] }))],
            run: () => 足りる,
          }),
        },
      }),
    );

    expect(notComposed).toStrictEqual([]);
    expect(rows.map(row => row.given)).toContainEqual({ 状態: "見積", 予算: d("6"), 金額: d("6.01") });
  });

  it("owes a row to a way two decimals of different scales can take", async () => {
    const 比べる = behavior("比べる", {
      input: variants("状態", { 入力: object({ a: decimal(1), b: decimal(2) }) }),
      result: variants("結果", { ok: object({}), ng: object({}) }),
      effects: variants("種類", {}),
    });
    const ng = () => ({ result: { 結果: "ng" as const }, effects: [] });
    const report = await check(
      spec("比べる", {
        examples: examples(比べる, {}),
        implementation: implement(比べる, {
          cases: {
            入力: action("比べる", {
              guards: r => [r.a.$gte(d("0.1")).$else(ng), r.b.$lte(d("0.14")).$else(ng), r.a.$lt(r.b).$else(ng)],
              run: () => ({ result: { 結果: "ok" as const }, effects: [] }),
            }),
          },
        }),
      }),
    );

    const rules = report.measures.rules.status === "complete" ? report.measures.rules.rules : [];
    expect(rules.find(rule => rule.way.endsWith("→ otherwise"))?.status).toBe("gap");
  });
});

describe("arithmetic on decimals", () => {
  const 合計する = behavior("合計する", {
    input: variants("状態", { 明細: object({ a: decimal(2), b: decimal(2) }) }),
    result: variants("結果", { 合計: object({ 合計: decimal(2) }) }),
    effects: variants("種類", {}),
  });
  const rows = examples(合計する, {
    "0.1 と 0.2": {
      given: { 状態: "明細", a: d("0.1"), b: d("0.2") },
      expect: { result: { 結果: "合計", 合計: d("0.3") }, effects: [] },
    },
  });
  const 足す = (r: { readonly a: Decimal; readonly b: Decimal }) => ({
    result: { 結果: "合計" as const, 合計: r.a.plus(r.b) },
    effects: [],
  });

  it("matches the row in check and in a conformance test alike", async () => {
    const report = await check(
      spec("合計する", {
        examples: rows,
        implementation: implement(合計する, { cases: { 明細: action("足す", { run: 足す }) } }),
      }),
    );
    const outcome = await conformance(rows, async input => 足す(input));

    expect(report.failures).toStrictEqual([]);
    expect(outcome.failures).toStrictEqual([]);
  });

  it("reads a stand-in a row writes with with", async () => {
    const 手数料を足す = behavior("手数料を足す", {
      input: variants("状態", { 明細: object({ a: decimal(2) }) }),
      result: variants("結果", { 合計: object({ 合計: decimal(2) }) }),
      effects: variants("種類", {}),
      requires: { 手数料: dependency(decimal(2)) },
    });
    const report = await check(
      spec("手数料を足す", {
        examples: examples(手数料を足す, {
          "0.1 に 0.05": {
            given: { 状態: "明細", a: d("0.1") },
            with: { 手数料: d("0.05") },
            expect: { result: { 結果: "合計", 合計: d("0.15") }, effects: [] },
          },
        }),
        implementation: implement(手数料を足す, {
          cases: {
            明細: action("足す", { run: (r, deps) => ({ result: { 結果: "合計", 合計: r.a.plus(deps.手数料) }, effects: [] }) }),
          },
        }),
      }),
    );

    expect(report.failures).toStrictEqual([]);
  });
});

describe("a decimal between two stages", () => {
  const 金額を答える = (answered: AnySchema) =>
    external(
      behavior("金額を答える", {
        input: variants("状態", { 申込: object({}) }),
        result: variants("結果", { 計算した: object({ 金額: answered }) }),
        effects: variants("種類", {}),
      }),
      "別のチーム",
    );
  const 受け取る = (taken: AnySchema) =>
    external(
      behavior("受け取る", {
        input: variants("結果", { 計算した: object({ 金額: taken }) }),
        result: variants("結果", { 受け取った: object({}) }),
        effects: variants("種類", {}),
      }),
      "別のチーム",
    );

  it("goes into a decimal keeping as many digits", () => {
    expect(() => compose("桁の多い decimal へ", [金額を答える(decimal(2)), 受け取る(decimal(3))])).not.toThrow();
  });

  it("refuses a decimal keeping fewer digits, a number, and an integer taken as a decimal", () => {
    expect(() => compose("桁の少ない decimal へ", [金額を答える(decimal(3)), 受け取る(decimal(2))])).toThrow(
      new SpecificationError("金額を答える answers @計算した.金額 as decimal(3), which 受け取る takes as decimal(2)"),
    );
    expect(() => compose("数へ", [金額を答える(decimal(2)), 受け取る(number())])).toThrow(
      new SpecificationError("金額を答える answers @計算した.金額 as decimal(2), which 受け取る takes as number"),
    );
    expect(() => compose("整数から", [金額を答える(int()), 受け取る(decimal(2))])).toThrow(
      new SpecificationError("金額を答える answers @計算した.金額 as integer, which 受け取る takes as decimal(2)"),
    );
  });
});

describe("a decimal in what a behavior ensures", () => {
  it("is derivable", async () => {
    const 値引きする = behavior("値引きする", {
      input: variants("状態", { 見積: object({ 金額: decimal(2) }) }),
      result: variants("結果", { 値引きした: object({ 金額: decimal(2) }) }),
      effects: variants("種類", {}),
      ensures: clause => [clause.when("高くしない", ["値引きした"], (input, value) => value.金額.$lte(input.金額))],
    });
    const report = await check(spec("値引きする", { examples: examples(値引きする, {}) }));

    expect(report.ensures.rules.map(rule => rule.classification)).toStrictEqual(["derivable"]);
  });
});
