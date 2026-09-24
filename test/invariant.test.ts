import { describe, expect, it } from "vitest";
import { array, ge, instant, integer, length, lt, object, string } from "../src/index.js";

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

  it("does not let a comparison mix values of different types", () => {
    // @ts-expect-error a string length is a number and cannot be compared with a string
    string("商品ID").invariant(v => ge(length(v), "3"));
  });
});
