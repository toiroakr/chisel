import { describe, expect, it } from "vitest";
import {
  all,
  and,
  array,
  behavior,
  defineSpecification,
  eq,
  evaluateSpecification,
  example,
  examples,
  generateExamples,
  generationReport,
  guard,
  implement,
  integer,
  ge,
  le,
  length,
  lt,
  match,
  object,
  or,
  rules,
  runImplementation,
  SpecificationError,
  string,
  sum,
  unanswered,
} from "../src/index.js";
import type { Implementation } from "../src/index.js";

const 注文を確定する = behavior({
  name: "注文を確定する",
  input: sum("状態", {
    商品あり: object({
      カートID: string("カートID"),
      明細: array(object({ 数量: integer(), 在庫数: integer() })),
    }),
  }),
  result: sum("結果", {
    確定: object({ カートID: string("カートID") }),
    不可: object({ 理由: string("理由") }),
  }),
  effects: sum("種類", {}),
});

const 在庫を確かめて確定する = implement(注文を確定する, {
  cases: {
    商品あり: rules(
      "在庫を確かめて確定する",
      カート => [
        guard(all(カート.明細, 明細 => le(明細.数量, 明細.在庫数)), () => ({
          result: { 結果: "不可", 理由: "在庫不足" },
          effects: [],
        })),
      ],
      カート => ({ result: { 結果: "確定", カートID: カート.カートID }, effects: [] }),
    ),
  },
  controls: {},
});

describe("rules", () => {
  it("answers with a guard's else when its condition does not hold", async () => {
    const outcome = await runImplementation(在庫を確かめて確定する, {
      状態: "商品あり",
      カートID: "c-1",
      明細: [{ 数量: 4, 在庫数: 3 }],
    });

    expect(outcome).toStrictEqual({ result: { 結果: "不可", 理由: "在庫不足" }, effects: [] });
  });

  it("answers with what follows the guards when every condition holds", async () => {
    const outcome = await runImplementation(在庫を確かめて確定する, {
      状態: "商品あり",
      カートID: "c-1",
      明細: [{ 数量: 3, 在庫数: 3 }],
    });

    expect(outcome).toStrictEqual({ result: { 結果: "確定", カートID: "c-1" }, effects: [] });
  });
});

describe("arms of a rules decision", () => {
  const 在庫あり = example(注文を確定する, "在庫あり", {
    given: { 状態: "商品あり", カートID: "c-1", 明細: [{ 数量: 3, 在庫数: 3 }] },
    expect: { result: { 結果: "確定", カートID: "c-1" }, effects: [] },
  });

  it("measures the arms completely and marks the arm an answered row went through", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "注文確定",
        examples: examples(注文を確定する, [在庫あり]),
        implementation: 在庫を確かめて確定する,
      }),
    );

    expect(report.measures.arms).toStrictEqual({
      status: "complete",
      arms: [
        {
          decision: "在庫を確かめて確定する",
          guard: "all($.明細, $.明細[].数量 <= $.明細[].在庫数)",
          arm: "holds",
          status: "met",
        },
        {
          decision: "在庫を確かめて確定する",
          guard: "all($.明細, $.明細[].数量 <= $.明細[].在庫数)",
          arm: "else",
          status: "gap",
        },
      ],
    });
  });

  it("says an arm only a row whose answer is owed went through is owed an answer", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "注文確定",
        examples: examples(注文を確定する, [
          在庫あり,
          example(注文を確定する, "在庫不足はまだ決めていない", {
            given: { 状態: "商品あり", カートID: "c-2", 明細: [{ 数量: 4, 在庫数: 3 }] },
            expect: unanswered(),
          }),
        ]),
        implementation: 在庫を確かめて確定する,
      }),
    );

    expect(
      report.measures.arms.status === "complete"
        ? report.measures.arms.arms.map(arm => arm.status)
        : undefined,
    ).toStrictEqual(["met", "answer owed"]);
  });
});

