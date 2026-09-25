import { describe, expect, it } from "vitest";
import {
  generate,
  todo,
  action,
  behavior,
  compose,
  spec,
  check,
  example,
  examples,
  external,
  implement,
  int,
  object,
  guard,
  gte,
  perform,
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


const 検証するの実装 = implement(検証する, {
  cases: {
    申込: action("数量を確かめる", {
      guards: 申込 => [guard(gte(申込.数量, 1), () => ({ result: { 結果: "無効", 理由: "数量なし" }, effects: [] }))],
      run: 申込 => ({ result: { 結果: "有効", 数量: 申込.数量 }, effects: [] }),
    }),
  },
});

const 価格を付けるの実装 = implement(価格を付ける, {
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

const [見積もる, 見積もるの実装] = compose("見積もる", [検証するの実装, 価格を付けるの実装]);

describe("compose", () => {
  it("takes the first stage's input and answers the cases the second stage did not consume beside its own", () => {
    expect({
      name: 見積もる.name,
      input: 見積もる.input.variantTags,
      result: 見積もる.result.variantTags,
      effects: 見積もる.effects.variantTags,
    }).toStrictEqual({
      name: "見積もる",
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

    expect(() => compose("別物につなぐ", [検証するの実装, external(別物, "別のチーム")])).toThrow(
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

    expect(() => compose("無効も返す合成", [検証するの実装, external(無効も返す, "別のチーム")])).toThrow(
      new SpecificationError(
        "無効 departs 検証する and is answered by 無効も返す; a value cannot say which rail it is on",
      ),
    );
  });
});

describe("running a composition", () => {
  it("passes a case the second stage receives on to it", async () => {
    expect(await perform(見積もるの実装, { 状態: "申込", 数量: 2 })).toStrictEqual({
      result: { 結果: "見積", 金額: 200 },
      effects: [{ 種類: "通知", 金額: 200 }],
    });
  });

  it("answers a case the second stage does not receive as it departed", async () => {
    expect(await perform(見積もるの実装, { 状態: "申込", 数量: 0 })).toStrictEqual({
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
    const 無効を受けるの実装 = implement(無効を受ける, {
      cases: {
        見積: { kind: "decision", id: "見積を完了", run: () => ({ result: { 結果: "完了" }, effects: [] }) },
        無効: { kind: "decision", id: "無効を完了", run: () => ({ result: { 結果: "完了" }, effects: [] }) },
      },
    });
    const [三段, 三段の実装] = compose("三段", [検証するの実装, 価格を付けるの実装, 無効を受けるの実装]);

    expect({
      result: 三段.result.variantTags,
      answer: await perform(三段の実装, {
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
    const report = await check(
      spec({ name: "見積", examples: 行, implementation: 見積もるの実装 }),
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
    expect(generate(見積もる).rows.map(row => row.given)).toStrictEqual([
      { 状態: "申込", 数量: 0 },
    ]);
  });
});

describe("a composition row whose answer is owed", () => {
  it("still runs the composition, so the case it reached is executed", async () => {
    const report = await check(
      spec({
        name: "見積",
        examples: examples(見積もる, {
          "3個": { given: { 状態: "申込", 数量: 3 }, expect: todo("未定") },
        }),
        implementation: 見積もるの実装,
      }),
    );

    expect(report.evidence.input).toStrictEqual([
      { case: "申込", specified: false, executed: true, verified: false },
    ]);
  });
});

describe("composing a composition", () => {
  it("takes a composition as a stage, implemented by its own implementation", async () => {
    const 無効を受ける = behavior({
      name: "無効を受ける",
      input: variants("結果", { 見積: object({ 金額: int() }), 無効: object({ 理由: string("理由") }) }),
      result: variants("結果", { 完了: object({}) }),
      effects: variants("種類", {}),
    });
    const 無効を受けるの実装 = implement(無効を受ける, {
      cases: {
        見積: action("見積を完了", { run: () => ({ result: { 結果: "完了" as const }, effects: [] }) }),
        無効: action("無効を完了", { run: () => ({ result: { 結果: "完了" as const }, effects: [] }) }),
      },
    });

    expect(
      await perform(compose("入れ子", [見積もるの実装, 無効を受けるの実装])[1], {
        状態: "申込",
        数量: 2,
      }),
    ).toStrictEqual({ result: { 結果: "完了" }, effects: [{ 種類: "通知", 金額: 200 }] });
  });

});

describe("the stages a composition is given", () => {
  it("are at least two, at compile time", () => {
    // @ts-expect-error a composition needs two stages or more
    expect(() => compose("一段", [検証するの実装])).toThrow(SpecificationError);
  });
});

describe("a composition whose stages are still todo", () => {
  const 検証するの雛形 = implement(検証する, { cases: { 申込: todo("申込の判断が未定") } });
  const 価格を付けるの雛形 = implement(価格を付ける, { cases: { 有効: todo("有効の判断が未定") } });
  const [雛形の合成, 雛形の合成の実装] = compose("雛形の合成", [検証するの雛形, 価格を付けるの雛形]);

  it("lists each stage's open decision and counts no row as a failure", async () => {
    const report = await check(
      spec({
        name: "雛形",
        examples: examples(雛形の合成, {
          "2個": {
            given: { 状態: "申込", 数量: 2 },
            expect: { result: { 結果: "見積", 金額: 200 }, effects: [{ 種類: "通知", 金額: 200 }] },
          },
        }),
        implementation: 雛形の合成の実装,
      }),
    );

    expect({
      failures: report.failures,
      pending: report.pendingDecisions,
      incompleteness: report.incompleteness,
    }).toStrictEqual({
      failures: [],
      pending: [
        { variant: "検証する: 申込", reason: "申込の判断が未定" },
        { variant: "価格を付ける: 有効", reason: "有効の判断が未定" },
      ],
      incompleteness: [
        { kind: "row not run", subject: "2個", reason: "判断が未定（検証する: 申込）" },
      ],
    });
  });
});
