import { describe, expect, it } from "vitest";
import {
  all,
  array,
  behavior,
  defineSpecification,
  eq,
  evaluateSpecification,
  example,
  examples,
  and,
  gt,
  le,
  or,
  implement,
  integer,
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

describe("borders an ensures clause draws", () => {
  const 会員を探す = behavior({
    name: "会員を探す",
    input: sum("状態", { 照会: object({ 会員番号: integer() }) }),
    result: sum("結果", {
      見つかった: object({ 会員番号: integer() }),
      見つからない: object({}),
    }),
    effects: sum("種類", {}),
    ensures: clause => [
      clause.when("見つかる会員は番号が正で入力と同じ", ["見つかった"], (照会, 答え) =>
        and(gt(照会.会員番号, 0), eq(答え.会員番号, 照会.会員番号)),
      ),
    ],
  });

  it("draws a line where a conjunct compares the input with a constant and meets it by the value a row writes", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "照会",
        examples: examples(会員を探す, [
          example(会員を探す, "番号1の会員", {
            given: { 状態: "照会", 会員番号: 1 },
            expect: { result: { 結果: "見つかった", 会員番号: 1 }, effects: [] },
          }),
        ]),
      }),
    );

    expect(report.borders).toStrictEqual([
      {
        path: "@照会.会員番号",
        rule: "ensures 見つかる会員は番号が正で入力と同じ: input.会員番号 > 0",
        points: [
          { role: "ON", relation: "= 1", status: "met" },
          { role: "OFF", relation: "= 0", status: "gap" },
          { role: "IN", relation: "> 1", status: "gap" },
          { role: "OUT", relation: "< 0", status: "gap" },
        ],
      },
    ]);
  });

  it("draws nothing for a comparison under or(), which the rule does not require", async () => {
    const 探す = behavior({
      name: "探す",
      input: sum("状態", { 照会: object({ 会員番号: integer(), 仮登録: integer() }) }),
      result: sum("結果", { 見つかった: object({ 会員番号: integer() }) }),
      effects: sum("種類", {}),
      ensures: clause => [
        clause.when("番号が正か仮登録", ["見つかった"], (照会, 答え) =>
          and(or(gt(照会.会員番号, 0), gt(照会.仮登録, 0)), eq(答え.会員番号, 照会.会員番号)),
        ),
      ],
    });
    const report = await evaluateSpecification(
      defineSpecification({ name: "探す", examples: examples(探す, []) }),
    );

    expect(report.borders).toStrictEqual([]);
  });
});

describe("an ensures clause over every element of the answer", () => {
  const 明細を返す = (rule: Parameters<typeof all>[1]) =>
    behavior({
      name: "明細を返す",
      input: sum("状態", { 入力済み: object({ 数量: integer() }) }),
      result: object({ 明細: array(integer()) }),
      effects: sum("種類", {}),
      ensures: clause => [clause.always("明細", (_, 答え) => all(答え.明細, rule))],
    });

  it("relates the input to the answer when it reads the input inside all", () => {
    expect(() =>
      behavior({
        name: "明細を返す",
        input: sum("状態", { 入力済み: object({ 数量: integer() }) }),
        result: object({ 明細: array(integer()) }),
        effects: sum("種類", {}),
        ensures: clause => [
          clause.always("明細は数量以下", (入力, 答え) => all(答え.明細, 行 => le(行, 入力.数量))),
        ],
      }),
    ).not.toThrow();
  });

  it("holds each element to the input it reads", async () => {
    const 明細を返す = behavior({
      name: "明細を返す",
      input: sum("状態", { 入力済み: object({ 数量: integer() }) }),
      result: object({ 明細: array(integer()) }),
      effects: sum("種類", {}),
      ensures: clause => [
        clause.always("明細は数量以下", (入力, 答え) => all(答え.明細, 行 => le(行, 入力.数量))),
      ],
    });
    const 多すぎる = implement(明細を返す, {
      cases: {
        入力済み: rules("多すぎる", () => [], () => ({ result: { 明細: [5] }, effects: [] })),
      },
    });

    await expect(runImplementation(多すぎる, { 状態: "入力済み", 数量: 1 })).rejects.toThrow(
      SpecificationError,
    );
  });

  it("is still refused when all reads only the element", () => {
    expect(() => 明細を返す(行 => le(行 as never, 3))).toThrow(
      new SpecificationError("Ensures 明細 must relate the input to the answer"),
    );
  });
});