describe("verdict over a rules decision", () => {
  const 在庫あり = example(注文を確定する, "在庫あり", {
    given: { 状態: "商品あり", カートID: "c-1", 明細: [{ 数量: 3, 在庫数: 3 }] },
    expect: { result: { 結果: "確定", カートID: "c-1" }, effects: [] },
  });
  const 在庫不足 = example(注文を確定する, "在庫不足", {
    given: { 状態: "商品あり", カートID: "c-2", 明細: [{ 数量: 4, 在庫数: 3 }] },
    expect: { result: { 結果: "不可", 理由: "在庫不足" }, effects: [] },
  });

  it("is not_satisfied while an arm has no answered row through it", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "注文確定",
        examples: examples(注文を確定する, [在庫あり]),
        implementation: 在庫を確かめて確定する,
      }),
    );

    expect(report.verdict).toBe("not_satisfied");
  });

  it("is satisfied when every measure was made and none found a gap", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "注文確定",
        examples: examples(注文を確定する, [
          在庫あり,
          在庫不足,
          example(注文を確定する, "在庫に余裕がある", {
            given: { 状態: "商品あり", カートID: "c-3", 明細: [{ 数量: 2, 在庫数: 3 }] },
            expect: { result: { 結果: "確定", カートID: "c-3" }, effects: [] },
          }),
          example(注文を確定する, "在庫が大きく足りない", {
            given: { 状態: "商品あり", カートID: "c-4", 明細: [{ 数量: 5, 在庫数: 3 }] },
            expect: { result: { 結果: "不可", 理由: "在庫不足" }, effects: [] },
          }),
        ]),
        implementation: 在庫を確かめて確定する,
      }),
    );

    expect(report.verdict).toBe("satisfied");
  });

  it("measures the arms partially when another case is decided by a closure", async () => {
    const 二つの状態 = behavior({
      name: "二つの状態",
      input: sum("状態", {
        商品あり: object({ 数量: integer() }),
        確定済み: object({}),
      }),
      result: object({}),
      effects: sum("種類", {}),
    });
    const 混在 = implement(二つの状態, {
      cases: {
        商品あり: rules(
          "数量を確かめる",
          入力 => [guard(le(入力.数量, 10), () => ({ result: {}, effects: [] }))],
          () => ({ result: {}, effects: [] }),
        ),
        確定済み: { kind: "decision", id: "何もしない", run: () => ({ result: {}, effects: [] }) },
      },
    });
    const report = await evaluateSpecification(
      defineSpecification({ name: "混在", examples: examples(二つの状態, []), implementation: 混在 }),
    );

    expect(report.measures.arms).toMatchObject({ status: "partial", notRead: ["何もしない"] });
  });
});

describe("rules of a decision", () => {
  const 割引を判定する = behavior({
    name: "割引を判定する",
    input: sum("状態", { 入力済み: object({ 会員歴: integer(), 購入額: integer() }) }),
    result: sum("結果", { 割引: object({}), 定価: object({}) }),
    effects: sum("種類", {}),
  });
  const 会員歴か購入額 = implement(割引を判定する, {
    cases: {
      入力済み: rules(
        "会員歴か購入額",
        入力 => [
          guard(or(ge(入力.会員歴, 3), ge(入力.購入額, 10000)), () => ({
            result: { 結果: "定価" },
            effects: [],
          })),
        ],
        () => ({ result: { 結果: "割引" }, effects: [] }),
      ),
    },
  });
  const 会員歴で = example(割引を判定する, "会員歴が長い", {
    given: { 状態: "入力済み", 会員歴: 5, 購入額: 0 },
    expect: { result: { 結果: "割引" }, effects: [] },
  });

  it("lists each way through the body, carrying only the distinctions that way consulted", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "割引",
        examples: examples(割引を判定する, [会員歴で]),
        implementation: 会員歴か購入額,
      }),
    );

    expect(report.measures.rules).toStrictEqual({
      status: "complete",
      rules: [
        { decision: "会員歴か購入額", way: "$.会員歴 >= 3 holds → otherwise", status: "met" },
        {
          decision: "会員歴か購入額",
          way: "$.会員歴 >= 3 fails, $.購入額 >= 10000 holds → otherwise",
          status: "gap",
        },
        {
          decision: "会員歴か購入額",
          way: "$.会員歴 >= 3 fails, $.購入額 >= 10000 fails → else of guard 1",
          status: "gap",
        },
      ],
    });
  });

  it("describes the way through a decision with no guard as going straight to what follows", async () => {
    const 常に定価 = implement(割引を判定する, {
      cases: { 入力済み: rules("常に定価", () => [], () => ({ result: { 結果: "定価" }, effects: [] })) },
    });
    const report = await evaluateSpecification(
      defineSpecification({ name: "定価", examples: examples(割引を判定する, []), implementation: 常に定価 }),
    );

    expect(report.measures.rules).toMatchObject({ rules: [{ way: "otherwise" }] });
  });
});

