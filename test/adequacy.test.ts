import { describe, expect, it } from "vitest";
import {
  behavior,
  defineSpecification,
  evaluateSpecification,
  example,
  examples,
  implement,
  object,
  optional,
  string,
  sum,
  unanswered,
} from "../src/index.js";

const Cart = sum("状態", {
  商品あり: object({
    カートID: string("カートID"),
    クーポン: optional(string("クーポンコード")),
  }),
});

const Outcome = sum("結果", {
  確定: object({ カートID: string("カートID") }),
});

const Effect = sum("種類", {
  決済要求: object({ カートID: string("カートID") }),
});

const 注文を確定する = behavior({
  name: "注文を確定する",
  input: Cart,
  result: Outcome,
  effects: Effect,
});

const クーポンなしで確定する = example(注文を確定する, "クーポンなしで確定する", {
  given: { 状態: "商品あり", カートID: "c-1" },
  expect: {
    result: { 結果: "確定", カートID: "c-1" },
    effects: [{ 種類: "決済要求", カートID: "c-1" }],
  },
});

describe("equivalence partitions in the adequacy report", () => {
  it("counts a class as covered when an answered row's value falls in it", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "注文確定",
        examples: examples(注文を確定する, [クーポンなしで確定する]),
      }),
    );

    expect(report.partitions).toStrictEqual([
      { path: "@商品あり.カートID", kind: "not-derivable" },
      {
        path: "@商品あり.クーポン",
        kind: "divided",
        covered: ["なし"],
        missing: ["あり"],
      },
      { path: "@商品あり.クーポン?", kind: "not-derivable" },
    ]);
  });

  it("does not count a class as covered by a row whose answer is owed", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "注文確定",
        examples: examples(注文を確定する, [
          example(注文を確定する, "クーポンありはまだ決めていない", {
            given: { 状態: "商品あり", カートID: "c-2", クーポン: "C-1" },
            expect: unanswered(),
          }),
        ]),
      }),
    );

    expect(report.partitions[1]).toStrictEqual({
      path: "@商品あり.クーポン",
      kind: "divided",
      covered: [],
      missing: ["なし", "あり"],
    });
  });

  it("is not adequate while a class no row is in remains", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "注文確定",
        examples: examples(注文を確定する, [クーポンなしで確定する]),
        implementation: implement(注文を確定する, {
          cases: {
            商品あり: {
              kind: "decision",
              id: "確定する",
              run: cart => ({
                result: { 結果: "確定", カートID: cart.カートID },
                effects: [{ 種類: "決済要求", カートID: cart.カートID }],
              }),
            },
          },
          controls: {
            決済要求: { execution: "queue", idempotency: "required", compensation: "manual" },
          },
        }),
      }),
    );

    expect(report.adequate).toBe(false);
  });
});

