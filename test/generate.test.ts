import { describe, expect, it } from "vitest";
import {
  array,
  behavior,
  boolean,
  example,
  examples,
  generateExamples,
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
