import { describe, expect, it } from "vitest";
import {
  behavior,
  defineSpecification,
  eq,
  evaluateSpecification,
  example,
  examples,
  implement,
  object,
  rules,
  runImplementation,
  SpecificationError,
  string,
  sum,
  verifyConformance,
} from "../src/index.js";

const 注文を確定する = behavior({
  name: "注文を確定する",
  input: sum("状態", { 商品あり: object({ カートID: string("カートID") }) }),
  result: sum("結果", {
    確定: object({ カートID: string("カートID") }),
    不可: object({ 理由: string("理由") }),
  }),
  effects: sum("種類", {}),
  ensures: clause => [
    clause.when("確定したカートは入力のカート", ["確定"], (カート, 答え) =>
      eq(答え.カートID, カート.カートID),
    ),
  ],
});

describe("ensures", () => {
  it("refuses an implementation answer that does not keep what the behavior ensures", async () => {
    const 別のカートを確定する = implement(注文を確定する, {
      cases: {
        商品あり: rules("別のカート", () => [], () => ({
          result: { 結果: "確定", カートID: "別のカート" },
          effects: [],
        })),
      },
    });

    await expect(
      runImplementation(別のカートを確定する, { 状態: "商品あり", カートID: "c-1" }),
    ).rejects.toThrow(
      new SpecificationError(
        "Ensures 確定したカートは入力のカート does not hold: value.カートID == input.カートID",
      ),
    );
  });

  it("reports a row whose written answer breaks what the behavior ensures", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "確定",
        examples: examples(注文を確定する, [
          example(注文を確定する, "別のカートが確定したと書いた", {
            given: { 状態: "商品あり", カートID: "c-1" },
            expect: { result: { 結果: "確定", カートID: "c-2" }, effects: [] },
          }),
        ]),
      }),
    );

    expect(report.failures).toStrictEqual([
      {
        name: "別のカートが確定したと書いた",
        message: "Example breaks ensures 確定したカートは入力のカート: value.カートID == input.カートID",
      },
    ]);
  });

  it("holds an outside implementation to what the behavior ensures", async () => {
    const failures = await verifyConformance(
      examples(注文を確定する, [
        example(注文を確定する, "c-1を確定する", {
          given: { 状態: "商品あり", カートID: "c-1" },
          expect: { result: { 結果: "確定", カートID: "c-1" }, effects: [] },
        }),
      ]),
      () => ({ result: { 結果: "確定", カートID: "c-9" }, effects: [] }),
    );

    expect(failures.map(failure => failure.message)).toStrictEqual([
      "Answer breaks ensures 確定したカートは入力のカート: value.カートID == input.カートID",
    ]);
  });

  it("refuses a clause that does not relate the input to the answer", () => {
    expect(() =>
      behavior({
        name: "壊れた宣言",
        input: sum("状態", { 商品あり: object({ カートID: string("カートID") }) }),
        result: sum("結果", { 確定: object({ カートID: string("カートID") }) }),
        effects: sum("種類", {}),
        ensures: clause => [clause.when("答えだけ", ["確定"], (_, 答え) => eq(答え.カートID, "x"))],
      }),
    ).toThrow(new SpecificationError("Ensures 答えだけ must relate the input to the answer"));
  });
});
