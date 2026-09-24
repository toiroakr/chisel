import { describe, expect, it } from "vitest";
import {
  all,
  and,
  array,
  behavior,
  defineSpecification,
  evaluateSpecification,
  example,
  eq,
  examples,
  ge,
  generateExamples,
  gt,
  guard,
  implement,
  instant,
  integer,
  le,
  length,
  lt,
  ne,
  number,
  object,
  rules,
  string,
  sum,
} from "../src/index.js";
import type { Rule, TermOf } from "../src/index.js";

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

describe("a border between two positions", () => {
  const 注文を確定する = behavior({
    name: "注文を確定する",
    input: sum("状態", {
      商品あり: object({ 明細: array(object({ 数量: integer(), 在庫数: integer() })) }),
    }),
    result: sum("結果", { 確定: object({}), 不可: object({ 理由: string("理由") }) }),
    effects: sum("種類", {}),
  });
  const 在庫を確かめる = implement(注文を確定する, {
    cases: {
      商品あり: rules(
        "在庫を確かめる",
        カート => [
          guard(all(カート.明細, 明細 => le(明細.数量, 明細.在庫数)), () => ({
            result: { 結果: "不可", 理由: "在庫不足" },
            effects: [],
          })),
        ],
        () => ({ result: { 結果: "確定" }, effects: [] }),
      ),
    },
  });

  it("draws the line on the difference of the two and reads it for every element the rule reached", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "確定",
        examples: examples(注文を確定する, [
          example(注文を確定する, "ちょうど在庫分", {
            given: { 状態: "商品あり", 明細: [{ 数量: 5, 在庫数: 9 }, { 数量: 3, 在庫数: 3 }] },
            expect: { result: { 結果: "確定" }, effects: [] },
          }),
        ]),
        implementation: 在庫を確かめる,
      }),
    );

    expect(report.borders).toStrictEqual([
      {
        path: "@商品あり.明細[].数量 − @商品あり.明細[].在庫数",
        rule: "guard $.明細[].数量 <= $.明細[].在庫数",
        points: [
          { role: "ON", relation: "= 0", status: "met" },
          { role: "OFF", relation: "= 1", status: "gap" },
          { role: "IN", relation: "< 0", status: "met" },
          { role: "OUT", relation: "> 1", status: "gap" },
        ],
      },
    ]);
  });

  it("names no OFF point on the difference of two numbers, which has no step", async () => {
    const 比べる = behavior({
      name: "比べる",
      input: sum("状態", { 入力済み: object({ 予算: number(), 見積: number() }) }),
      result: object({}),
      effects: sum("種類", {}),
    });
    const 予算内か = implement(比べる, {
      cases: {
        入力済み: rules(
          "予算内か",
          入力 => [guard(le(入力.見積, 入力.予算), () => ({ result: {}, effects: [] }))],
          () => ({ result: {}, effects: [] }),
        ),
      },
    });
    const report = await evaluateSpecification(
      defineSpecification({ name: "比較", examples: examples(比べる, []), implementation: 予算内か }),
    );

    expect(report.borders[0]!.points[1]).toStrictEqual({
      role: "OFF",
      relation: "neighbour not named",
      status: "not named",
    });
  });
});

describe("classes cut from a range an object invariant bounds", () => {
  it("reads the admitted range from an invariant written on the object holding the field", async () => {
    const 受け付ける = behavior({
      name: "受け付ける",
      input: sum("状態", {
        入力済み: object({ 合計: integer() }).invariant(v => ge(v.合計, 0)),
      }),
      result: object({}),
      effects: sum("種類", {}),
    });
    const 上限 = implement(受け付ける, {
      cases: {
        入力済み: rules(
          "上限",
          入力 => [guard(le(入力.合計, 100), () => ({ result: {}, effects: [] }))],
          () => ({ result: {}, effects: [] }),
        ),
      },
    });
    const report = await evaluateSpecification(
      defineSpecification({ name: "上限", examples: examples(受け付ける, []), implementation: 上限 }),
    );

    expect(report.partitions).toMatchObject([{ missing: ["0 <= v <= 100", "100 < v"] }]);
  });
  it("excludes a guard point an invariant on the object holding the field refuses", async () => {
    const 受け付ける = behavior({
      name: "受け付ける",
      input: sum("状態", {
        入力済み: object({ 合計: integer() }).invariant(v => ge(v.合計, 0)),
      }),
      result: object({}),
      effects: sum("種類", {}),
    });
    const 下限 = implement(受け付ける, {
      cases: {
        入力済み: rules(
          "下限",
          入力 => [guard(ge(入力.合計, 0), () => ({ result: {}, effects: [] }))],
          () => ({ result: {}, effects: [] }),
        ),
      },
    });
    const report = await evaluateSpecification(
      defineSpecification({ name: "下限", examples: examples(受け付ける, []), implementation: 下限 }),
    );

    expect(report.borders[0]!.points.map(point => point.status)).toStrictEqual([
      "gap",
      "excluded",
      "gap",
      "excluded",
    ]);
  });
});

