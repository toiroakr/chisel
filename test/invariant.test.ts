import { describe, expect, it } from "vitest";
import {
  and,
  any,
  array,
  eq,
  ge,
  gt,
  instant,
  integer,
  le,
  length,
  lt,
  not,
  object,
  optional,
  or,
  string,
} from "../src/index.js";

describe("invariant", () => {
  const 数量 = integer().invariant(v => ge(v, 1));

  it("accepts a value the invariant holds of", () => {
    expect(数量.parse(1)).toStrictEqual({ success: true, value: 1 });
  });

  it("refuses a value the invariant does not hold of", () => {
    expect(数量.parse(0)).toStrictEqual({
      success: false,
      issues: [{ path: "$", message: "Invariant violated: $ >= 1" }],
    });
  });

  it("measures the length of a string", () => {
    const 商品ID = string("商品ID").invariant(v => ge(length(v), 3));

    expect([商品ID.parse("A-1").success, 商品ID.parse("A1").success]).toStrictEqual([
      true,
      false,
    ]);
  });

  it("measures the length of an array", () => {
    const 明細一覧 = array(integer()).invariant(v => ge(length(v), 1));

    expect([明細一覧.parse([1]).success, 明細一覧.parse([]).success]).toStrictEqual([
      true,
      false,
    ]);
  });

  it("orders instants", () => {
    const 受付開始後 = instant().invariant(v =>
      ge(v, Temporal.Instant.from("2026-01-01T00:00:00Z")),
    );

    expect([
      受付開始後.parse(Temporal.Instant.from("2026-01-01T00:00:00Z")).success,
      受付開始後.parse(Temporal.Instant.from("2025-12-31T23:59:59Z")).success,
    ]).toStrictEqual([true, false]);
  });

  it("relates two fields of an object and names them where it is violated", () => {
    const 期間 = object({ 開始: instant(), 終了: instant() }).invariant(v =>
      lt(v.開始, v.終了),
    );
    const 同時刻 = Temporal.Instant.from("2026-01-01T00:00:00Z");

    expect(期間.parse({ 開始: 同時刻, 終了: 同時刻 }, "$.期間")).toStrictEqual({
      success: false,
      issues: [{ path: "$.期間", message: "Invariant violated: $.期間.開始 < $.期間.終了" }],
    });
  });

  it("holds of an absent optional field, which has no value to compare", () => {
    const 注文 = object({ 割引額: optional(integer()) }).invariant(v => ge(v.割引額, 1));

    expect(注文.parse({}).success).toBe(true);
  });

  it("does not let a comparison mix values of different types", () => {
    // @ts-expect-error a string length is a number and cannot be compared with a string
    string("商品ID").invariant(v => ge(length(v), "3"));
  });
});

describe("placeholder under an invariant", () => {
  it("moves a number onto the bound it would otherwise break", () => {
    expect(integer().invariant(v => ge(v, 1)).placeholder()).toBe(1);
  });

  it("moves a number one step past a strict bound", () => {
    expect(integer().invariant(v => gt(v, 5)).placeholder()).toBe(6);
  });

  it("moves a number under an upper bound", () => {
    expect(integer().invariant(v => le(v, -3)).placeholder()).toBe(-3);
  });

  it("pads a string to the length its invariant asks for", () => {
    expect(string("ID").invariant(v => ge(length(v), 6)).placeholder()).toBe("<ID>__");
  });

  it("repeats the placeholder element to the length its invariant asks for", () => {
    expect(array(string("タグ")).invariant(v => ge(length(v), 2)).placeholder()).toStrictEqual([
      "<タグ>",
      "<タグ>",
    ]);
  });

  it("moves the field an object's invariant bounds", () => {
    expect(
      object({ 在庫数: integer() }).invariant(v => ge(v.在庫数, 1)).placeholder(),
    ).toStrictEqual({ 在庫数: 1 });
  });
});

describe("combined conditions", () => {
  it("holds of and() only when every part holds", () => {
    const 範囲 = integer().invariant(v => and(ge(v, 1), le(v, 9)));

    expect([範囲.parse(5).success, 範囲.parse(10).success]).toStrictEqual([true, false]);
  });

  it("holds of or() when any part holds", () => {
    const 端 = integer().invariant(v => or(le(v, 0), ge(v, 10)));

    expect([端.parse(0).success, 端.parse(5).success]).toStrictEqual([true, false]);
  });

  it("holds of not() when its part does not", () => {
    expect(integer().invariant(v => not(eq(v, 0))).parse(0).success).toBe(false);
  });

  it("holds of any() when some element holds", () => {
    const 一つは正 = array(integer()).invariant(v => any(v, element => gt(element, 0)));

    expect([一つは正.parse([0, 1]).success, 一つは正.parse([0, 0]).success]).toStrictEqual([
      true,
      false,
    ]);
  });
});
