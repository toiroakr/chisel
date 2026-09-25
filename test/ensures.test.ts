import { describe, expect, it } from "vitest";
import {
  action,
  all,
  array,
  behavior,
  spec,
  eq,
  check,
  example,
  examples,
  and,
  gte,
  gt,
  lte,
  or,
  implement,
  int,
  object,
  perform,
  SpecificationError,
  string,
  variants,
  test,
} from "../src/index.js";

const 注文を確定する = behavior({
  name: "注文を確定する",
  input: variants("状態", { 商品あり: object({ カートID: string("カートID") }) }),
  result: variants("結果", {
    確定: object({ カートID: string("カートID") }),
    不可: object({ 理由: string("理由") }),
  }),
  effects: variants("種類", {}),
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
        商品あり: action("別のカート", {
          run: () => ({
          result: { 結果: "確定", カートID: "別のカート" },
          effects: [],
        }),
        }),
      },
    });

    await expect(
      perform(別のカートを確定する, { 状態: "商品あり", カートID: "c-1" }),
    ).rejects.toThrow(
      new SpecificationError(
        "Ensures 確定したカートは入力のカート does not hold: value.カートID == input.カートID",
      ),
    );
  });

  it("reports a row whose written answer breaks what the behavior ensures", async () => {
    const report = await check(
      spec({
        name: "確定",
        examples: examples(注文を確定する, {
          "別のカートが確定したと書いた": {
            given: { 状態: "商品あり", カートID: "c-1" },
            expect: { result: { 結果: "確定", カートID: "c-2" }, effects: [] },
          },
        }),
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
    const failures = await test(
      examples(注文を確定する, {
        "c-1を確定する": {
          given: { 状態: "商品あり", カートID: "c-1" },
          expect: { result: { 結果: "確定", カートID: "c-1" }, effects: [] },
        },
      }),
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
        input: variants("状態", { 商品あり: object({ カートID: string("カートID") }) }),
        result: variants("結果", { 確定: object({ カートID: string("カートID") }) }),
        effects: variants("種類", {}),
        ensures: clause => [clause.when("答えだけ", ["確定"], (_, 答え) => eq(答え.カートID, "x"))],
      }),
    ).toThrow(new SpecificationError("Ensures 答えだけ must relate the input to the answer"));
  });
});

