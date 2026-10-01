import { describe, expect, it } from "vitest";
import {
  action,
  behavior,
  boolean,
  check,
  enum as enumOf,
  examples,
  generate,
  implement,
  int,
  number,
  object,
  spec,
  variants,
} from "../src/index.js";
import type { AnyBehavior, Implementation } from "../src/index.js";

const 却下 = () => ({ result: { 結果: "却下" as const }, effects: [] });
const 受付 = () => ({ result: { 結果: "受付" as const }, effects: [] });
const 結果 = variants("結果", { 受付: object({}), 却下: object({}) });

async function rulesOf<B extends AnyBehavior>(definition: B, implementation: Implementation<B>) {
  const report = await check(spec(definition.name, { examples: examples(definition, {}), implementation }));
  return report.measures.rules.status === "unavailable"
    ? []
    : report.measures.rules.rules.map(rule => `${rule.way}: ${rule.status}`);
}

describe("feasibility reads an invariant relating finite positions", () => {
  const 判定する = behavior("判定する", {
    input: variants("状態", {
      入力済み: object({ 甲: enumOf(["w", "x"]), 乙: enumOf(["v", "y"]), 丙: boolean() }).refine(v =>
        v.甲.$eq("x").$and(v.乙.$eq("y")).$not(),
      ),
    }),
    result: 結果,
    effects: variants("種類", {}),
  });

  it("lists no way only values the invariant refuses together can take", async () => {
    const 両方そろえば = implement(判定する, {
      cases: {
        入力済み: action("両方そろえば", {
          guards: 入力 => [入力.甲.$eq("x").$and(入力.乙.$eq("y")).$else(却下)],
          run: 受付,
        }),
      },
    });

    expect(await rulesOf(判定する, 両方そろえば)).toStrictEqual([
      '$.甲 == "x" holds, $.乙 == "y" fails → else of guard 1: gap',
      '$.甲 == "x" fails → else of guard 1: gap',
    ]);
  });

  it("still owes a row at a way the invariant leaves a value for", async () => {
    const 伴う = behavior("伴う", {
      input: variants("状態", {
        入力済み: object({ 甲: enumOf(["w", "x"]), 乙: enumOf(["v", "y"]) }).refine(v =>
          v.甲.$ne("x").$or(v.乙.$eq("y")),
        ),
      }),
      result: 結果,
      effects: variants("種類", {}),
    });
    const 甲がxなら = implement(伴う, {
      cases: {
        入力済み: action("甲がxなら", {
          guards: 入力 => [入力.甲.$eq("x").$else(却下), 入力.乙.$eq("y").$else(却下)],
          run: 受付,
        }),
      },
    });

    expect(await rulesOf(伴う, 甲がxなら)).toStrictEqual([
      '$.甲 == "x" holds, $.乙 == "y" holds → otherwise: gap',
      '$.甲 == "x" fails → else of guard 1: gap',
    ]);
  });

  it("reads an invariant written on the input sum the way it reads one on the case", async () => {
    const 判定する = behavior("判定する", {
      input: variants("状態", {
        入力済み: object({ 甲: enumOf(["w", "x"]), 乙: enumOf(["v", "y"]) }),
      }).refine(v => v.甲.$eq("x").$and(v.乙.$eq("y")).$not()),
      result: 結果,
      effects: variants("種類", {}),
    });
    const 両方そろえば = implement(判定する, {
      cases: {
        入力済み: action("両方そろえば", {
          guards: 入力 => [入力.甲.$eq("x").$and(入力.乙.$eq("y")).$else(却下)],
          run: 受付,
        }),
      },
    });

    expect(await rulesOf(判定する, 両方そろえば)).toStrictEqual([
      '$.甲 == "x" holds, $.乙 == "y" fails → else of guard 1: gap',
      '$.甲 == "x" fails → else of guard 1: gap',
    ]);
  });

  it("reads the input sum's discriminant in its invariant as the case the way is under", async () => {
    const 振り分ける = behavior("振り分ける", {
      input: variants("状態", {
        第一: object({ 乙: enumOf(["v", "y"]) }),
        第二: object({ 乙: enumOf(["v", "y"]) }),
      }).refine(v => v.状態.$ne("第一").$or(v.乙.$eq("y"))),
      result: 結果,
      effects: variants("種類", {}),
    });
    const 乙がvなら = implement(振り分ける, {
      cases: {
        第一: action("第一で乙がvなら", { guards: 入力 => [入力.乙.$eq("v").$else(却下)], run: 受付 }),
        第二: action("第二で乙がvなら", { guards: 入力 => [入力.乙.$eq("v").$else(却下)], run: 受付 }),
      },
    });

    expect(await rulesOf(振り分ける, 乙がvなら)).toStrictEqual([
      '$.乙 == "v" fails → else of guard 1: gap',
      '$.乙 == "v" holds → otherwise: gap',
      '$.乙 == "v" fails → else of guard 1: gap',
    ]);
  });

  it("reads an invariant written on an object a field holds, over that object's fields", async () => {
    const 詳しく判定する = behavior("詳しく判定する", {
      input: variants("状態", {
        入力済み: object({
          詳細: object({ 甲: enumOf(["w", "x"]), 乙: enumOf(["v", "y"]) }).refine(v =>
            v.甲.$eq("x").$and(v.乙.$eq("y")).$not(),
          ),
        }),
      }),
      result: 結果,
      effects: variants("種類", {}),
    });
    const 両方そろえば = implement(詳しく判定する, {
      cases: {
        入力済み: action("両方そろえば", {
          guards: 入力 => [入力.詳細.甲.$eq("x").$and(入力.詳細.乙.$eq("y")).$else(却下)],
          run: 受付,
        }),
      },
    });

    expect(await rulesOf(詳しく判定する, 両方そろえば)).toStrictEqual([
      '$.詳細.甲 == "x" holds, $.詳細.乙 == "y" fails → else of guard 1: gap',
      '$.詳細.甲 == "x" fails → else of guard 1: gap',
    ]);
  });
});

