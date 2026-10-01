import { describe, expect, it } from "vitest";
import { behavior, check, enum as enumOf, examples, int, object, spec, variants } from "../src/index.js";

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

describe("an invariant given a name", () => {
  it("names the invariant it breaks in the issue, beside one written without a name", () => {
    const 組 = object({ 甲: enumOf(["w", "x", "y"]), 乙: enumOf(["w", "p"]) })
      .refine("乙は甲に従う", v => v.乙.$eq("w").$or(v.甲.$eq("x")))
      .refine(v => v.甲.$eq("x"));

    expect(組.parse({ 甲: "y", 乙: "p" })).toStrictEqual({
      success: false,
      issues: [
        {
          path: "$",
          message: 'Invariant 乙は甲に従う violated: or($.乙 == "w", $.甲 == "x")',
          invariant: "乙は甲に従う",
        },
        { path: "$", message: 'Invariant violated: $.甲 == "x"' },
      ],
    });
  });

  it("names an invariant a shorthand writes", () => {
    expect(int().min("一つ以上", 1).parse(0)).toStrictEqual({
      success: false,
      issues: [{ path: "$", message: "Invariant 一つ以上 violated: $ >= 1", invariant: "一つ以上" }],
    });
  });

  it("refuses a name one schema gives two of its invariants", () => {
    const 組 = object({ 甲: enumOf(["w", "x"]) }).refine("甲を選ぶ", v => v.甲.$ne("w"));

    expect(() => 組.refine("甲を選ぶ", v => v.甲.$eq("x"))).toThrow(
      "Invariant 甲を選ぶ is declared more than once",
    );
  });
});

describe("the analysis names an invariant given a name", () => {
  it("names it in the borders it draws and the positions it leaves nothing at", async () => {
    const 数える = behavior("数える", {
      input: variants("状態", {
        入力済み: object({
          数: int().min("十以上", 10).max(5),
          量: int(),
          幅: int(),
        })
          .refine("量は負でない", v => v.量.$gte(0))
          .refine("幅は一桁", v => v.幅.$gte(1).$and(v.幅.$lte(9))),
      }),
      result: object({}),
      effects: variants("種類", {}),
    });
    const report = await check(spec("数える", { examples: examples(数える, {}) }));

    expect({ modelIssues: report.modelIssues, borders: report.borders.map(border => border.rule) }).toStrictEqual({
      modelIssues: ["@入力済み.数: 不変条件を満たす値がありません (invariant 十以上: $ >= 10, invariant $ <= 5)"],
      borders: [
        "invariant 十以上: $ >= 10",
        "invariant $ <= 5",
        "invariant 量は負でない: $ >= 0",
        "invariant 幅は一桁: $ >= 1",
        "invariant 幅は一桁: $ <= 9",
      ],
    });
  });
});

