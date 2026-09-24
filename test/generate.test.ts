import { describe, expect, it } from "vitest";
import {
  generationReport,
  not,
  array,
  behavior,
  boolean,
  eq,
  example,
  ge,
  le,
  examples,
  generateExamples,
  integer,
  length,
  number,
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

const 注文を確定する = behavior({
  name: "注文を確定する",
  input: Cart,
  result: object({}),
  effects: sum("種類", {}),
});

describe("generateExamples starts from what the rows already say", () => {
  it("moves one position of an existing row rather than composing from placeholders", () => {
    const existing = examples(注文を確定する, [
      example(注文を確定する, "クーポンなし", {
        given: { 状態: "商品あり", カートID: "カート-7" },
        expect: { result: {}, effects: [] },
      }),
    ]);

    expect(generateExamples(existing).map(row => row.given)).toStrictEqual([
      { 状態: "商品あり", カートID: "カート-7", クーポン: "<クーポンコード>" },
    ]);
  });
});

describe("generateExamples for classes", () => {
  it("offers a row for a class no row is in under a case some row already covers", () => {
    const existing = examples(注文を確定する, [
      example(注文を確定する, "クーポンなし", {
        given: { 状態: "商品あり", カートID: "c-1" },
        expect: unanswered(),
      }),
    ]);

    expect(generateExamples(existing)).toStrictEqual([
      {
        name: "注文を確定する: @商品あり.クーポン = あり",
        given: { 状態: "商品あり", カートID: "<カートID>", クーポン: "<クーポンコード>" },
        reason: "@商品あり.クーポンがありの期待結果を人間が決める必要があります",
      },
    ]);
  });

  it("lets the row composed for a case stand in the classes its placeholder falls in", () => {
    expect(generateExamples(注文を確定する).map(row => row.name)).toStrictEqual([
      "注文を確定する: 商品あり",
      "注文を確定する: @商品あり.クーポン = あり",
    ]);
  });

  it("moves a sum field into the case a position stands under", () => {
    const 配送する = behavior({
      name: "配送する",
      input: sum("状態", {
        確定済み: object({
          配送: sum("方法", {
            店頭受取: object({}),
            宅配: object({ 置き配: boolean() }),
          }),
        }),
      }),
      result: object({}),
      effects: sum("種類", {}),
    });

    expect(generateExamples(配送する).map(row => row.given)).toStrictEqual([
      { 状態: "確定済み", 配送: { 方法: "店頭受取" } },
      { 状態: "確定済み", 配送: { 方法: "宅配", 置き配: false } },
      { 状態: "確定済み", 配送: { 方法: "宅配", 置き配: true } },
    ]);
  });

  it("writes an element into an array so a class of its elements can be stood in", () => {
    const 計算する = behavior({
      name: "計算する",
      input: sum("状態", {
        商品あり: object({ 明細: array(object({ 軽減税率: boolean() })) }),
      }),
      result: object({}),
      effects: sum("種類", {}),
    });

    expect(generateExamples(計算する).map(row => row.given)).toStrictEqual([
      { 状態: "商品あり", 明細: [{ 軽減税率: false }] },
      { 状態: "商品あり", 明細: [{ 軽減税率: true }] },
    ]);
  });
});

describe("generateExamples for border points", () => {
  const 数量を確定する = behavior({
    name: "数量を確定する",
    input: sum("状態", {
      入力済み: object({ 数量: integer().invariant(v => ge(v, 1)) }),
    }),
    result: object({}),
    effects: sum("種類", {}),
  });

  it("offers a row at each owed point no row stands at", () => {
    expect(generateExamples(数量を確定する)).toStrictEqual([
      {
        name: "数量を確定する: 入力済み",
        given: { 状態: "入力済み", 数量: 1 },
        reason: "入力済みの期待結果を人間が決める必要があります",
      },
      {
        name: "数量を確定する: @入力済み.数量 IN (> 1)",
        given: { 状態: "入力済み", 数量: 2 },
        reason: "@入力済み.数量のIN点（> 1）の期待結果を人間が決める必要があります",
      },
    ]);
  });

  it("writes a value of the length a point on a length border asks for", () => {
    const 登録する = behavior({
      name: "登録する",
      input: sum("状態", {
        入力済み: object({ 商品ID: string("ID").invariant(v => ge(length(v), 4)) }),
      }),
      result: object({}),
      effects: sum("種類", {}),
    });

    expect(generateExamples(登録する).map(row => row.given)).toStrictEqual([
      { 状態: "入力済み", 商品ID: "<ID>" },
      { 状態: "入力済み", 商品ID: "<ID>_" },
    ]);
  });

  it("finds a value inside both bounds of a number", () => {
    const 割合を決める = behavior({
      name: "割合を決める",
      input: sum("状態", {
        入力済み: object({
          割合: number()
            .invariant(v => ge(v, 0))
            .invariant(v => le(v, 0.5)),
        }),
      }),
      result: object({}),
      effects: sum("種類", {}),
    });

    expect(generateExamples(割合を決める).map(row => row.given)).toStrictEqual([
      { 状態: "入力済み", 割合: 0 },
      { 状態: "入力済み", 割合: 0.25 },
      { 状態: "入力済み", 割合: 0.5 },
    ]);
  });
});

describe("generateExamples and excluded classes", () => {
  it("offers no row for a class the rules refuse", () => {
    const 同意する = behavior({
      name: "同意する",
      input: sum("状態", {
        入力済み: object({ 同意: boolean().invariant(v => eq(v, true)) }),
      }),
      result: object({}),
      effects: sum("種類", {}),
    });

    expect(generateExamples(同意する).map(row => row.given)).toStrictEqual([
      { 状態: "入力済み", 同意: true },
    ]);
  });

  it("offers rows on both sides of a border on a string value, which has no step", () => {
    const 並べる = behavior({
      name: "並べる",
      input: sum("状態", {
        入力済み: object({ 見出し: string("見出し").invariant(v => ge(v, "m")) }),
      }),
      result: object({}),
      effects: sum("種類", {}),
    });

    expect(generateExamples(並べる).map(row => row.given)).toStrictEqual([
      { 状態: "入力済み", 見出し: "m" },
      { 状態: "入力済み", 見出し: "ma" },
    ]);
  });
});

describe("rows generate cannot make valid", () => {
  it("names a row whose composed value the input schema refuses instead of offering it", () => {
    const 数える = behavior({
      name: "数える",
      input: sum("状態", { 入力済み: object({ 個数: integer().invariant(v => not(eq(v, 0))) }) }),
      result: object({}),
      effects: sum("種類", {}),
    });

    expect(generationReport(数える)).toStrictEqual({
      rows: [],
      notComposed: ["数える: 入力済み: Invariant violated: not($.個数 == 0)"],
    });
  });
});
