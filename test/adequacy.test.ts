import { describe, expect, it } from "vitest";
import {
  todo,
  action,
  behavior,
  boolean,
  spec,
  check,
  example,
  examples,
  generate,
  guard,
  implement,
  int,
  object,
  string,
  variants,
} from "../src/index.js";

const Cart = variants("状態", {
  商品あり: object({
    カートID: string(),
    クーポン: string().optional(),
  }),
});

const Outcome = variants("結果", {
  確定: object({ カートID: string() }),
});

const Effect = variants("種類", {
  決済要求: object({ カートID: string() }),
});

const 注文を確定する = behavior("注文を確定する", {
  input: Cart,
  result: Outcome,
  effects: Effect,
});

const クーポンなしで確定する = { "クーポンなしで確定する": example(注文を確定する, {
  given: { 状態: "商品あり", カートID: "c-1" },
  expect: {
    result: { 結果: "確定", カートID: "c-1" },
    effects: [{ 種類: "決済要求", カートID: "c-1" }],
  },
}) };

describe("equivalence partitions in the adequacy report", () => {
  it("counts a class as covered when an answered row's value falls in it", async () => {
    const report = await check(
      spec("注文確定", {
        examples: examples(注文を確定する, { ...クーポンなしで確定する }),
      }),
    );

    expect(report.partitions).toStrictEqual([
      { path: "@商品あり.カートID", kind: "not-derivable" },
      {
        path: "@商品あり.クーポン",
        kind: "divided",
        covered: ["なし"],
        missing: ["あり"],
        excluded: [],
      },
      { path: "@商品あり.クーポン?", kind: "not-derivable" },
    ]);
  });

  it("does not count a class as covered by a row whose answer is owed", async () => {
    const report = await check(
      spec("注文確定", {
        examples: examples(注文を確定する, {
          "クーポンありはまだ決めていない": {
            given: { 状態: "商品あり", カートID: "c-2", クーポン: "C-1" },
            expect: todo(),
          },
        }),
      }),
    );

    expect(report.partitions[1]).toStrictEqual({
      path: "@商品あり.クーポン",
      kind: "divided",
      covered: [],
      missing: ["なし", "あり"],
      excluded: [],
    });
  });

  it("is not adequate while a class no row is in remains", async () => {
    const report = await check(
      spec("注文確定", {
        examples: examples(注文を確定する, { ...クーポンなしで確定する }),
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
  const Verdict = variants("結果", {
    確定: object({ カートID: string() }),
    不可: object({ 理由: string() }),
  });
  const 判定する = behavior("判定する", {
    input: Cart,
    result: Verdict,
    effects: Effect,
  });
  const 確定を期待する = { "確定を期待する": example(判定する, {
    given: { 状態: "商品あり", カートID: "c-1" },
    expect: { result: { 結果: "確定", カートID: "c-1" }, effects: [] },
  }) };
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
    const report = await check(
      spec("判定", { examples: examples(判定する, { ...確定を期待する }) }),
    );

    expect(report.evidence.input).toStrictEqual([
      { case: "商品あり", specified: true, executed: false, verified: false },
    ]);
  });

  it("counts what a failing row saw as observed and does not count what it expected as verified", async () => {
    const report = await check(
      spec("判定", {
        examples: examples(判定する, { ...確定を期待する }),
        implementation: 常に不可,
      }),
    );

    expect(report.evidence.result).toStrictEqual([
      { case: "確定", specified: true, observed: false, verified: false },
      { case: "不可", specified: false, observed: true, verified: false },
    ]);
  });

  it("marks an input case executed but not verified when its row fails", async () => {
    const report = await check(
      spec("判定", {
        examples: examples(判定する, { ...確定を期待する }),
        implementation: 常に不可,
      }),
    );

    expect(report.evidence.input).toStrictEqual([
      { case: "商品あり", specified: true, executed: true, verified: false },
    ]);
  });

  it("marks a case verified when a row expected it and the behavior produced it", async () => {
    const report = await check(
      spec("判定", {
        examples: examples(判定する, {
          "不可を期待する": {
            given: { 状態: "商品あり", カートID: "c-1" },
            expect: { result: { 結果: "不可", 理由: "在庫不足" }, effects: [] },
          },
        }),
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
    const report = await check(
      spec("判定", {
        examples: examples(判定する, {
          "理由まで期待する": {
            given: { 状態: "商品あり", カートID: "c-1" },
            expect: { result: { 結果: "不可", 理由: "カートが空" }, effects: [] },
          },
        }),
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
    const report = await check(
      spec("判定", {
        examples: examples(判定する, {
          "決済を期待する": {
            given: { 状態: "商品あり", カートID: "c-1" },
            expect: {
              result: { 結果: "不可", 理由: "在庫不足" },
              effects: [{ 種類: "決済要求", カートID: "c-1" }],
            },
          },
        }),
        implementation: 常に不可,
      }),
    );

    expect(report.evidence.effects).toStrictEqual([
      { case: "決済要求", specified: true, observed: false, verified: false },
    ]);
  });

  it("runs a row whose answer is owed and records what it saw without specifying anything", async () => {
    const report = await check(
      spec("判定", {
        examples: examples(判定する, {
          "まだ決めていない": {
            given: { 状態: "商品あり", カートID: "c-1" },
            expect: todo(),
          },
        }),
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
  const 両方のクラス = examples(注文を確定する, {
    ...クーポンなしで確定する,
    "クーポンありで確定する": {
      given: { 状態: "商品あり", カートID: "c-2", クーポン: "C-1" },
      expect: {
        result: { 結果: "確定", カートID: "c-2" },
        effects: [{ 種類: "決済要求", カートID: "c-2" }],
      },
    },
  });

  it("says arms are not applicable when nothing implements the behavior", async () => {
    const report = await check(
      spec("注文確定", { examples: 両方のクラス }),
    );

    expect(report.measures.arms).toStrictEqual({
      status: "unavailable",
      reason: "not applicable",
    });
  });

  it("says arms are not measured and names each free-form decision as not read", async () => {
    const report = await check(
      spec("注文確定", { examples: 両方のクラス, implementation: 確定する }),
    );

    expect(report.measures.arms).toStrictEqual({
      status: "unavailable",
      reason: "not measured",
      notRead: ["確定する"],
    });
  });

  it("is not_satisfied when a measure found a gap", async () => {
    const report = await check(
      spec("注文確定", {
        examples: examples(注文を確定する, { ...クーポンなしで確定する }),
        implementation: 確定する,
      }),
    );

    expect(report.verdict).toBe("not_satisfied");
  });

  it("is undetermined rather than satisfied when no gap was found but the arms could not be read", async () => {
    const report = await check(
      spec("注文確定", { examples: 両方のクラス, implementation: 確定する }),
    );

    expect(report.verdict).toBe("undetermined");
  });
});

describe("border points in the adequacy report", () => {
  const 数量を確定する = behavior("数量を確定する", {
    input: variants("状態", {
      入力済み: object({ 数量: int().refine(v => v.$gte(1)) }),
    }),
    result: object({}),
    effects: variants("種類", {}),
  });
  const 数量で = (数量: number) =>
    ({ [`数量${数量}`]: example(数量を確定する, {
      given: { 状態: "入力済み", 数量 },
      expect: { result: {}, effects: [] },
    }) });

  it("marks a point met when an answered row's value stands at it", async () => {
    const report = await check(
      spec("数量", { examples: examples(数量を確定する, { ...数量で(1) }) }),
    );

    expect(report.borders).toStrictEqual([
      {
        path: "@入力済み.数量",
        rule: "invariant $ >= 1",
        points: [
          { role: "ON", relation: "= 1", status: "met" },
          { role: "OFF", relation: "= 0", status: "excluded" },
          { role: "IN", relation: "> 1", status: "gap" },
          { role: "OUT", relation: "< 0", status: "excluded" },
        ],
      },
    ]);
  });

  it("is not adequate while a point is owed a row", async () => {
    const report = await check(
      spec("数量", { examples: examples(数量を確定する, { ...数量で(1) }) }),
    );

    expect(report.adequate).toBe(false);
  });

  it("does not let a row whose answer is owed meet a point", async () => {
    const report = await check(
      spec("数量", {
        examples: examples(数量を確定する, {
          "まだ": { given: { 状態: "入力済み", 数量: 1 }, expect: todo() },
        }),
      }),
    );

    expect(report.borders[0]!.points[0]!.status).toBe("gap");
  });

  it("reads the length of a value where the border is drawn on its length", async () => {
    const 登録する = behavior("登録する", {
      input: variants("状態", {
        入力済み: object({ 商品ID: string().refine(v => v.$length().$gte(3)) }),
      }),
      result: object({}),
      effects: variants("種類", {}),
    });
    const report = await check(
      spec("登録", {
        examples: examples(登録する, {
          "3文字": {
            given: { 状態: "入力済み", 商品ID: "A-1" },
            expect: { result: {}, effects: [] },
          },
        }),
      }),
    );

    expect(report.borders[0]!.points.map(point => point.status)).toStrictEqual([
      "met",
      "excluded",
      "gap",
      "excluded",
    ]);
  });
});

describe("excluded classes in the adequacy report", () => {
  it("neither covers nor misses a class the rules refuse", async () => {
    const 同意する = behavior("同意する", {
      input: variants("状態", {
        入力済み: object({ 同意: boolean().refine(v => v.$eq(true)) }),
      }),
      result: object({}),
      effects: variants("種類", {}),
    });
    const report = await check(
      spec("同意", {
        examples: examples(同意する, {
          "同意した": {
            given: { 状態: "入力済み", 同意: true },
            expect: { result: {}, effects: [] },
          },
        }),
      }),
    );

    expect(report.partitions).toStrictEqual([
      {
        path: "@入力済み.同意",
        kind: "divided",
        covered: ["true"],
        missing: [],
        excluded: ["false"],
      },
    ]);
  });
});

describe("pairs of classes", () => {
  const 配送を選ぶ = behavior("配送を選ぶ", {
    input: variants("状態", {
      確定済み: object({
        ギフト: boolean(),
        配送: variants("方法", { 宅配: object({ 置き配: boolean() }), 店頭受取: object({}) }),
      }),
    }),
    result: object({}),
    effects: variants("種類", {}),
  });

  it("counts the combinations of two positions' classes the answered rows reach without asking for more", async () => {
    const report = await check(
      spec("配送", {
        examples: examples(配送を選ぶ, {
          "ギフトを宅配で置き配": {
            given: { 状態: "確定済み", ギフト: true, 配送: { 方法: "宅配", 置き配: true } },
            expect: { result: {}, effects: [] },
          },
        }),
      }),
    );

    expect(report.pairs).toStrictEqual([
      { positions: ["@確定済み.ギフト", "@確定済み.配送"], reached: 1, total: 4 },
      { positions: ["@確定済み.ギフト", "@確定済み.配送@宅配.置き配"], reached: 1, total: 4 },
    ]);
  });

  it("pairs the classes a guard threshold draws with the classes of another position", async () => {
    const 注文を受け付ける = behavior("注文を受け付ける", {
      input: variants("状態", {
        入力済み: object({ ギフト: boolean(), 合計: int().refine(v => v.$gte(0)) }),
      }),
      result: variants("結果", { 受付: object({}), 要承認: object({}) }),
      effects: variants("種類", {}),
    });
    const 上限で分ける = implement(注文を受け付ける, {
      cases: {
        入力済み: action("上限で分ける", {
          guards: 注文 => [guard(注文.合計.$lte(100000), () => ({ result: { 結果: "要承認" }, effects: [] }))],
          run: () => ({ result: { 結果: "受付" }, effects: [] }),
        }),
      },
    });
    const report = await check(
      spec("受付", {
        examples: examples(注文を受け付ける, {
          "ギフトで少額": {
            given: { 状態: "入力済み", ギフト: true, 合計: 100 },
            expect: { result: { 結果: "受付" }, effects: [] },
          },
        }),
        implementation: 上限で分ける,
      }),
    );

    expect(report.pairs).toStrictEqual([
      { positions: ["@入力済み.ギフト", "@入力済み.合計"], reached: 1, total: 4 },
    ]);
  });

  it("makes no pair of positions under two different cases", async () => {
    const 二つの状態 = behavior("二つの状態", {
      input: variants("状態", {
        下書き: object({ 公開予約: boolean() }),
        公開済み: object({ 固定表示: boolean() }),
      }),
      result: object({}),
      effects: variants("種類", {}),
    });
    const report = await check(
      spec("状態", { examples: examples(二つの状態, {}) }),
    );

    expect(report.pairs).toStrictEqual([]);
  });
});

describe("a position the invariants leave empty", () => {
  const 数量を決める = behavior("数量を決める", {
    input: variants("状態", {
      入力済み: object({
        数量: int()
          .refine(v => v.$gte(10))
          .refine(v => v.$lte(5)),
      }),
    }),
    result: object({}),
    effects: variants("種類", {}),
  });

  async function report() {
    return check(
      spec("数量", { examples: examples(数量を決める, {}) }),
    );
  }

  it("reports the position as a model error", async () => {
    expect((await report()).modelIssues).toStrictEqual([
      "@入力済み.数量: 不変条件を満たす値がありません (invariant $ >= 10, invariant $ <= 5)",
    ]);
  });

  it("owes no point of its borders", async () => {
    expect(
      (await report()).borders.flatMap(border => border.points.map(point => point.status)),
    ).not.toContain("gap");
  });
});

describe("a guard threshold interval the invariants leave empty", () => {
  it("lists the interval as excluded instead of dropping it", async () => {
    const 受け付ける = behavior("受け付ける", {
      input: variants("状態", {
        入力済み: object({
          合計: int()
            .refine(v => v.$gte(0))
            .refine(v => v.$lte(50)),
        }),
      }),
      result: variants("結果", { 受付: object({}), 要承認: object({}) }),
      effects: variants("種類", {}),
    });
    const 上限で分ける = implement(受け付ける, {
      cases: {
        入力済み: action("上限で分ける", {
          guards: 注文 => [guard(注文.合計.$lte(100000), () => ({ result: { 結果: "要承認" }, effects: [] }))],
          run: () => ({ result: { 結果: "受付" }, effects: [] }),
        }),
      },
    });
    const result = await check(
      spec("受付", {
        examples: examples(受け付ける, {}),
        implementation: 上限で分ける,
      }),
    );

    expect(result.partitions).toStrictEqual([
      {
        path: "@入力済み.合計",
        kind: "divided",
        covered: [],
        missing: ["0 <= v <= 100000"],
        excluded: ["100000 < v <= 50"],
      },
    ]);
  });
});

describe("an input case the invariants of the input sum refuse", () => {
  const 注文を処理する = behavior("注文を処理する", {
    input: variants("状態", {
      入力済み: object({}),
      廃止: object({}),
    }).refine(v => v.状態.$ne("廃止")),
    result: object({}),
    effects: variants("種類", {}),
  });

  it("is excluded from the input cases, neither covered nor missing", async () => {
    const report = await check(
      spec("処理", { examples: examples(注文を処理する, {}) }),
    );

    expect(report.input).toStrictEqual({
      covered: [],
      missing: ["入力済み"],
      excluded: ["廃止"],
      total: 1,
    });
  });

  it("is neither offered a row nor named as a row generate could not compose", () => {
    const report = generate(注文を処理する);

    expect({
      rows: report.rows.map(row => row.name),
      notComposed: report.notComposed,
    }).toStrictEqual({ rows: ["注文を処理する: 入力済み"], notComposed: [] });
  });
});
