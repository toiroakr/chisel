import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { reportDocument } from "../src/index.js";
import { eachWayOf } from "../src/ways.js";
import { validate } from "./support/json-schema.js";
import schema from "../schema/report.schema.json" with { type: "json" };

const emptyEffects = c.variants("kind", {});
const 結果 = c.variants("結果", { 受付: c.object({}), 却下: c.object({}) });
const 却下 = () => ({ result: { 結果: "却下" as const }, effects: [] });
const 受付 = () => ({ result: { 結果: "受付" as const }, effects: [] });

// Three fields each chosen on a value of its own, none reading another: their ways add up, 2 + 2 + 4.
const 見積 = c.behavior("見積", {
  input: c.variants("kind", { request: c.object({ a: c.int(), b: c.int(), d: c.int() }) }),
  result: c.object({ 甲: c.int(), 乙: c.int(), 丙: c.int() }),
  effects: emptyEffects,
});
const 見積る = c.implement(見積, {
  cases: {
    request: c.model("見積る", input => ({
      result: {
        甲: c.choose(input.a.$gt(0), 1, 0),
        乙: c.choose(input.b.$gt(0), 1, 0),
        丙: c.choose(input.d.$gt(10), 3, c.choose(input.d.$gt(5), 2, c.choose(input.d.$gt(0), 1, 0))),
      },
      effects: [],
    })),
  },
});

const 数える = c.behavior("数える", {
  input: c.variants("状態", { 入力済み: c.object({ 数: c.int(), 甲: c.enum(["w", "x"]), 乙: c.enum(["w", "x"]) }) }),
  result: 結果,
  effects: c.variants("種類", {}),
});
// Each guard holds in 3 ways and fails in 1: 1 + 3 + 3 × 3 = 13 ways.
const 多い = c.implement(数える, {
  cases: {
    入力済み: c.action("多い", {
      guards: v => [
        v.数.$gte(1).$or(v.甲.$eq("w")).$or(v.乙.$eq("w")).$else(却下),
        v.数.$gte(2).$or(v.甲.$eq("x")).$or(v.乙.$eq("x")).$else(却下),
      ],
      run: 受付,
    }),
  },
});