describe("feasibility reads such an invariant with a way where the decision reads other values too", () => {
  it("owes no row at a way only values the invariant refuses together can take, beside an integer", async () => {
    const 判定する = behavior("判定する", {
      input: variants("状態", {
        入力済み: object({ 甲: enumOf(["w", "x"]), 乙: enumOf(["v", "y"]), 数: int() }).refine(v =>
          v.甲.$eq("x").$and(v.乙.$eq("y")).$not(),
        ),
      }),
      result: 結果,
      effects: variants("種類", {}),
    });
    const 両方そろえば = implement(判定する, {
      cases: {
        入力済み: action("両方そろえば", {
          guards: 入力 => [入力.甲.$eq("x").$and(入力.乙.$eq("y")).$and(入力.数.$gte(0)).$else(却下)],
          run: 受付,
        }),
      },
    });

    expect((await rulesOf(判定する, 両方そろえば))[0]).toStrictEqual(
      '$.甲 == "x" holds, $.乙 == "y" holds, $.数 >= 0 holds → otherwise: no row owed',
    );
  });
});

describe("the combinations feasibility tries against invariants", () => {
  const 判定する = behavior("判定する", {
    input: variants("状態", {
      入力済み: object({ 甲: enumOf(["w", "x"]), 乙: enumOf(["v", "y"]) }).refine(v =>
        v.甲.$eq("x").$and(v.乙.$eq("y")).$not(),
      ),
    }),
    result: 結果,
    effects: variants("種類", {}),
  });
  const 両方そろえば = implement(判定する, {
    cases: {
      入力済み: action("両方そろえば", {
        guards: 入力 => [入力.甲.$eq("x").$and(入力.乙.$eq("y")).$else(却下)],
        run: 受付,
      }),
    },
  });
  const specification = spec("判定する", { examples: examples(判定する, {}), implementation: 両方そろえば });

  it("leaves a way undecided when the values its own conditions leave exceed the limit in combinations", async () => {
    const report = await check(specification, { feasibility: { combinations: 1 } });
    const rules = report.measures.rules.status === "unavailable" ? [] : report.measures.rules.rules;

    expect(rules.map(rule => `${rule.way}: ${rule.status} ${rule.reason ?? ""}`)).toStrictEqual([
      '$.甲 == "x" holds, $.乙 == "y" holds → otherwise: no row owed ガードの条件がこの値について両立しない',
      '$.甲 == "x" holds, $.乙 == "y" fails → else of guard 1: gap ',
      '$.甲 == "x" fails → else of guard 1: undecided 不変条件とあわせて調べる値の組が上限の1通りを超える',
    ]);
  });

  it("refuses a limit that is not a positive integer", async () => {
    await expect(check(specification, { feasibility: { combinations: 0 } })).rejects.toThrow(
      "feasibility.combinations must be a positive integer, but was 0",
    );
  });
});

