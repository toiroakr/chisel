import { describe, expect, it } from "vitest";
import {
  all,
  array,
  behavior,
  defineSpecification,
  evaluateSpecification,
  example,
  examples,
  guard,
  implement,
  integer,
  le,
  object,
  rules,
  runImplementation,
  string,
  sum,
  unanswered,
} from "../src/index.js";

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
        examples: examples(注文を確定する, [在庫あり, 在庫不足]),
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
    const report = await evaluateSpecification(
      defineSpecification({
        name: "混在",
        examples: examples(二つの状態, []),
        implementation: implement(二つの状態, {
          cases: {
            商品あり: rules("数量を確かめる", 入力 => [guard(le(入力.数量, 10), () => ({ result: {}, effects: [] }))], () => ({ result: {}, effects: [] })),
            確定済み: { kind: "decision", id: "何もしない", run: () => ({ result: {}, effects: [] }) },
          },
        }),
      }),
    );

    expect(report.measures.arms).toMatchObject({ status: "partial", notRead: ["何もしない"] });
  });
});
