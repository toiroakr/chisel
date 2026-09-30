import { describe, expect, it } from "vitest";
import { enum as enumOf, object, variants } from "../src/index.js";

describe("every broken invariant of a value is an issue", () => {
  it("lists each invariant an object breaks, in the order they are written", () => {
    const 組 = object({ 甲: enumOf(["w", "x", "y"]), 乙: enumOf(["w", "p"]) })
      .refine(v => v.乙.$eq("w").$or(v.甲.$eq("x")))
      .refine(v => v.甲.$eq("x"));

    expect(組.parse({ 甲: "y", 乙: "p" })).toStrictEqual({
      success: false,
      issues: [
        { path: "$", message: 'Invariant violated: or($.乙 == "w", $.甲 == "x")' },
        { path: "$", message: 'Invariant violated: $.甲 == "x"' },
      ],
    });
  });

  it("lists each invariant a sum breaks, as it does for an object", () => {
    const 状態 = variants("種類", { 入力済み: object({ 甲: enumOf(["w", "x", "y"]), 乙: enumOf(["w", "p"]) }) })
      .refine(v => v.乙.$eq("w"))
      .refine(v => v.甲.$eq("x"));

    expect(状態.parse({ 種類: "入力済み", 甲: "y", 乙: "p" })).toStrictEqual({
      success: false,
      issues: [
        { path: "$", message: 'Invariant violated: $.乙 == "w"' },
        { path: "$", message: 'Invariant violated: $.甲 == "x"' },
      ],
    });
  });
});