describe("generate keeps the invariants relating finite positions", () => {
  const 伴う = behavior("伴う", {
    input: variants("状態", {
      入力済み: object({ 甲: enumOf(["w", "x"]), 乙: enumOf(["v", "y"]), 丙: boolean() }).refine(v =>
        v.甲.$ne("x").$or(v.乙.$eq("y")),
      ),
    }),
    result: 結果,
    effects: variants("種類", {}),
  });

  it("moves the other finite positions a class row needs so the row keeps the invariant", () => {
    const { rows, notComposed } = generate(伴う);

    expect({
      row: rows.find(row => row.name === "伴う: @入力済み.甲 = x")?.given,
      notComposed,
    }).toStrictEqual({
      row: { 状態: "入力済み", 甲: "x", 乙: "y", 丙: false },
      notComposed: [],
    });
  });

  it("chooses the values of a way together so they keep an invariant relating them", () => {
    const そろえる = behavior("そろえる", {
      input: variants("状態", {
        入力済み: object({ 甲: enumOf(["p", "q", "r"]), 乙: enumOf(["p", "q", "r"]), 丙: boolean() }).refine(v =>
          v.甲.$eq(v.乙),
        ),
      }),
      result: 結果,
      effects: variants("種類", {}),
    });
    const 端を避ける = implement(そろえる, {
      cases: {
        入力済み: action("端を避ける", {
          guards: 入力 => [入力.甲.$ne("r").$and(入力.乙.$ne("p")).$and(入力.丙.$eq(true)).$else(却下)],
          run: 受付,
        }),
      },
    });
    const { rows, notComposed } = generate(そろえる, 端を避ける, { ways: true });

    expect({
      row: rows.find(row => row.name.endsWith("→ otherwise"))?.given,
      notComposed,
    }).toStrictEqual({ row: { 状態: "入力済み", 甲: "q", 乙: "q", 丙: true }, notComposed: [] });
  });

  it("tries every answered row of the case as the origin of a way row before its placeholder", () => {
    const 数える = behavior("数える", {
      input: variants("状態", {
        入力済み: object({ 甲: boolean(), 丙: boolean(), 数: int() }).refine(v => v.甲.$ne(true).$or(v.数.$gte(1))),
      }),
      result: 結果,
      effects: variants("種類", {}),
    });
    const 両方なら = implement(数える, {
      cases: {
        入力済み: action("両方なら", {
          guards: 入力 => [入力.甲.$eq(true).$and(入力.丙.$eq(true)).$else(却下)],
          run: 受付,
        }),
      },
    });
    const 記録 = examples(数える, {
      ない: { given: { 状態: "入力済み", 甲: false, 丙: false, 数: 0 }, expect: 却下() },
      ある: { given: { 状態: "入力済み", 甲: true, 丙: false, 数: 5 }, expect: 却下() },
    });

    expect(
      generate(記録, 両方なら, { ways: true }).rows.find(row => row.name.endsWith("→ otherwise"))?.given,
    ).toStrictEqual({ 状態: "入力済み", 甲: true, 丙: true, 数: 5 });
  });
});