describe("match over a sum field", () => {
  const 送料を決める = behavior({
    name: "送料を決める",
    input: sum("状態", {
      確定済み: object({
        配送: sum("方法", { 宅配: object({}), 店頭受取: object({}) }),
      }),
    }),
    result: object({ 送料: integer() }),
    effects: sum("種類", {}),
  });
  const 方法で決める = implement(送料を決める, {
    cases: {
      確定済み: rules(
        "方法で決める",
        () => [],
        match(注文 => 注文.配送.方法, {
          宅配: () => ({ result: { 送料: 500 }, effects: [] }),
          店頭受取: () => ({ result: { 送料: 0 }, effects: [] }),
        }),
      ),
    },
  });
  const 宅配 = example(送料を決める, "宅配", {
    given: { 状態: "確定済み", 配送: { 方法: "宅配" } },
    expect: { result: { 送料: 500 }, effects: [] },
  });

  it("answers with the case the matched value is", async () => {
    expect(
      await runImplementation(方法で決める, { 状態: "確定済み", 配送: { 方法: "店頭受取" } }),
    ).toStrictEqual({ result: { 送料: 0 }, effects: [] });
  });

  it("counts every case of a match as an arm", async () => {
    const report = await evaluateSpecification(
      defineSpecification({ name: "送料", examples: examples(送料を決める, [宅配]), implementation: 方法で決める }),
    );

    expect(report.measures.arms).toStrictEqual({
      status: "complete",
      arms: [
        { decision: "方法で決める", guard: "match $.配送.方法", arm: "宅配", status: "met" },
        { decision: "方法で決める", guard: "match $.配送.方法", arm: "店頭受取", status: "gap" },
      ],
    });
  });

  it("ends a way at the case it went to", async () => {
    const report = await evaluateSpecification(
      defineSpecification({ name: "送料", examples: examples(送料を決める, [宅配]), implementation: 方法で決める }),
    );

    expect(report.measures.rules).toMatchObject({
      rules: [
        { way: "$.配送.方法 is 宅配", status: "met" },
        { way: "$.配送.方法 is 店頭受取", status: "gap" },
      ],
    });
  });

  it("lets the row a sum field class asks for stand on the way to that match case", () => {
    expect(
      generateExamples(examples(送料を決める, [宅配]), 方法で決める).map(row => row.given),
    ).toStrictEqual([{ 状態: "確定済み", 配送: { 方法: "店頭受取" } }]);
  });

  it("composes a row for a match case from a row that reaches the match", () => {
    const 重さで決める = behavior({
      name: "重さで決める",
      input: sum("状態", {
        確定済み: object({
          重さ: integer(),
          配送: sum("方法", { 宅配: object({}), 店頭受取: object({}) }),
        }),
      }),
      result: object({ 送料: integer() }),
      effects: sum("種類", {}),
    });
    const 重さと方法 = implement(重さで決める, {
      cases: {
        確定済み: rules(
          "重さと方法",
          注文 => [guard(ge(注文.重さ, 1), () => ({ result: { 送料: 0 }, effects: [] }))],
          match(注文 => 注文.配送.方法, {
            宅配: () => ({ result: { 送料: 500 }, effects: [] }),
            店頭受取: () => ({ result: { 送料: 0 }, effects: [] }),
          }),
        ),
      },
    });
    const existing = examples(重さで決める, [
      example(重さで決める, "宅配", {
        given: { 状態: "確定済み", 重さ: 1, 配送: { 方法: "宅配" } },
        expect: { result: { 送料: 500 }, effects: [] },
      }),
      example(重さで決める, "重さなしの店頭受取", {
        given: { 状態: "確定済み", 重さ: 0, 配送: { 方法: "店頭受取" } },
        expect: { result: { 送料: 0 }, effects: [] },
      }),
    ]);

    expect(
      generateExamples(existing, 重さと方法)
        .filter(row => row.name.includes(" is "))
        .map(row => row.given),
    ).toStrictEqual([{ 状態: "確定済み", 重さ: 1, 配送: { 方法: "店頭受取" } }]);
  });
});

describe("ways generate could not compose", () => {
  it("says which ways no row was composed for rather than leaving them out", () => {
    const 並べる = behavior({
      name: "並べる",
      input: sum("状態", { 入力済み: object({ 姓: string("姓"), 名: string("名") }) }),
      result: object({}),
      effects: sum("種類", {}),
    });
    const 並び = implement(並べる, {
      cases: {
        入力済み: rules(
          "並び",
          入力 => [guard(lt(入力.姓, 入力.名), () => ({ result: {}, effects: [] }))],
          () => ({ result: {}, effects: [] }),
        ),
      },
    });

    expect(generationReport(並べる, 並び).notComposed).toStrictEqual([
      "並び: $.姓 < $.名 holds → otherwise",
    ]);
  });
});

