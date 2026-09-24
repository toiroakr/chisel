import { describe, expect, it } from "vitest";
import {
  array,
  boolean,
  instant,
  number,
  object,
  optional,
  positionsOf,
  record,
  string,
  sum,
} from "../src/index.js";
import type { DividedPosition, Position } from "../src/index.js";

function summary(position: Position) {
  return position.kind === "divided"
    ? { path: position.path, classes: position.classes }
    : { path: position.path, kind: position.kind };
}

describe("positionsOf", () => {
  it("divides an optional field into the classes なし and あり", () => {
    const Cart = sum("状態", {
      商品あり: object({ クーポン: optional(string("クーポンコード")) }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.クーポン", classes: ["なし", "あり"] },
      { path: "@商品あり.クーポン?", kind: "not-derivable" },
    ]);
  });

  it("divides a boolean field into the classes true and false", () => {
    const Cart = sum("状態", {
      商品あり: object({ ギフト包装: boolean() }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.ギフト包装", classes: ["true", "false"] },
    ]);
  });

  it("divides a sum field into its cases", () => {
    const Cart = sum("状態", {
      商品あり: object({
        配送: sum("方法", {
          宅配: object({}),
          店頭受取: object({}),
        }),
      }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.配送", classes: ["宅配", "店頭受取"] },
    ]);
  });

  it("takes the fields of a sum field's case apart under that case", () => {
    const Cart = sum("状態", {
      商品あり: object({
        配送: sum("方法", {
          宅配: object({ 置き配: boolean() }),
        }),
      }),
    });

    expect(positionsOf(Cart).map(({ path }) => path)).toStrictEqual([
      "@商品あり.配送",
      "@商品あり.配送@宅配.置き配",
    ]);
  });

  it("reports a field no rule draws a line through as not derivable", () => {
    const Cart = sum("状態", {
      商品あり: object({
        カートID: string("カートID"),
        単価: number(),
        作成日時: instant(),
        メモ: record(string("メモ")),
      }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.カートID", kind: "not-derivable" },
      { path: "@商品あり.単価", kind: "not-derivable" },
      { path: "@商品あり.作成日時", kind: "not-derivable" },
      { path: "@商品あり.メモ", kind: "not-derivable" },
    ]);
  });

  it("takes a nested object apart field by field", () => {
    const Cart = sum("状態", {
      商品あり: object({ 配送先: object({ 置き配: boolean() }) }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.配送先.置き配", classes: ["true", "false"] },
    ]);
  });

  it("takes the elements of an array apart as one position per element field", () => {
    const Cart = sum("状態", {
      商品あり: object({
        明細: array(object({ 数量: number(), 軽減税率: boolean() })),
      }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.明細[].数量", kind: "not-derivable" },
      { path: "@商品あり.明細[].軽減税率", classes: ["true", "false"] },
    ]);
  });

  it("takes what an optional holds apart under あり", () => {
    const Cart = sum("状態", {
      商品あり: object({ クーポン: optional(object({ 自動適用: boolean() })) }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.クーポン", classes: ["なし", "あり"] },
      { path: "@商品あり.クーポン?.自動適用", classes: ["true", "false"] },
    ]);
  });
});

describe("DividedPosition.classify", () => {
  const Cart = sum("状態", {
    空: object({}),
    商品あり: object({
      クーポン: optional(string("クーポンコード")),
      明細: array(object({ 軽減税率: boolean() })),
    }),
  });
  const [クーポン, , 軽減税率] = positionsOf(Cart) as [
    DividedPosition,
    Position,
    DividedPosition,
  ];

  it("reads a missing optional field as なし", () => {
    expect(クーポン.classify({ 状態: "商品あり", 明細: [] })).toStrictEqual(["なし"]);
  });

  it("reads a present optional field as あり", () => {
    expect(
      クーポン.classify({ 状態: "商品あり", クーポン: "C-1", 明細: [] }),
    ).toStrictEqual(["あり"]);
  });

  it("reads nothing where the value is another case than the one the position stands under", () => {
    expect(クーポン.classify({ 状態: "空" })).toStrictEqual([]);
  });

  it("reads every element of an array", () => {
    expect(
      軽減税率.classify({
        状態: "商品あり",
        明細: [{ 軽減税率: true }, { 軽減税率: false }],
      }),
    ).toStrictEqual(["true", "false"]);
  });
});
