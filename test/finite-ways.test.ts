import { describe, expect, it } from "vitest";
import { action, behavior, check, enum as enumOf, examples, generate, implement, int, object, spec, variants } from "../src/index.js";
import type { AnyBehavior, Implementation } from "../src/index.js";

const 却下 = () => ({ result: { 結果: "却下" as const }, effects: [] });
const 受付 = () => ({ result: { 結果: "受付" as const }, effects: [] });
const 結果 = variants("結果", { 受付: object({}), 却下: object({}) });

async function measured<B extends AnyBehavior>(definition: B, implementation: Implementation<B>, options = {}) {
  const report = await check(spec(definition.name, { examples: examples(definition, {}), implementation }), options);
  return {
    rules:
      report.measures.rules.status === "unavailable"
        ? report.measures.rules
        : report.measures.rules.rules.map(rule => `${rule.way}: ${rule.status}`),
    arms:
      report.measures.arms.status === "unavailable"
        ? report.measures.arms
        : report.measures.arms.arms.map(arm => `${arm.guard} ${arm.arm}: ${arm.status}`),
  };
}

  const keys = ["位置0", "位置1", "位置2", "位置3"] as const;
  const 並ぶ = behavior("並ぶ", {
    input: variants("状態", {
      入力済み: object(Object.fromEntries(keys.map(key => [key, enumOf(["無", "p", "q", "r"])])) as {
        [K in (typeof keys)[number]]: ReturnType<typeof enumOf<"無" | "p" | "q" | "r">>;
      }),
    }),
    result: 結果,
    effects: variants("種類", {}),
  });
  const 揃う = implement(並ぶ, {
    cases: {
      入力済み: action("揃う", {
        guards: v => {
          const conditions = keys.map((key, index) => {
            const opened = keys
              .slice(0, index)
              .map(earlier => v[earlier].$ne("無").$and(v[earlier].$ne("r")))
              .reduce((all, next) => all.$and(next), v.位置0.$ne("q"));
            return opened.$and(v[key].$ne("無")).$or(opened.$not().$and(v[key].$eq("無")));
          });
          return [conditions.reduce((all, next) => all.$and(next)).$else(却下)];
        },
        run: 受付,
      }),
    },
  });

  const 数える = behavior("数える", {
    input: variants("状態", { 入力済み: object({ 数: int(), 甲: enumOf(["w", "x"]), 乙: enumOf(["w", "x"]) }) }),
    result: 結果,
    effects: variants("種類", {}),
  });
  const 多い = implement(数える, {
    cases: {
      入力済み: action("多い", {
        guards: v => [
          v.数.$gte(1).$or(v.甲.$eq("w")).$or(v.乙.$eq("w")).$else(却下),
          v.数.$gte(2).$or(v.甲.$eq("x")).$or(v.乙.$eq("x")).$else(却下),
        ],
        run: 受付,
      }),
    },
  });

describe("ways measured by the combinations of finite values a decision reads", () => {
  it("owes no row at an arm only a value the input sum's invariant refuses can take", async () => {
    const 選ぶ = behavior("選ぶ", {
      input: variants("状態", { 入力済み: object({ 甲: enumOf(["w", "x", "y"]) }) }).refine(v => v.甲.$ne("w")),
      result: 結果,
      effects: variants("種類", {}),
    });
    const wなら = implement(選ぶ, {
      cases: { 入力済み: action("wなら", { guards: 入力 => [入力.甲.$eq("w").$else(却下)], run: 受付 }) },
    });

    expect((await measured(選ぶ, wなら)).arms).toStrictEqual([
      '$.甲 == "w" holds: no row owed',
      '$.甲 == "w" else: gap',
    ]);
  });

  it("owes no row at an arm an invariant rules out through a finite field the guards do not read", async () => {
    const 揃える = behavior("揃える", {
      input: variants("状態", {
        入力済み: object({ 甲: enumOf(["x", "y"]), 乙: enumOf(["x"]) }).refine(v => v.甲.$eq(v.乙)),
      }),
      result: 結果,
      effects: variants("種類", {}),
    });
    const yなら = implement(揃える, {
      cases: { 入力済み: action("yなら", { guards: 入力 => [入力.甲.$eq("y").$else(却下)], run: 受付 }) },
    });

    expect((await measured(揃える, yなら)).arms).toStrictEqual([
      '$.甲 == "y" holds: no row owed',
      '$.甲 == "y" else: gap',
    ]);
  });

  it("reaches an arm through a field left out, since a comparison of an absent value holds", async () => {
    const 選ぶ = behavior("選ぶ", {
      input: variants("状態", { 入力済み: object({ 甲: enumOf(["w", "x", "y"]).optional() }) }).refine(v =>
        v.甲.$ne("w"),
      ),
      result: 結果,
      effects: variants("種類", {}),
    });
    const wなら = implement(選ぶ, {
      cases: { 入力済み: action("wなら", { guards: 入力 => [入力.甲.$eq("w").$else(却下)], run: 受付 }) },
    });

    expect((await measured(選ぶ, wなら)).arms).toStrictEqual(['$.甲 == "w" holds: gap', '$.甲 == "w" else: gap']);
  });

  it("lists only the ways some combination takes, however many ways the guards spell", async () => {
    const started = Date.now();
    const { rules } = await measured(並ぶ, 揃う);

    expect({
      fast: Date.now() - started < 5000,
      listed: Array.isArray(rules) ? rules.length < 1024 : rules,
      owedNone: Array.isArray(rules) && rules.every(rule => !rule.endsWith("no row owed")),
    }).toStrictEqual({ fast: true, listed: true, owedNone: true });
  });

  it("leaves the ways unmeasured rather than listing more than the limit when a decision reads other values", async () => {
    expect(await measured(数える, 多い, { feasibility: { ways: 3 } })).toStrictEqual({
      rules: { status: "unavailable", reason: "not measured", notRead: ["多い"] },
      arms: { status: "unavailable", reason: "not measured", notRead: ["多い"] },
    });
  });

  it("leaves a point of a guard border undecided rather than following more ways than the limit to it", async () => {
    const report = await check(spec("数える", { examples: examples(数える, {}), implementation: 多い }), {
      feasibility: { ways: 3 },
    });

    expect(
      report.borders
        .filter(border => border.path === "@入力済み.数")
        .flatMap(border => border.points.map(point => `${point.status} ${point.reason ?? ""}`)),
    ).toStrictEqual(Array(8).fill("undecided 道筋が上限の3本を超える"));
  });
});

describe("generate over the combinations of finite values a decision reads", () => {
  it("names only the ways some combination takes, however many ways the guards spell", () => {
    const started = Date.now();
    const { notComposed } = generate(並ぶ, 揃う);

    expect({ fast: Date.now() - started < 5000, named: notComposed.length < 1024 }).toStrictEqual({
      fast: true,
      named: true,
    });
  });

  it("writes a row taking each such way from the combination that takes it", () => {
    const { rows, notComposed } = generate(並ぶ, 揃う, { ways: true });
    const wayRows = rows.filter(row => row.name.startsWith("並ぶ: 揃う "));

    expect({ notComposed, some: wayRows.length > 0 }).toStrictEqual({ notComposed: [], some: true });
  });
});