describe("what to change in a model before measuring it", () => {
  it("keeps cutting while the rest shrinks, however many parts that takes", () => {
    const keys = Array.from({ length: 13 }, (_, index) => `f${index}`);
    const 多数 = c.behavior("多数", {
      input: c.variants("kind", { request: c.object(Object.fromEntries(keys.map(key => [key, c.int()]))) }),
      result: c.object(Object.fromEntries(keys.map(key => [key, c.int()]))),
      effects: emptyEffects,
    });
    const implementation = c.implement(多数 as never, {
      cases: { request: c.model("多数", ((input: unknown) => ({ result: Object.fromEntries(keys.map(key => [key, c.choose((input as Record<string, c.TermOf<number>>)[key]!.$gt(0), 1, 0)])), effects: [] })) as never) },
    } as never);
    const [change] = c.modelChanges(c.spec("多数", { examples: c.examples(多数 as never, {}), implementation } as never), { feasibility: { ways: 16 } });
    expect({ kind: change?.kind, ways: change?.ways, parts: change?.parts.length, remaining: change?.remaining }).toStrictEqual({ kind: "behavior", ways: "26", parts: 5, remaining: "16" });
  });

  it("names the part of a model that, declared as a behavior, leaves the rest within the limit", async () => {
    const specification = c.spec("見積", { examples: c.examples(見積, {}), implementation: 見積る });
    const report = await c.check(specification, { feasibility: { ways: 4 } });

    expect(report.toBeChangedFirst.map(({ message: _, ...change }) => change)).toStrictEqual([
      {
        decision: "見積る",
        figure: "ways",
        limit: 4,
        ways: "8",
        kind: "behavior",
        parts: [{ at: "result.丙", conditions: ["$.d > 10", "$.d > 5", "$.d > 0"], ways: "4" }],
        remaining: "4",
      },
    ]);
    expect(report.toBeChangedFirst[0]!.message).toBe(
      "見積る: 道筋が8本あり、上限の4本を超えるため計測しない。道筋はresult.甲（2本）、result.乙（2本）、result.丙（4本）を足した数になる（互いの値を読まない部分なので、別々に数える）。" +
        "result.丙（「$.d > 10」「$.d > 5」「$.d > 0」で選ぶ、4本）をbehaviorとして宣言し、dependencyとしてcall(deps.…)で呼べば、その選択はそのbehaviorのレポートで一度ずつ計測され、ここでは答えを値として読むので、このdecisionの道筋は4本になる。" +
        "いまのまま計測するには上限（--feasibility-ways）を8以上にする。",
    );
    expect(report.measures.rules).toStrictEqual({ status: "unavailable", reason: "not measured", notRead: ["見積る"] });
    expect(report.adequate).toBe(false);
  });

  it("says it before anything is measured, and nothing where the decision is within the limit", () => {
    const specification = c.spec("見積", { examples: c.examples(見積, {}), implementation: 見積る });

    expect(c.modelChanges(specification, { feasibility: { ways: 4 } }).map(change => change.decision)).toStrictEqual(["見積る"]);
    expect(c.modelChanges(specification)).toStrictEqual([]);
    expect(c.modelChanges(c.spec("見積", { examples: c.examples(見積, {}) }))).toStrictEqual([]);
  });

  it("splits guards into stages joined with compose where each stage is within the limit", async () => {
    const report = await c.check(c.spec("数える", { examples: c.examples(数える, {}), implementation: 多い }), {
      feasibility: { ways: 5 },
    });

    expect(report.toBeChangedFirst.map(({ kind, ways, parts }) => ({ kind, ways, parts }))).toStrictEqual([
      {
        kind: "stages",
        ways: "13",
        parts: [
          { at: "guard 1", conditions: ['or(or($.数 >= 1, $.甲 == "w"), $.乙 == "w")'], ways: "4" },
          { at: "guard 2", conditions: ['or(or($.数 >= 2, $.甲 == "x"), $.乙 == "x")'], ways: "4" },
        ],
      },
    ]);
    expect(report.toBeChangedFirst[0]!.message).toContain("guard 1（4本）、guard 2（4本）をそれぞれbehaviorにしてcomposeでつなげば、各段は上限の内で計測される。");
  });

  it("says where no split brings the decision within the limit", async () => {
    const report = await c.check(c.spec("数える", { examples: c.examples(数える, {}), implementation: 多い }), {
      feasibility: { ways: 3 },
    });

    expect(report.toBeChangedFirst.map(change => change.kind)).toStrictEqual(["none"]);
    expect(report.toBeChangedFirst[0]!.message).toContain("guardを段に分けても上限の内に収まらない");
  });

  it("writes the change into the JSON report its schema accepts", async () => {
    const report = await c.check(c.spec("見積", { examples: c.examples(見積, {}), implementation: 見積る }), { feasibility: { ways: 4 } });

    expect(validate(schema as never, reportDocument([report], { id: "x", name: "x" }))).toStrictEqual([]);
  });
});

describe("the phases a check says it is on", () => {
  it("tells each phase, named by the behavior, as it enters it", async () => {
    const phases: string[] = [];
    await c.check(c.spec("見積", { examples: c.examples(見積, {}), implementation: 見積る }), { progress: phase => phases.push(phase) });

    expect(phases).toStrictEqual([
      "見積: 例の行を実行中",
      "見積: 分岐と道筋を計測中",
      "見積: foldの書き換えを確かめ中",
      "見積: 構築を証明中",
      "見積: 停止を調べ中",
    ]);
  });
});

