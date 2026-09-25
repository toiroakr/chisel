import { describe, expect, it } from "vitest";
import {
  todo,
  action,
  behavior,
  compose,
  spec,
  evaluateSpecification,
  example,
  examples,
  generateExamples,
  implement,
  implementComposition,
  int,
  object,
  guard,
  gte,
  runImplementation,
  SpecificationError,
  string,
  variants,
} from "../src/index.js";

const 検証する = behavior({
  name: "検証する",
  input: variants("状態", { 申込: object({ 数量: int() }) }),
  result: variants("結果", {
    有効: object({ 数量: int() }),
    無効: object({ 理由: string("理由") }),
  }),
  effects: variants("種類", {}),
});

const 価格を付ける = behavior({
  name: "価格を付ける",
  input: variants("結果", { 有効: object({ 数量: int() }) }),
  result: variants("結果", { 見積: object({ 金額: int() }) }),
  effects: variants("種類", { 通知: object({ 金額: int() }) }),
});

const 見積もる = compose(検証する, 価格を付ける);

const 数量を確かめる = implement(検証する, {
  cases: {
    申込: action("数量を確かめる", {
      guards: 申込 => [guard(gte(申込.数量, 1), () => ({ result: { 結果: "無効", 理由: "数量なし" }, effects: [] }))],
      run: 申込 => ({ result: { 結果: "有効", 数量: 申込.数量 }, effects: [] }),
    }),
  },
});

const 単価100円 = implement(価格を付ける, {
  cases: {
    有効: {
      kind: "decision",
      id: "単価100円",
      run: 有効 => ({
        result: { 結果: "見積", 金額: 有効.数量 * 100 },
        effects: [{ 種類: "通知", 金額: 有効.数量 * 100 }],
      }),
    },
  },
  controls: {
    通知: { execution: "outbox", idempotency: "required", compensation: "none" },
  },
});

const 見積もり = implementComposition(見積もる, 数量を確かめる, 単価100円);

describe("compose", () => {
  it("takes the first stage's input and answers the cases the second stage did not consume beside its own", () => {
    expect({
      name: 見積もる.name,
      input: 見積もる.input.variantTags,
      result: 見積もる.result.variantTags,
      effects: 見積もる.effects.variantTags,
    }).toStrictEqual({
      name: "検証する >-> 価格を付ける",
      input: ["申込"],
      result: ["無効", "見積"],
      effects: ["通知"],
    });
  });

  it("refuses stages where the second receives none of the first's cases", () => {
    const 別物 = behavior({
      name: "別物",
      input: variants("結果", { 保留: object({}) }),
      result: variants("結果", { 完了: object({}) }),
      effects: variants("種類", {}),
    });

    expect(() => compose(検証する, 別物)).toThrow(
      new SpecificationError("別物 receives none of the cases 検証する answers"),
    );
  });

  it("refuses a case that would be both departed and answered by the second stage", () => {
    const 無効も返す = behavior({
      name: "無効も返す",
      input: variants("結果", { 有効: object({ 数量: int() }) }),
      result: variants("結果", { 無効: object({ 理由: string("理由") }) }),
      effects: variants("種類", {}),
    });

    expect(() => compose(検証する, 無効も返す)).toThrow(
      new SpecificationError(
        "無効 departs 検証する and is answered by 無効も返す; a value cannot say which rail it is on",
      ),
    );
  });
});

describe("running a composition", () => {
  it("passes a case the second stage receives on to it", async () => {
    expect(await runImplementation(見積もり, { 状態: "申込", 数量: 2 })).toStrictEqual({
      result: { 結果: "見積", 金額: 200 },
      effects: [{ 種類: "通知", 金額: 200 }],
    });
  });

  it("answers a case the second stage does not receive as it departed", async () => {
    expect(await runImplementation(見積もり, { 状態: "申込", 数量: 0 })).toStrictEqual({
      result: { 結果: "無効", 理由: "数量なし" },
      effects: [],
    });
  });

  it("keeps a departed case off the main line of a later stage that could receive it", async () => {
    const 無効を受ける = behavior({
      name: "無効を受ける",
      input: variants("結果", {
        見積: object({ 金額: int() }),
        無効: object({ 理由: string("理由") }),
      }),
      result: variants("結果", { 完了: object({}) }),
      effects: variants("種類", {}),
    });
    const 完了する = implement(無効を受ける, {
      cases: {
        見積: { kind: "decision", id: "見積を完了", run: () => ({ result: { 結果: "完了" }, effects: [] }) },
        無効: { kind: "decision", id: "無効を完了", run: () => ({ result: { 結果: "完了" }, effects: [] }) },
      },
    });
    const 三段 = compose(見積もる, 無効を受ける);

    expect({
      result: 三段.result.variantTags,
      answer: await runImplementation(implementComposition(三段, 見積もり, 完了する), {
        状態: "申込",
        数量: 0,
      }),
    }).toStrictEqual({
      result: ["無効", "完了"],
      answer: { result: { 結果: "無効", 理由: "数量なし" }, effects: [] },
    });
  });
});

describe("the adequacy of a composition", () => {
  const 行 = examples(見積もる, {
    "2個": {
      given: { 状態: "申込", 数量: 2 },
      expect: { result: { 結果: "見積", 金額: 200 }, effects: [{ 種類: "通知", 金額: 200 }] },
    },
    "0個は無効": {
      given: { 状態: "申込", 数量: 0 },
      expect: { result: { 結果: "無効", 理由: "数量なし" }, effects: [] },
    },
  });

  it("is measured over the composition's own cases, including one that departed early", async () => {
    const report = await evaluateSpecification(
      spec({ name: "見積", examples: 行, implementation: 見積もり }),
    );

    expect({
      failures: report.failures,
      result: report.result,
      arms: report.measures.arms,
      rules: report.measures.rules,
      verdict: report.verdict,
    }).toStrictEqual({
      failures: [],
      result: { covered: ["無効", "見積"], missing: [], excluded: [], total: 2 },
      arms: { status: "unavailable", reason: "not applicable" },
      rules: { status: "unavailable", reason: "not applicable" },
      verdict: "satisfied",
    });
  });

  it("offers rows for a composition with none", () => {
    expect(generateExamples(見積もる).map(row => row.given)).toStrictEqual([
      { 状態: "申込", 数量: 0 },
    ]);
  });
});

describe("a composition row whose answer is owed", () => {
  it("still runs the composition, so the case it reached is executed", async () => {
    const report = await evaluateSpecification(
      spec({
        name: "見積",
        examples: examples(見積もる, {
          "3個": { given: { 状態: "申込", 数量: 3 }, expect: todo("未定") },
        }),
        implementation: 見積もり,
      }),
    );

    expect(report.evidence.input).toStrictEqual([
      { case: "申込", specified: false, executed: true, verified: false },
    ]);
  });
});
