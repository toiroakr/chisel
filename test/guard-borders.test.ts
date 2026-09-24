import { describe, expect, it } from "vitest";
import {
  behavior,
  defineSpecification,
  evaluateSpecification,
  example,
  examples,
  ge,
  guard,
  implement,
  integer,
  le,
  object,
  rules,
  string,
  sum,
} from "../src/index.js";

const 注文を受け付ける = behavior({
  name: "注文を受け付ける",
  input: sum("状態", { 入力済み: object({ 合計: integer().invariant(v => ge(v, 0)) }) }),
  result: sum("結果", { 受付: object({}), 要承認: object({ 理由: string("理由") }) }),
  effects: sum("種類", {}),
});

const 上限で分ける = implement(注文を受け付ける, {
  cases: {
    入力済み: rules(
      "上限で分ける",
      注文 => [
        guard(le(注文.合計, 100000), () => ({
          result: { 結果: "要承認", 理由: "上限超過" },
          effects: [],
        })),
      ],
      () => ({ result: { 結果: "受付" }, effects: [] }),
    ),
  },
});

function 合計で(合計: number) {
  return example(注文を受け付ける, `合計${合計}`, {
    given: { 状態: "入力済み", 合計 },
    expect:
      合計 <= 100000
        ? { result: { 結果: "受付" }, effects: [] }
        : { result: { 結果: "要承認", 理由: "上限超過" }, effects: [] },
  });
}

async function guardBorders(rows: readonly ReturnType<typeof 合計で>[]) {
  const report = await evaluateSpecification(
    defineSpecification({
      name: "受付",
      examples: examples(注文を受け付ける, rows),
      implementation: 上限で分ける,
    }),
  );
  return report.borders.filter(border => border.rule.startsWith("guard"));
}

describe("borders a guard draws", () => {
  it("owes all four points of a guard's border, since both sides can be constructed", async () => {
    expect(await guardBorders([合計で(100000)])).toStrictEqual([
      {
        path: "@入力済み.合計",
        rule: "guard $.合計 <= 100000",
        points: [
          { role: "ON", relation: "= 100000", status: "met" },
          { role: "OFF", relation: "= 100001", status: "gap" },
          { role: "IN", relation: "< 100000", status: "gap" },
          { role: "OUT", relation: "> 100001", status: "gap" },
        ],
      },
    ]);
  });
});

describe("a guard's border is met by reaching the comparison", () => {
  const 審査する = behavior({
    name: "審査する",
    input: sum("状態", {
      申請済み: object({ 会員: integer(), 合計: integer() }),
    }),
    result: sum("結果", { 受付: object({}), 却下: object({ 理由: string("理由") }) }),
    effects: sum("種類", {}),
  });
  const 二段で審査する = implement(審査する, {
    cases: {
      申請済み: rules(
        "二段で審査する",
        申請 => [
          guard(ge(申請.会員, 1), () => ({ result: { 結果: "却下", 理由: "非会員" }, effects: [] })),
          guard(le(申請.合計, 100), () => ({ result: { 結果: "却下", 理由: "上限超過" }, effects: [] })),
        ],
        () => ({ result: { 結果: "受付" }, effects: [] }),
      ),
    },
  });

  it("does not let a row that left through an earlier guard meet a later guard's point", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "審査",
        examples: examples(審査する, [
          example(審査する, "非会員は合計に関係なく却下", {
            given: { 状態: "申請済み", 会員: 0, 合計: 100 },
            expect: { result: { 結果: "却下", 理由: "非会員" }, effects: [] },
          }),
        ]),
        implementation: 二段で審査する,
      }),
    );

    expect(
      report.borders.find(border => border.rule === "guard $.合計 <= 100")!.points[0],
    ).toStrictEqual({ role: "ON", relation: "= 100", status: "gap" });
  });

  it("excludes a guard's point the invariants of the position refuse", async () => {
    const ゼロ円は要承認 = implement(注文を受け付ける, {
      cases: {
        入力済み: rules(
          "ゼロ円は要承認",
          注文 => [
            guard(ge(注文.合計, 1), () => ({
              result: { 結果: "要承認", 理由: "ゼロ円" },
              effects: [],
            })),
          ],
          () => ({ result: { 結果: "受付" }, effects: [] }),
        ),
      },
    });
    const report = await evaluateSpecification(
      defineSpecification({
        name: "受付",
        examples: examples(注文を受け付ける, []),
        implementation: ゼロ円は要承認,
      }),
    );

    expect(report.borders.find(border => border.rule === "guard $.合計 >= 1")!.points).toStrictEqual([
      { role: "ON", relation: "= 1", status: "gap" },
      { role: "OFF", relation: "= 0", status: "gap" },
      { role: "IN", relation: "> 1", status: "gap" },
      { role: "OUT", relation: "< 0", status: "excluded" },
    ]);
  });
});