describe("what match can branch on", () => {
  const 送る = behavior({
    name: "送る",
    input: sum("状態", {
      確定済み: object({
        メモ: string("メモ"),
        配送: sum("方法", { 宅配: object({}), 店頭受取: object({}) }),
      }),
    }),
    result: object({}),
    effects: sum("種類", {}),
  });
  const 何もしない = () => ({ result: {}, effects: [] });

  it("refuses a match on a field that is not the discriminant of a sum", () => {
    expect(() =>
      implement(送る, {
        cases: {
          確定済み: rules("メモで分ける", () => [], match(注文 => 注文.メモ, { 至急: 何もしない })),
        },
      }),
    ).toThrow(
      new SpecificationError("match in メモで分ける does not select the discriminant of a sum field"),
    );
  });

  it("refuses a match that leaves out a case of the sum", () => {
    expect(() =>
      implement(送る, {
        cases: {
          確定済み: rules(
            "宅配だけ",
            () => [],
            // @ts-expect-error a match must have a case for every case of the sum
            match(注文 => 注文.配送.方法, { 宅配: 何もしない }),
          ),
        },
      }),
    ).toThrow(new SpecificationError("match in 宅配だけ has no case for 店頭受取"));
  });

  it("refuses at compile time a case the sum does not have", () => {
    expect(() =>
      implement(送る, {
        cases: {
          確定済み: rules(
            "郵送もある",
            () => [],
            match(注文 => 注文.配送.方法, {
              宅配: 何もしない,
              店頭受取: 何もしない,
              // @ts-expect-error 郵送 is not a case of the sum
              郵送: 何もしない,
            }),
          ),
        },
      }),
    ).toThrow(SpecificationError);
  });
});

describe("rules written inline in defineSpecification", () => {
  const 受け付ける = behavior({
    name: "受け付ける",
    input: sum("状態", { 入力済み: object({ 合計: integer() }) }),
    result: sum("結果", { 受付: object({}), 審査: object({}) }),
    effects: sum("種類", {}),
  });

  it("keeps the result literals of an implementation written inside the specification", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "受付",
        examples: examples(受け付ける, [
          example(受け付ける, "少額", {
            given: { 状態: "入力済み", 合計: 100 },
            expect: { result: { 結果: "受付" }, effects: [] },
          }),
        ]),
        implementation: implement(受け付ける, {
          cases: {
            入力済み: rules(
              "上限",
              入力 => [guard(le(入力.合計, 100), () => ({ result: { 結果: "審査" }, effects: [] }))],
              () => ({ result: { 結果: "受付" }, effects: [] }),
            ),
          },
        }),
      }),
    );

    expect(report.failures).toStrictEqual([]);
  });

  it("refuses a result case the behavior does not answer, inline as well", () => {
    defineSpecification({
      name: "受付",
      examples: examples(受け付ける, []),
      implementation: implement(受け付ける, {
        cases: {
          // @ts-expect-error 却下 is not a result case of 受け付ける
          入力済み: rules("上限", () => [], () => ({ result: { 結果: "却下" }, effects: [] })),
        },
      }),
    });
  });
});