describe("classes the invariants relating finite positions leave no combination for", () => {
  const 決まる = behavior("決まる", {
    input: variants("状態", {
      入力済み: object({ 甲: enumOf(["w", "x"]), 乙: enumOf(["v", "y"]) })
        .refine(v => v.甲.$eq("x").$or(v.乙.$eq("y")))
        .refine(v => v.甲.$ne("x").$or(v.乙.$eq("y"))),
    }),
    result: 結果,
    effects: variants("種類", {}),
  });

  it("counts a class no combination the invariants keep can take as excluded", async () => {
    const report = await check(spec("決まる", { examples: examples(決まる, {}) }));

    expect(report.partitions).toStrictEqual([
      { path: "@入力済み.甲", kind: "divided", covered: [], missing: ["w", "x"], excluded: [] },
      { path: "@入力済み.乙", kind: "divided", covered: [], missing: ["y"], excluded: ["v"] },
    ]);
  });

  it("offers no row for such a class", () => {
    const { rows, notComposed } = generate(決まる);

    expect({ rows: rows.map(row => row.name), notComposed }).toStrictEqual({
      rows: ["決まる: 入力済み", "決まる: @入力済み.甲 = x"],
      notComposed: [],
    });
  });

  it("takes the limit on the combinations it tries from the options of generate", () => {
    const { notComposed } = generate(決まる, undefined, { feasibility: { combinations: 1 } });

    expect(notComposed.filter(line => line.startsWith("決まる: @入力済み.乙 = v"))).toStrictEqual([
      '決まる: @入力済み.乙 = v: Invariant violated: or($.甲 == "x", $.乙 == "y")',
    ]);
  });

  it("refuses a limit for generate that is not a positive integer", () => {
    expect(() => generate(決まる, undefined, { feasibility: { combinations: 1.5 } })).toThrow(
      "feasibility.combinations must be a positive integer, but was 1.5",
    );
  });
});


describe("a row moved across an invariant ordering two numbers", () => {
  const 減らす = behavior("減らす", {
    input: variants("向き", {
      減: object({ 記録: int().min(1), 正: int().min(0) }).refine("減の訂正", v => v.正.$lt(v.記録)),
    }),
    result: variants("結果", { 反映: object({}) }),
    effects: variants("種類", {}),
  });

  it("moves the other number the invariant orders it against so the row keeps the invariant", () => {
    const { rows, notComposed } = generate(examples(減らす, {}));

    expect({
      row: rows.find(row => row.name === "減らす: @減.正 IN (> 0)")?.given,
      notComposed,
    }).toStrictEqual({ row: { 向き: "減", 記録: 2, 正: 1 }, notComposed: [] });
  });

  it("moves the other number the invariant orders it against through an expression", () => {
    const 余裕 = behavior("余裕", {
      input: variants("向き", {
        減: object({ 記録: int().min(1), 正: int().min(0) }).refine(v => v.正.$plus(2).$lte(v.記録)),
      }),
      result: variants("結果", { 反映: object({}) }),
      effects: variants("種類", {}),
    });
    const { rows, notComposed } = generate(examples(余裕, {}));

    expect({
      row: rows.find(row => row.name === "余裕: @減.正 IN (> 0)")?.given,
      notComposed,
    }).toStrictEqual({
      row: { 向き: "減", 記録: 3, 正: 1 },
      notComposed: ["余裕: @減.記録 ON (= 1): Invariant violated: $.正 + 2 <= $.記録"],
    });
  });

  it("moves a number the invariant orders against to a value its own bound admits, as a number takes no whole step", () => {
    const 連続 = behavior("連続", {
      input: variants("向き", {
        減: object({ 記録: number().min(1).max(1.5), 正: int().min(0) }).refine(v => v.正.$lt(v.記録)),
      }),
      result: variants("結果", { 反映: object({}) }),
      effects: variants("種類", {}),
    });
    const { rows } = generate(examples(連続, {}));
    const row = rows.find(offered => offered.name === "連続: @減.正 IN (> 0)")?.given as
      | { 記録: number; 正: number }
      | undefined;

    expect(row !== undefined && row.正 === 1 && row.記録 > 1 && row.記録 <= 1.5).toBe(true);
  });

  it("moves the other number an invariant orders against when a row stands at a point of a guard", () => {
    const 順序 = behavior("順序", {
      input: variants("向き", { 減: object({ 正: int(), 記録: int() }).refine(v => v.正.$lt(v.記録)) }),
      result: 結果,
      effects: variants("種類", {}),
    });
    const 五以上 = implement(順序, {
      cases: { 減: action("五以上", { guards: 入力 => [入力.正.$gte(5).$else(却下)], run: 受付 }) },
    });
    const { rows, notComposed } = generate(examples(順序, {}), 五以上);

    expect({
      row: rows.find(offered => offered.name === "順序: @減.正 OFF (= 4)")?.given,
      notComposed,
    }).toStrictEqual({ row: { 向き: "減", 正: 4, 記録: 5 }, notComposed: [] });
  });
});