describe("elements a quantifier never reached", () => {
  const 注文を確定する = behavior({
    name: "注文を確定する",
    input: sum("状態", {
      商品あり: object({ 明細: array(object({ 数量: integer(), 在庫数: integer() })) }),
    }),
    result: sum("結果", { 確定: object({}), 不可: object({ 理由: string("理由") }) }),
    effects: sum("種類", {}),
  });
  const 在庫を確かめる = implement(注文を確定する, {
    cases: {
      商品あり: rules(
        "在庫を確かめる",
        カート => [
          guard(all(カート.明細, 明細 => le(明細.数量, 明細.在庫数)), () => ({
            result: { 結果: "不可", 理由: "在庫不足" },
            effects: [],
          })),
        ],
        () => ({ result: { 結果: "確定" }, effects: [] }),
      ),
    },
  });

  it("does not let an element after the first one all() failed on meet a point", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "確定",
        examples: examples(注文を確定する, [
          example(注文を確定する, "先頭の明細が在庫不足", {
            given: { 状態: "商品あり", 明細: [{ 数量: 4, 在庫数: 3 }, { 数量: 1, 在庫数: 5 }] },
            expect: { result: { 結果: "不可", 理由: "在庫不足" }, effects: [] },
          }),
        ]),
        implementation: 在庫を確かめる,
      }),
    );

    expect(report.borders[0]!.points.find(point => point.role === "IN")).toStrictEqual({
      role: "IN",
      relation: "< 0",
      status: "gap",
    });
  });
});

describe("generateExamples for guard borders", () => {
  const 注文を確定する = behavior({
    name: "注文を確定する",
    input: sum("状態", {
      商品あり: object({ 明細: array(object({ 数量: integer(), 在庫数: integer() })) }),
    }),
    result: sum("結果", { 確定: object({}), 不可: object({ 理由: string("理由") }) }),
    effects: sum("種類", {}),
  });
  const 在庫を確かめる = implement(注文を確定する, {
    cases: {
      商品あり: rules(
        "在庫を確かめる",
        カート => [
          guard(all(カート.明細, 明細 => le(明細.数量, 明細.在庫数)), () => ({
            result: { 結果: "不可", 理由: "在庫不足" },
            effects: [],
          })),
        ],
        () => ({ result: { 結果: "確定" }, effects: [] }),
      ),
    },
  });

  it("moves one side of a compared pair so the difference stands at each point no row reached", () => {
    const existing = examples(注文を確定する, [
      example(注文を確定する, "ちょうど在庫分", {
        given: { 状態: "商品あり", 明細: [{ 数量: 3, 在庫数: 3 }] },
        expect: { result: { 結果: "確定" }, effects: [] },
      }),
    ]);

    expect(
      generateExamples(existing, 在庫を確かめる).map(row => ({ name: row.name, given: row.given })),
    ).toStrictEqual([
      {
        name: "注文を確定する: @商品あり.明細[].数量 − @商品あり.明細[].在庫数 OFF (= 1)",
        given: { 状態: "商品あり", 明細: [{ 数量: 4, 在庫数: 3 }] },
      },
      {
        name: "注文を確定する: @商品あり.明細[].数量 − @商品あり.明細[].在庫数 IN (< 0)",
        given: { 状態: "商品あり", 明細: [{ 数量: 2, 在庫数: 3 }] },
      },
      {
        name: "注文を確定する: @商品あり.明細[].数量 − @商品あり.明細[].在庫数 OUT (> 1)",
        given: { 状態: "商品あり", 明細: [{ 数量: 5, 在庫数: 3 }] },
      },
    ]);
  });
});