describe("ways no row can take", () => {
  const 受け付ける = behavior({
    name: "受け付ける",
    input: sum("状態", {
      入力済み: object({
        数量: integer().invariant(v => ge(v, 0)),
        上限: integer(),
        最低: integer().invariant(v => ge(v, 10)),
        明細: array(integer()),
      }),
    }),
    result: sum("結果", { 受付: object({}), 却下: object({}) }),
    effects: sum("種類", {}),
  });
  const 却下 = () => ({ result: { 結果: "却下" as const }, effects: [] });
  const 受付 = () => ({ result: { 結果: "受付" as const }, effects: [] });

  async function statuses(implementation: Implementation<typeof 受け付ける>) {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "受付",
        examples: examples(受け付ける, []),
        implementation,
      }),
    );
    return {
      rules:
        report.measures.rules.status === "unavailable"
          ? []
          : report.measures.rules.rules.map(rule => `${rule.way}: ${rule.status}`),
      arms:
        report.measures.arms.status === "unavailable"
          ? []
          : report.measures.arms.arms.map(arm => `${arm.guard} ${arm.arm}: ${arm.status}`),
    };
  }

  it("owes no row at a way whose conditions leave nothing on one value", async () => {
    const 二段 = implement(受け付ける, {
      cases: {
        入力済み: rules("二段", 入力 => [guard(and(ge(入力.数量, 10), ge(入力.数量, 5)), 却下)], 受付),
      },
    });

    expect((await statuses(二段)).rules).toStrictEqual([
      "$.数量 >= 10 holds, $.数量 >= 5 holds → otherwise: gap",
      "$.数量 >= 10 holds, $.数量 >= 5 fails → else of guard 1: no row owed",
      "$.数量 >= 10 fails → else of guard 1: gap",
    ]);
  });

  it("owes no row at a way or an arm the invariants of the position leave nothing at", async () => {
    const 非負 = implement(受け付ける, {
      cases: { 入力済み: rules("非負", 入力 => [guard(ge(入力.数量, 0), 却下)], 受付) },
    });

    expect(await statuses(非負)).toStrictEqual({
      rules: ["$.数量 >= 0 holds → otherwise: gap", "$.数量 >= 0 fails → else of guard 1: no row owed"],
      arms: ["$.数量 >= 0 holds: gap", "$.数量 >= 0 else: no row owed"],
    });
  });

  it("owes no row at a way whose comparison between two positions their bounds refuse", async () => {
    const 最低と比べる = implement(受け付ける, {
      cases: {
        入力済み: rules(
          "最低と比べる",
          入力 => [guard(and(le(入力.数量, 5), ge(入力.数量, 入力.最低)), 却下)],
          受付,
        ),
      },
    });

    expect((await statuses(最低と比べる)).rules).toStrictEqual([
      "$.数量 <= 5 holds, $.数量 >= $.最低 holds → otherwise: no row owed",
      "$.数量 <= 5 holds, $.数量 >= $.最低 fails → else of guard 1: gap",
      "$.数量 <= 5 fails → else of guard 1: gap",
    ]);
  });

  it("leaves a way undecided where a condition it cannot read shares a value with another", async () => {
    const 明細を見る = implement(受け付ける, {
      cases: {
        入力済み: rules(
          "明細を見る",
          入力 => [guard(and(all(入力.明細, 行 => ge(行, 1)), ge(length(入力.明細), 1)), 却下)],
          受付,
        ),
      },
    });

    expect((await statuses(明細を見る)).rules).toStrictEqual([
      "all($.明細, $.明細[] >= 1) holds, length($.明細) >= 1 holds → otherwise: undecided",
      "all($.明細, $.明細[] >= 1) holds, length($.明細) >= 1 fails → else of guard 1: undecided",
      "all($.明細, $.明細[] >= 1) fails → else of guard 1: gap",
    ]);
  });
});

describe("a term from outside all read inside each", () => {
  const 上限を守る = behavior({
    name: "上限を守る",
    input: sum("状態", {
      入力済み: object({ 上限: integer(), 明細: array(object({ 数量: integer() })) }),
    }),
    result: sum("結果", { 受付: object({}), 超過: object({}) }),
    effects: sum("種類", {}),
  });
  const 上限で断る = implement(上限を守る, {
    cases: {
      入力済み: rules(
        "上限で断る",
        注文 => [
          guard(all(注文.明細, 行 => le(行.数量, 注文.上限)), () => ({
            result: { 結果: "超過" },
            effects: [],
          })),
        ],
        () => ({ result: { 結果: "受付" }, effects: [] }),
      ),
    },
  });

  it("is read against the scope it was written in, not against the element", async () => {
    expect(
      await runImplementation(上限で断る, { 状態: "入力済み", 上限: 1, 明細: [{ 数量: 5 }] }),
    ).toStrictEqual({ result: { 結果: "超過" }, effects: [] });
  });

  it("is described from the scope it was written in", async () => {
    const report = await evaluateSpecification(
      defineSpecification({ name: "上限", examples: examples(上限を守る, []), implementation: 上限で断る }),
    );

    expect(
      report.measures.arms.status === "unavailable"
        ? []
        : report.measures.arms.arms.map(arm => arm.guard),
    ).toStrictEqual(["all($.明細, $.明細[].数量 <= $.上限)", "all($.明細, $.明細[].数量 <= $.上限)"]);
  });

  it("draws the border between the element and the outer position", async () => {
    const report = await evaluateSpecification(
      defineSpecification({ name: "上限", examples: examples(上限を守る, []), implementation: 上限で断る }),
    );

    expect(
      report.borders.filter(border => border.rule.startsWith("guard")).map(border => border.path),
    ).toStrictEqual(["@入力済み.明細[].数量 − @入力済み.上限"]);
  });

  it("is enforced in an invariant", () => {
    const 注文 = object({ 上限: integer(), 明細: array(integer()) }).invariant(v =>
      all(v.明細, 行 => le(行, v.上限)),
    );

    expect(注文.parse({ 上限: 1, 明細: [5] }).success).toBe(false);
  });
});