describe("graded evidence in the adequacy report", () => {
  const Verdict = sum("結果", {
    確定: object({ カートID: string("カートID") }),
    不可: object({ 理由: string("理由") }),
  });
  const 判定する = behavior({
    name: "判定する",
    input: Cart,
    result: Verdict,
    effects: Effect,
  });
  const 確定を期待する = example(判定する, "確定を期待する", {
    given: { 状態: "商品あり", カートID: "c-1" },
    expect: { result: { 結果: "確定", カートID: "c-1" }, effects: [] },
  });
  const 常に不可 = implement(判定する, {
    cases: {
      商品あり: {
        kind: "decision",
        id: "常に不可",
        run: () => ({ result: { 結果: "不可", 理由: "在庫不足" }, effects: [] }),
      },
    },
    controls: {
      決済要求: { execution: "queue", idempotency: "required", compensation: "manual" },
    },
  });

  it("reaches specified and no further for a row nothing implements yet", async () => {
    const report = await evaluateSpecification(
      defineSpecification({ name: "判定", examples: examples(判定する, [確定を期待する]) }),
    );

    expect(report.evidence.input).toStrictEqual([
      { case: "商品あり", specified: true, executed: false, verified: false },
    ]);
  });

  it("counts what a failing row saw as observed and does not count what it expected as verified", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "判定",
        examples: examples(判定する, [確定を期待する]),
        implementation: 常に不可,
      }),
    );

    expect(report.evidence.result).toStrictEqual([
      { case: "確定", specified: true, observed: false, verified: false },
      { case: "不可", specified: false, observed: true, verified: false },
    ]);
  });

  it("marks an input case executed but not verified when its row fails", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "判定",
        examples: examples(判定する, [確定を期待する]),
        implementation: 常に不可,
      }),
    );

    expect(report.evidence.input).toStrictEqual([
      { case: "商品あり", specified: true, executed: true, verified: false },
    ]);
  });

  it("marks a case verified when a row expected it and the behavior produced it", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "判定",
        examples: examples(判定する, [
          example(判定する, "不可を期待する", {
            given: { 状態: "商品あり", カートID: "c-1" },
            expect: { result: { 結果: "不可", 理由: "在庫不足" }, effects: [] },
          }),
        ]),
        implementation: 常に不可,
      }),
    );

    expect(report.evidence).toStrictEqual({
      input: [{ case: "商品あり", specified: true, executed: true, verified: true }],
      result: [
        { case: "確定", specified: false, observed: false, verified: false },
        { case: "不可", specified: true, observed: true, verified: true },
      ],
      effects: [{ case: "決済要求", specified: false, observed: false, verified: false }],
    });
  });

  it("verifies a result case by its case even when the row fails on its fields", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "判定",
        examples: examples(判定する, [
          example(判定する, "理由まで期待する", {
            given: { 状態: "商品あり", カートID: "c-1" },
            expect: { result: { 結果: "不可", 理由: "カートが空" }, effects: [] },
          }),
        ]),
        implementation: 常に不可,
      }),
    );

    expect(report.evidence.result[1]).toStrictEqual({
      case: "不可",
      specified: true,
      observed: true,
      verified: true,
    });
  });

  it("grades an effect case the same way as a result case", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "判定",
        examples: examples(判定する, [
          example(判定する, "決済を期待する", {
            given: { 状態: "商品あり", カートID: "c-1" },
            expect: {
              result: { 結果: "不可", 理由: "在庫不足" },
              effects: [{ 種類: "決済要求", カートID: "c-1" }],
            },
          }),
        ]),
        implementation: 常に不可,
      }),
    );

    expect(report.evidence.effects).toStrictEqual([
      { case: "決済要求", specified: true, observed: false, verified: false },
    ]);
  });

  it("runs a row whose answer is owed and records what it saw without specifying anything", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "判定",
        examples: examples(判定する, [
          example(判定する, "まだ決めていない", {
            given: { 状態: "商品あり", カートID: "c-1" },
            expect: unanswered(),
          }),
        ]),
        implementation: 常に不可,
      }),
    );

    expect(report.evidence).toStrictEqual({
      input: [{ case: "商品あり", specified: false, executed: true, verified: false }],
      result: [
        { case: "確定", specified: false, observed: false, verified: false },
        { case: "不可", specified: false, observed: true, verified: false },
      ],
      effects: [{ case: "決済要求", specified: false, observed: false, verified: false }],
    });
  });
});

describe("measures and verdict", () => {
  const 確定する = implement(注文を確定する, {
    cases: {
      商品あり: {
        kind: "decision",
        id: "確定する",
        run: cart => ({
          result: { 結果: "確定", カートID: cart.カートID },
          effects: [{ 種類: "決済要求", カートID: cart.カートID }],
        }),
      },
    },
    controls: {
      決済要求: { execution: "queue", idempotency: "required", compensation: "manual" },
    },
  });
  const 両方のクラス = examples(注文を確定する, [
    クーポンなしで確定する,
    example(注文を確定する, "クーポンありで確定する", {
      given: { 状態: "商品あり", カートID: "c-2", クーポン: "C-1" },
      expect: {
        result: { 結果: "確定", カートID: "c-2" },
        effects: [{ 種類: "決済要求", カートID: "c-2" }],
      },
    }),
  ]);

  it("says arms are not applicable when nothing implements the behavior", async () => {
    const report = await evaluateSpecification(
      defineSpecification({ name: "注文確定", examples: 両方のクラス }),
    );

    expect(report.measures.arms).toStrictEqual({
      status: "unavailable",
      reason: "not applicable",
    });
  });

  it("says arms are not measured and names each free-form decision as not read", async () => {
    const report = await evaluateSpecification(
      defineSpecification({ name: "注文確定", examples: 両方のクラス, implementation: 確定する }),
    );

    expect(report.measures.arms).toStrictEqual({
      status: "unavailable",
      reason: "not measured",
      notRead: ["確定する"],
    });
  });

  it("is not_satisfied when a measure found a gap", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "注文確定",
        examples: examples(注文を確定する, [クーポンなしで確定する]),
        implementation: 確定する,
      }),
    );

    expect(report.verdict).toBe("not_satisfied");
  });

  it("is undetermined rather than satisfied when no gap was found but the arms could not be read", async () => {
    const report = await evaluateSpecification(
      defineSpecification({ name: "注文確定", examples: 両方のクラス, implementation: 確定する }),
    );

    expect(report.verdict).toBe("undetermined");
  });
});