describe("borders an ensures clause draws", () => {
  const 会員を探す = behavior({
    name: "会員を探す",
    input: variants("状態", { 照会: object({ 会員番号: int() }) }),
    result: variants("結果", {
      見つかった: object({ 会員番号: int() }),
      見つからない: object({}),
    }),
    effects: variants("種類", {}),
    ensures: clause => [
      clause.when("見つかる会員は番号が正で入力と同じ", ["見つかった"], (照会, 答え) =>
        and(gt(照会.会員番号, 0), eq(答え.会員番号, 照会.会員番号)),
      ),
    ],
  });

  it("draws a line where a conjunct compares the input with a constant and meets it by the value a row writes", async () => {
    const report = await check(
      spec({
        name: "照会",
        examples: examples(会員を探す, {
          "番号1の会員": {
            given: { 状態: "照会", 会員番号: 1 },
            expect: { result: { 結果: "見つかった", 会員番号: 1 }, effects: [] },
          },
        }),
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
      input: variants("状態", { 照会: object({ 会員番号: int(), 仮登録: int() }) }),
      result: variants("結果", { 見つかった: object({ 会員番号: int() }) }),
      effects: variants("種類", {}),
      ensures: clause => [
        clause.when("番号が正か仮登録", ["見つかった"], (照会, 答え) =>
          and(or(gt(照会.会員番号, 0), gt(照会.仮登録, 0)), eq(答え.会員番号, 照会.会員番号)),
        ),
      ],
    });
    const report = await check(
      spec({ name: "探す", examples: examples(探す, {}) }),
    );

    expect(report.borders).toStrictEqual([]);
  });
});

describe("an ensures clause over every element of the answer", () => {
  const 明細を返す = (rule: Parameters<typeof all>[1]) =>
    behavior({
      name: "明細を返す",
      input: variants("状態", { 入力済み: object({ 数量: int() }) }),
      result: object({ 明細: array(int()) }),
      effects: variants("種類", {}),
      ensures: clause => [clause.always("明細", (_, 答え) => all(答え.明細, rule))],
    });

  it("relates the input to the answer when it reads the input inside all", () => {
    expect(() =>
      behavior({
        name: "明細を返す",
        input: variants("状態", { 入力済み: object({ 数量: int() }) }),
        result: object({ 明細: array(int()) }),
        effects: variants("種類", {}),
        ensures: clause => [
          clause.always("明細は数量以下", (入力, 答え) => all(答え.明細, 行 => lte(行, 入力.数量))),
        ],
      }),
    ).not.toThrow();
  });

  it("holds each element to the input it reads", async () => {
    const 明細を返す = behavior({
      name: "明細を返す",
      input: variants("状態", { 入力済み: object({ 数量: int() }) }),
      result: object({ 明細: array(int()) }),
      effects: variants("種類", {}),
      ensures: clause => [
        clause.always("明細は数量以下", (入力, 答え) => all(答え.明細, 行 => lte(行, 入力.数量))),
      ],
    });
    const 多すぎる = implement(明細を返す, {
      cases: {
        入力済み: action("多すぎる", { run: () => ({ result: { 明細: [5] }, effects: [] }) }),
      },
    });

    await expect(perform(多すぎる, { 状態: "入力済み", 数量: 1 })).rejects.toThrow(
      SpecificationError,
    );
  });

  it("is still refused when all reads only the element", () => {
    expect(() => 明細を返す(行 => lte(行 as never, 3))).toThrow(
      new SpecificationError("Ensures 明細 must relate the input to the answer"),
    );
  });
});

describe("ensures clause names", () => {
  it("refuses two clauses with one name", () => {
    expect(() =>
      behavior({
        name: "二重",
        input: variants("状態", { 入力済み: object({ 数量: int() }) }),
        result: object({ 数量: int() }),
        effects: variants("種類", {}),
        ensures: clause => [
          clause.always("数量を保つ", (入力, 答え) => eq(答え.数量, 入力.数量)),
          clause.always("数量を保つ", (入力, 答え) => gt(答え.数量, 入力.数量)),
        ],
      }),
    ).toThrow(new SpecificationError("Ensures 数量を保つ is declared more than once"));
  });
});

describe("how much of an ensures rule the check reads", () => {
  const 見積もる = behavior({
    name: "見積もる",
    input: variants("状態", { 入力済み: object({ 数量: int(), 商品ID: string("商品ID") }) }),
    result: variants("結果", {
      見積: object({ 数量: int(), 商品ID: string("商品ID"), 明細: array(int()) }),
      不可: object({ 理由: string("理由") }),
      保留: object({}),
    }),
    effects: variants("種類", {}),
    ensures: clause => [
      clause.when("入力を写す", ["見積"], (入力, 答え) =>
        and(gte(答え.数量, 入力.数量), eq(答え.商品ID, 入力.商品ID)),
      ),
      clause.when("明細は数量以下", ["見積"], (入力, 答え) =>
        all(答え.明細, 行 => lte(行, 入力.数量)),
      ),
      clause.when("自明", ["不可"], (入力, 答え) => and(eq(答え.理由, 答え.理由), gt(入力.数量, -1))),
    ],
  });

  async function readings() {
    const report = await check(
      spec({ name: "見積", examples: examples(見積もる, {}) }),
    );
    return report.ensures;
  }

  it("classifies each conjunct of each rule by how much of it the check can carry", async () => {
    expect((await readings()).rules).toStrictEqual([
      {
        clause: "入力を写す",
        cases: ["見積"],
        conjunct: "value.数量 >= input.数量",
        classification: "derivable",
      },
      {
        clause: "入力を写す",
        cases: ["見積"],
        conjunct: "value.商品ID == input.商品ID",
        classification: "exact match",
      },
      {
        clause: "明細は数量以下",
        cases: ["見積"],
        conjunct: "all(value.明細, value.明細[] <= input.数量)",
        classification: "runtime only",
      },
      {
        clause: "自明",
        cases: ["不可"],
        conjunct: "value.理由 == value.理由",
        classification: "always holds",
      },
      {
        clause: "自明",
        cases: ["不可"],
        conjunct: "input.数量 > -1",
        classification: "derivable",
      },
    ]);
  });

  it("names the answer cases no rule states anything about", async () => {
    expect((await readings()).unstated).toStrictEqual(["保留"]);
  });
});