describe("counting the ways without listing them", () => {
  it("counts a guard of thirty joined disjunctions at once", () => {
    const 多重 = c.behavior("多重", {
      input: c.variants("kind", { request: c.object(Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`f${index}`, c.int()]))) }),
      result: c.boolean(),
      effects: c.variants("種類", {}),
    });
    const implementation = c.implement(多重, {
      cases: {
        request: c.action("多重", {
          guards: v => [
            Array.from({ length: 30 }, (_, index) => (v as never as Record<string, c.TermOf<number>>)[`f${2 * index}`]!.$gt(0).$or((v as never as Record<string, c.TermOf<number>>)[`f${2 * index + 1}`]!.$gt(0)))
              .reduce((all, next) => all.$and(next))
              .$else(() => ({ result: false, effects: [] })),
          ],
          run: () => ({ result: true, effects: [] }),
        }),
      },
    });
    const started = Date.now();
    const changes = c.modelChanges(c.spec("多重", { examples: c.examples(多重, {}), implementation }));
    expect({ fast: Date.now() - started < 5000, ways: changes[0]?.ways }).toStrictEqual({ fast: true, ways: String(2n ** 30n + (2n ** 31n - 1n - 2n ** 30n)) });
  });

  it("never names a part that is itself past the limit", () => {
    const 部分 = c.behavior("部分", {
      input: c.variants("kind", { request: c.object({ a: c.int(), b: c.int(), d: c.int(), e: c.int() }) }),
      result: c.object({ x: c.int(), y: c.int() }),
      effects: c.variants("種類", {}),
    });
    const implementation = c.implement(部分, {
      cases: {
        request: c.model("部分", input => ({
          result: {
            x: c.choose(input.a.$gt(0), c.choose(input.b.$gt(0), c.choose(input.d.$gt(0), 1, 2), c.choose(input.d.$gt(0), 3, 4)), c.choose(input.b.$gt(0), c.choose(input.d.$gt(0), 5, 6), c.choose(input.d.$gt(0), 7, 8))),
            y: c.choose(input.e.$gt(0), 1, 0),
          },
          effects: [],
        })),
      },
    });
    const [change] = c.modelChanges(c.spec("部分", { examples: c.examples(部分, {}), implementation }), { feasibility: { ways: 4 } });
    expect(change?.parts.length).toBeGreaterThan(0);
    expect(change?.parts.every(part => BigInt(part.ways) <= 4n)).toBe(true);
  });

  it("lets the match be a stage of its own", () => {
    const 段 = c.behavior("段", {
      input: c.variants("kind", { request: c.object({ n: c.int(), a: c.boolean(), b: c.boolean(), level: c.enum(["x", "y", "z"]) }) }),
      result: c.boolean(),
      effects: c.variants("種類", {}),
    });
    const implementation = c.implement(段, {
      cases: {
        request: c.action("段", {
          guards: v => [v.n.$gt(0).$or(v.a.$eq(true)).$or(v.b.$eq(true)).$else(() => ({ result: false, effects: [] }))],
          run: c.match(input => input.level, { x: () => ({ result: true, effects: [] }), y: () => ({ result: true, effects: [] }), z: () => ({ result: true, effects: [] }) }),
        }),
      },
    });
    const [change] = c.modelChanges(c.spec("段", { examples: c.examples(段, {}), implementation }), { feasibility: { ways: 4 } });
    expect(change?.parts.map(part => [part.at, part.ways])).toStrictEqual([["guard 1", "4"], ["match", "3"]]);
  });
});

describe("ways inside an independent part", () => {
  const 入れ子 = c.behavior("入れ子", {
    input: c.variants("kind", { request: c.object({ a: c.int(), b: c.int(), d: c.int(), e: c.int(), f: c.int() }) }),
    result: c.object({ p: c.object({ x: c.int(), y: c.int(), z: c.int() }), q: c.int() }),
    effects: emptyEffects,
  });
  const 入れ子にする = c.implement(入れ子, {
    cases: {
      request: c.model("入れ子にする", input => ({
        result: {
          p: c.choose(input.a.$gt(0),
            { x: c.choose(input.b.$gt(0), 1, 0), y: c.choose(input.d.$gt(0), 1, 0), z: c.choose(input.e.$gt(0), 1, 0) },
            { x: 0, y: 0, z: 0 }) as never,
          q: c.choose(input.f.$gt(0), 1, 0),
        },
        effects: [],
      })),
    },
  });

  it("multiplies the fields of an object a choice answers, as the ways are listed, so a model past the limit is told what to change", () => {
    const specification = c.spec("入れ子", { examples: c.examples(入れ子, {}), implementation: 入れ子にする });
    expect([...eachWayOf(入れ子にする.cases.request as never)].length).toBe(11);
    const [change] = c.modelChanges(specification, { feasibility: { ways: 10 } });
    expect({ kind: change?.kind, ways: change?.ways }).toStrictEqual({ kind: "behavior", ways: "11" });
  });

  it("multiplies the fields of an object inside the body of a walk that a part holds, as the ways are listed", () => {
    const Rows = c.variants("kind", { request: c.object({ rows: c.array(c.int()), a: c.int(), b: c.int(), d: c.int(), f: c.int() }) });
    const Row = c.object({ x: c.int(), y: c.int(), z: c.int() });
    const walked = c.behavior("walked", { input: Rows, result: c.object({ p: c.array(Row), q: c.int() }), effects: emptyEffects });
    const implementation = c.implement(walked, { cases: { request: c.model("walked", (input: any) => ({
      result: {
        p: c.map(c.int(), Row, input.rows, (row: any) => ({ x: c.choose(row.$gt(input.a), 1, 0), y: c.choose(row.$gt(input.b), 1, 0), z: c.choose(row.$gt(input.d), 1, 0) })),
        q: c.choose(input.f.$gt(0), 1, 0),
      },
      effects: [],
    })) } } as never);
    const ways = [...eachWayOf(implementation.cases.request as never)].length;
    const [change] = c.modelChanges(c.spec("walked", { examples: c.examples(walked, {}), implementation } as never), { feasibility: { ways: ways - 1 } });
    expect(change?.ways).toBe(String(ways));
  });
});