describe("classes a guard's threshold divides a position into", () => {
  it("cuts the range the invariants admit at the guard's threshold", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "受付",
        examples: examples(注文を受け付ける, [合計で(100000)]),
        implementation: 上限で分ける,
      }),
    );

    expect(report.partitions).toStrictEqual([
      {
        path: "@入力済み.合計",
        kind: "divided",
        covered: ["0 <= v <= 100000"],
        missing: ["100000 < v"],
        excluded: [],
      },
    ]);
  });

  const 点数を判定する = behavior({
    name: "点数を判定する",
    input: sum("状態", { 採点済み: object({ 点数: integer() }) }),
    result: object({}),
    effects: sum("種類", {}),
  });
  const 判定 = (guards: (入力: TermOf<{ readonly 点数: number }>) => readonly Rule[]) =>
    implement(点数を判定する, {
      cases: {
        採点済み: rules(
          "判定",
          入力 => guards(入力).map(condition => guard(condition, () => ({ result: {}, effects: [] }))),
          () => ({ result: {}, effects: [] }),
        ),
      },
    });
  const partitionsOf = async (implementation: ReturnType<typeof 判定>) =>
    (
      await evaluateSpecification(
        defineSpecification({ name: "判定", examples: examples(点数を判定する, []), implementation }),
      )
    ).partitions;

  it("leaves a side open where no invariant bounds it", async () => {
    expect(await partitionsOf(判定(入力 => [le(入力.点数, 59)]))).toMatchObject([
      { missing: ["v <= 59", "59 < v"] },
    ]);
  });

  it("merges the thresholds of several guards on one position into one partition", async () => {
    expect(
      await partitionsOf(判定(入力 => [gt(入力.点数, 10), gt(入力.点数, 20)])),
    ).toMatchObject([{ missing: ["v <= 10", "10 < v <= 20", "20 < v"] }]);
  });

  it("divides neither position a guard compares with each other", async () => {
    const 比べる = behavior({
      name: "比べる",
      input: sum("状態", { 入力済み: object({ 数量: integer(), 在庫数: integer() }) }),
      result: object({}),
      effects: sum("種類", {}),
    });
    const 在庫内か = implement(比べる, {
      cases: {
        入力済み: rules(
          "在庫内か",
          入力 => [guard(le(入力.数量, 入力.在庫数), () => ({ result: {}, effects: [] }))],
          () => ({ result: {}, effects: [] }),
        ),
      },
    });
    const report = await evaluateSpecification(
      defineSpecification({ name: "比較", examples: examples(比べる, []), implementation: 在庫内か }),
    );

    expect(report.partitions.map(partition => partition.kind)).toStrictEqual([
      "not-derivable",
      "not-derivable",
    ]);
  });

  it("offers a row in each class a guard threshold drew that no row is in", () => {
    const names = generateExamples(examples(注文を受け付ける, [合計で(100000)]), 上限で分ける).map(
      row => row.name,
    );

    expect(names.filter(name => name.includes(" = "))).toStrictEqual([
      "注文を受け付ける: @入力済み.合計 = 100000 < v",
    ]);
  });
});

