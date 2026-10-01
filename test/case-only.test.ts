import { describe, expect, it } from "vitest";
import {
  action,
  behavior,
  boolean,
  caseOf,
  check,
  dependency,
  examples,
  fake,
  implement,
  int,
  object,
  spec,
  string,
  test,
  variants,
} from "../src/index.js";

const 受け付ける = behavior("受け付ける", {
  input: variants("状態", { 入力済み: object({ 数量: int() }) }),
  result: variants("結果", { 確定: object({ 番号: string() }), 却下: object({ 理由: string() }) }),
  effects: variants("種類", { 通知: object({}) }),
  ensures: clause => [clause.when("番号がある", ["確定"], (入力, 答え) => 答え.番号.$ne("").$and(入力.数量.$gt(0)))],
});
const 通知 = { 種類: "通知" as const };
const 受付 = implement(受け付ける, {
  cases: {
    入力済み: action("受付", {
      guards: 入力 => [入力.数量.$gt(0).$else(() => ({ result: { 結果: "却下", 理由: "数量なし" }, effects: [] }))],
      run: () => ({ result: { 結果: "確定", 番号: "n-1" }, effects: [通知] }),
    }),
  },
  controls: { 通知: { execution: "direct", idempotency: "not-required", compensation: "none" } },
});
const 一件 = { 状態: "入力済み" as const, 数量: 1 };

describe("a row that expects only the case of the result, as Souther's bare case name does", () => {
  it("holds when the model answers that case, whatever its fields", async () => {
    const report = await check(
      spec("受付", {
        examples: examples(受け付ける, {
          確定する: { given: 一件, expect: { result: caseOf("確定"), effects: [通知] } },
        }),
        implementation: 受付,
      }),
    );

    expect(report.failures).toStrictEqual([]);
  });

  it("fails when the model answers another case", async () => {
    const report = await check(
      spec("受付", {
        examples: examples(受け付ける, {
          却下する: { given: 一件, expect: { result: caseOf("却下"), effects: [通知] } },
        }),
        implementation: 受付,
      }),
    );

    expect(report.failures.map(failure => failure.name)).toStrictEqual(["却下する"]);
  });

  it("still compares the effects in full", async () => {
    const report = await check(
      spec("受付", {
        examples: examples(受け付ける, {
          通知を忘れる: { given: 一件, expect: { result: caseOf("確定"), effects: [] } },
        }),
        implementation: 受付,
      }),
    );

    expect(report.failures.map(failure => failure.name)).toStrictEqual(["通知を忘れる"]);
  });

  it("specifies and verifies the result case it names", async () => {
    const report = await check(
      spec("受付", {
        examples: examples(受け付ける, {
          確定する: { given: 一件, expect: { result: caseOf("確定"), effects: [通知] } },
        }),
        implementation: 受付,
      }),
    );

    expect(report.evidence.result.find(item => item.case === "確定")).toStrictEqual({
      case: "確定",
      specified: true,
      observed: true,
      verified: true,
    });
  });

  it("refuses a case the result does not have", async () => {
    const report = await check(
      spec("受付", {
        examples: examples(受け付ける, {
          // @ts-expect-error 保留 is no case of the result
          保留する: { given: 一件, expect: { result: caseOf("保留"), effects: [] } },
        }),
        implementation: 受付,
      }),
    );

    expect(report.failures).toStrictEqual([{ name: "保留する", message: "Expected result is invalid" }]);
  });

  it("takes only what caseOf makes, as a plain object spelling it is not recognised", () => {
    examples(受け付ける, {
      // @ts-expect-error a plain object does not carry what caseOf marks
      手書き: { given: 一件, expect: { result: { kind: "case", case: "確定" }, effects: [通知] } },
    });
  });

  it("is held to the case only by test, against production code", async () => {
    const outcome = await test(
      examples(受け付ける, {
        確定する: { given: 一件, expect: { result: caseOf("確定"), effects: [通知] } },
      }),
      async () => ({ result: { 結果: "確定", 番号: "本番の番号" }, effects: [通知] }),
    );

    expect(outcome.failures).toStrictEqual([]);
  });
});

describe("a recorded row of a dependency that states only the case of its answer", () => {
  const 照会する = behavior("照会する", {
    input: variants("種別", { 商品: object({ 商品ID: string() }) }),
    result: variants("結果", { 在庫あり: object({ 在庫数: int() }), 在庫なし: object({}) }),
    effects: variants("種類", {}),
  });
  const 照会の例 = examples(照会する, {
    "商品-Aはある": { given: { 種別: "商品", 商品ID: "商品-A" }, expect: { result: caseOf("在庫あり"), effects: [] } },
  });
  const 注文する = behavior("注文する", {
    input: variants("状態", { 入力済み: object({ 商品ID: string() }) }),
    result: object({ 在庫あり: boolean() }),
    effects: variants("種類", {}),
    requires: { 在庫: dependency(照会の例) },
  });
  const warningsWith = async (answer: Parameters<typeof fake<typeof 注文する, "在庫">>[2][number][1]) =>
    (
      await check(
        spec("注文", {
          examples: examples(注文する, {}),
          fakes: [fake(注文する, "在庫", [[{ 種別: "商品", 商品ID: "商品-A" }, answer]])],
        }),
      )
    ).fakeWarnings;

  it("agrees with a fake row answering that case, whatever its fields", async () => {
    expect(await warningsWith({ 結果: "在庫あり", 在庫数: 7 })).toStrictEqual([]);
  });

  it("warns where a fake row answers another case", async () => {
    expect(await warningsWith({ 結果: "在庫なし" })).toStrictEqual([
      'Fake 在庫 row 1 answers {"結果":"在庫なし"} where 照会する example 商品-Aはある answers {"kind":"case","case":"在庫あり"}',
    ]);
  });
});
