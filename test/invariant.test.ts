import { describe, expect, it } from "vitest";
import {
  array,
  instant,
  int,
  object,
  optional,
  string,
} from "../src/index.js";

describe("terms", () => {
  it("reads a field through a $ prefix, so a field may share its name with a method", () => {
    const 長さ付き = object({ length: int() }).invariant(v => v.$length.gte(1));

    expect([長さ付き.parse({ length: 1 }).success, 長さ付き.parse({ length: 0 }).success]).toStrictEqual([
      true,
      false,
    ]);
  });

  it("holds a chain of and only when every link holds", () => {
    const 範囲 = int().invariant(v => v.gte(1).and(v.lte(9)));

    expect([範囲.parse(0).success, 範囲.parse(5).success, 範囲.parse(10).success]).toStrictEqual([
      false,
      true,
      false,
    ]);
  });
});

describe("invariant", () => {
  const 数量 = int().invariant(v => v.gte(1));

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
    const 商品ID = string("商品ID").invariant(v => v.length().gte(3));

    expect([商品ID.parse("A-1").success, 商品ID.parse("A1").success]).toStrictEqual([
      true,
      false,
    ]);
  });

  it("measures the length of an array", () => {
    const 明細一覧 = array(int()).invariant(v => v.length().gte(1));

    expect([明細一覧.parse([1]).success, 明細一覧.parse([]).success]).toStrictEqual([
      true,
      false,
    ]);
  });

  it("orders instants", () => {
    const 受付開始後 = instant().invariant(v =>
      v.gte(Temporal.Instant.from("2026-01-01T00:00:00Z")),
    );

    expect([
      受付開始後.parse(Temporal.Instant.from("2026-01-01T00:00:00Z")).success,
      受付開始後.parse(Temporal.Instant.from("2025-12-31T23:59:59Z")).success,
    ]).toStrictEqual([true, false]);
  });

  it("relates two fields of an object and names them where it is violated", () => {
    const 期間 = object({ 開始: instant(), 終了: instant() }).invariant(v =>
      v.$開始.lt(v.$終了),
    );
    const 同時刻 = Temporal.Instant.from("2026-01-01T00:00:00Z");

    expect(期間.parse({ 開始: 同時刻, 終了: 同時刻 }, "$.期間")).toStrictEqual({
      success: false,
      issues: [{ path: "$.期間", message: "Invariant violated: $.期間.開始 < $.期間.終了" }],
    });
  });

  it("holds of an absent optional field, which has no value to compare", () => {
    const 注文 = object({ 割引額: optional(int()) }).invariant(v => v.$割引額.gte(1));

    expect(注文.parse({}).success).toBe(true);
  });

  it("does not let a comparison mix values of different types", () => {
    // @ts-expect-error a string length is a number and cannot be compared with a string
    string("商品ID").invariant(v => v.length().gte("3"));
  });
});

describe("placeholder under an invariant", () => {
  it("moves a number onto the bound it would otherwise break", () => {
    expect(int().invariant(v => v.gte(1)).placeholder()).toBe(1);
  });

  it("moves a number one step past a strict bound", () => {
    expect(int().invariant(v => v.gt(5)).placeholder()).toBe(6);
  });

  it("moves a number under an upper bound", () => {
    expect(int().invariant(v => v.lte(-3)).placeholder()).toBe(-3);
  });

  it("pads a string to the length its invariant asks for", () => {
    expect(string("ID").invariant(v => v.length().gte(6)).placeholder()).toBe("<ID>__");
  });

  it("repeats the placeholder element to the length its invariant asks for", () => {
    expect(array(string("タグ")).invariant(v => v.length().gte(2)).placeholder()).toStrictEqual([
      "<タグ>",
      "<タグ>",
    ]);
  });

  it("moves the field an object's invariant bounds", () => {
    expect(
      object({ 在庫数: int() }).invariant(v => v.$在庫数.gte(1)).placeholder(),
    ).toStrictEqual({ 在庫数: 1 });
  });
});

describe("combined conditions", () => {
  it("holds of and() only when every part holds", () => {
    const 範囲 = int().invariant(v => v.gte(1).and(v.lte(9)));

    expect([範囲.parse(5).success, 範囲.parse(10).success]).toStrictEqual([true, false]);
  });

  it("holds of or() when any part holds", () => {
    const 端 = int().invariant(v => v.lte(0).or(v.gte(10)));

    expect([端.parse(0).success, 端.parse(5).success]).toStrictEqual([true, false]);
  });

  it("holds of not() when its part does not", () => {
    expect(int().invariant(v => v.eq(0).not()).parse(0).success).toBe(false);
  });

  it("holds of any() when some element holds", () => {
    const 一つは正 = array(int()).invariant(v => v.any(element => element.gt(0)));

    expect([一つは正.parse([0, 1]).success, 一つは正.parse([0, 0]).success]).toStrictEqual([
      true,
      false,
    ]);
  });
});

describe("placeholder under a combined invariant", () => {
  it("satisfies one side of an or()", () => {
    const 端 = int().invariant(v => v.gte(5).or(v.lte(-5)));

    expect(端.parse(端.placeholder()).success).toBe(true);
  });

  it("moves one field to satisfy a rule relating it to another", () => {
    const 期間 = object({ 開始: instant(), 終了: instant() }).invariant(v => v.$開始.lt(v.$終了));

    expect(期間.parse(期間.placeholder()).success).toBe(true);
  });
});