describe("borders of a rule that names one value", () => {
  const 判定する = behavior({
    name: "判定する",
    input: sum("状態", { 入力済み: object({ 数量: integer() }) }),
    result: object({}),
    effects: sum("種類", {}),
  });
  const pointsOf = async (condition: (入力: TermOf<{ readonly 数量: number }>) => Rule) => {
    const 判定 = implement(判定する, {
      cases: {
        入力済み: rules(
          "判定",
          入力 => [guard(condition(入力), () => ({ result: {}, effects: [] }))],
          () => ({ result: {}, effects: [] }),
        ),
      },
    });
    const report = await evaluateSpecification(
      defineSpecification({ name: "判定", examples: examples(判定する, []), implementation: 判定 }),
    );
    return report.borders[0]!.points;
  };

  it("owes an OFF point on each side of an equality and says it has no IN point", async () => {
    expect(await pointsOf(入力 => eq(入力.数量, 10))).toStrictEqual([
      { role: "ON", relation: "= 10", status: "gap" },
      { role: "OFF", relation: "= 9", status: "gap" },
      { role: "OFF", relation: "= 11", status: "gap" },
      { role: "IN", relation: "none: the rule keeps a single value", status: "no point" },
      { role: "OUT", relation: "< 9", status: "gap" },
      { role: "OUT", relation: "> 11", status: "gap" },
    ]);
  });

  it("owes an ON point on each side of an inequality and says it has no OUT point", async () => {
    expect(await pointsOf(入力 => ne(入力.数量, 10))).toStrictEqual([
      { role: "ON", relation: "= 9", status: "gap" },
      { role: "ON", relation: "= 11", status: "gap" },
      { role: "OFF", relation: "= 10", status: "gap" },
      { role: "IN", relation: "< 9", status: "gap" },
      { role: "IN", relation: "> 11", status: "gap" },
      { role: "OUT", relation: "none: the rule leaves out a single value", status: "no point" },
    ]);
  });

  it("parts the value an equality names from the values on either side of it", async () => {
    const 判定 = implement(判定する, {
      cases: {
        入力済み: rules(
          "判定",
          入力 => [guard(eq(入力.数量, 10), () => ({ result: {}, effects: [] }))],
          () => ({ result: {}, effects: [] }),
        ),
      },
    });
    const report = await evaluateSpecification(
      defineSpecification({ name: "判定", examples: examples(判定する, []), implementation: 判定 }),
    );

    expect(report.partitions).toMatchObject([{ missing: ["v < 10", "v = 10", "10 < v"] }]);
  });
});

describe("comparisons Chisel could not read", () => {
  it("reads two instants on their difference in nanoseconds", async () => {
    const 比べる = behavior({
      name: "比べる",
      input: sum("状態", { 入力済み: object({ 開始: instant(), 終了: instant() }) }),
      result: object({}),
      effects: sum("種類", {}),
    });
    const 順序 = implement(比べる, {
      cases: {
        入力済み: rules(
          "順序",
          入力 => [guard(lt(入力.開始, 入力.終了), () => ({ result: {}, effects: [] }))],
          () => ({ result: {}, effects: [] }),
        ),
      },
    });
    const report = await evaluateSpecification(
      defineSpecification({ name: "順序", examples: examples(比べる, []), implementation: 順序 }),
    );

    expect(report.borders[0]!.points.map(point => point.relation)).toStrictEqual([
      "= -1",
      "= 0",
      "< -1",
      "> 0",
    ]);
  });

  it("names a comparison it drew no border for and leaves the verdict undetermined", async () => {
    const 比べる = behavior({
      name: "比べる",
      input: sum("状態", { 入力済み: object({ 姓: string("姓"), 名: string("名") }) }),
      result: object({}),
      effects: sum("種類", {}),
    });
    const 並び = implement(比べる, {
      cases: {
        入力済み: rules(
          "並び",
          入力 => [guard(lt(入力.姓, 入力.名), () => ({ result: {}, effects: [] }))],
          () => ({ result: {}, effects: [] }),
        ),
      },
    });
    const report = await evaluateSpecification(
      defineSpecification({ name: "並び", examples: examples(比べる, []), implementation: 並び }),
    );

    expect(report.measures.comparisons).toStrictEqual({
      status: "partial",
      notRead: ["並び: $.姓 < $.名"],
    });
  });
});

describe("a guard on a length", () => {
  const 明細を確かめる = behavior({
    name: "明細を確かめる",
    input: sum("状態", { 入力済み: object({ 明細: array(integer()), 上限: integer() }) }),
    result: sum("結果", { 受付: object({}), 断る: object({}) }),
    effects: sum("種類", {}),
  });

  async function pointsReached(
    condition: (注文: TermOf<{ 状態: "入力済み"; 明細: number[]; 上限: number }>) => Rule,
    given: { 明細: number[]; 上限: number },
  ) {
    const 確かめる = implement(明細を確かめる, {
      cases: {
        入力済み: rules(
          "確かめる",
          注文 => [guard(condition(注文), () => ({ result: { 結果: "断る" }, effects: [] }))],
          () => ({ result: { 結果: "受付" }, effects: [] }),
        ),
      },
    });
    const report = await evaluateSpecification(
      defineSpecification({
        name: "明細",
        examples: examples(明細を確かめる, [
          example(明細を確かめる, "行", {
            given: { 状態: "入力済み", ...given },
            expect: { result: { 結果: "受付" }, effects: [] },
          }),
        ]),
        implementation: 確かめる,
      }),
    );
    return report.borders
      .filter(border => border.rule.startsWith("guard"))
      .flatMap(border => border.points.filter(point => point.status === "met"))
      .map(point => point.role);
  }

  it("places a row at the length it reached", async () => {
    expect(await pointsReached(注文 => gt(length(注文.明細), 0), { 明細: [1], 上限: 0 })).toStrictEqual([
      "ON",
    ]);
  });

  it("places a row at the difference between a length and another position", async () => {
    expect(
      await pointsReached(注文 => le(length(注文.明細), 注文.上限), { 明細: [1, 2, 3], 上限: 3 }),
    ).toStrictEqual(["ON"]);
  });
});

describe("a guard point no row can reach", () => {
  const 数量を見る = behavior({
    name: "数量を見る",
    input: sum("状態", { 入力済み: object({ 数量: integer() }) }),
    result: sum("結果", { 受付: object({}), 却下: object({}) }),
    effects: sum("種類", {}),
  });
  const 二段 = implement(数量を見る, {
    cases: {
      入力済み: rules(
        "二段",
        入力 => [
          guard(and(ge(入力.数量, 10), ge(入力.数量, 5)), () => ({
            result: { 結果: "却下" },
            effects: [],
          })),
        ],
        () => ({ result: { 結果: "受付" }, effects: [] }),
      ),
    },
  });

  it("owes no row at a point of a comparison only reached with values outside it", async () => {
    const report = await evaluateSpecification(
      defineSpecification({ name: "二段", examples: examples(数量を見る, []), implementation: 二段 }),
    );

    expect(
      report.borders
        .find(border => border.rule === "guard $.数量 >= 5")!
        .points.map(point => `${point.role} ${point.status}`),
    ).toStrictEqual(["ON no row owed", "OFF no row owed", "IN gap", "OUT no row owed"]);
  });

  it("offers no row at such a point", () => {
    expect(
      generateExamples(examples(数量を見る, []), 二段)
        .map(row => row.name)
        .filter(name => /@入力済み\.数量 (ON \(= 5\)|OFF \(= 4\)|OUT \(< 4\))/.test(name)),
    ).toStrictEqual([]);
  });
});

describe("an equality between two positions", () => {
  const 照合する = behavior({
    name: "照合する",
    input: sum("状態", { 入力済み: object({ 請求額: integer(), 入金額: integer() }) }),
    result: sum("結果", { 一致: object({}), 不一致: object({}) }),
    effects: sum("種類", {}),
  });

  async function reportFor(condition: (入力: TermOf<{ 状態: "入力済み"; 請求額: number; 入金額: number }>) => Rule) {
    const 照合 = implement(照合する, {
      cases: {
        入力済み: rules(
          "照合",
          入力 => [guard(condition(入力), () => ({ result: { 結果: "不一致" }, effects: [] }))],
          () => ({ result: { 結果: "一致" }, effects: [] }),
        ),
      },
    });
    return evaluateSpecification(
      defineSpecification({ name: "照合", examples: examples(照合する, []), implementation: 照合 }),
    );
  }

  it("draws no border, since the arms already put a whole arm on each side of the line", async () => {
    const report = await reportFor(入力 => eq(入力.請求額, 入力.入金額));

    expect(report.borders.filter(border => border.rule.startsWith("guard"))).toStrictEqual([]);
  });

  it("counts an equality as read, not as a comparison Chisel cannot read", async () => {
    const report = await reportFor(入力 => ne(入力.請求額, 入力.入金額));

    expect(report.measures.comparisons).toStrictEqual({ status: "complete" });
  });
});
