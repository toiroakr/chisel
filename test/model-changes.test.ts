import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { reportDocument } from "../src/index.js";
import { validate } from "./support/json-schema.js";
import schema from "../schema/report.schema.json" with { type: "json" };

const emptyEffects = c.variants("kind", {});
const 結果 = c.variants("結果", { 受付: c.object({}), 却下: c.object({}) });
const 却下 = () => ({ result: { 結果: "却下" as const }, effects: [] });
const 受付 = () => ({ result: { 結果: "受付" as const }, effects: [] });

// Three fields each chosen on a value of its own: the ways multiply, 2 × 2 × 4.
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
  it("names the part of a model that, declared as a behavior, leaves the rest within the limit", async () => {
    const specification = c.spec("見積", { examples: c.examples(見積, {}), implementation: 見積る });
    const report = await c.check(specification, { feasibility: { ways: 4 } });

    expect(report.toBeChangedFirst.map(({ message: _, ...change }) => change)).toStrictEqual([
      {
        decision: "見積る",
        figure: "ways",
        limit: 4,
        ways: "16",
        kind: "behavior",
        parts: [{ at: "result.丙", conditions: ["$.d > 10", "$.d > 5", "$.d > 0"], ways: "4" }],
        remaining: "4",
      },
    ]);
    expect(report.toBeChangedFirst[0]!.message).toBe(
      "見積る: 道筋が16本あり、上限の4本を超えるため計測しない。道筋はresult.甲（2本）、result.乙（2本）、result.丙（4本）の掛け算で増える。" +
        "result.丙（「$.d > 10」「$.d > 5」「$.d > 0」で選ぶ、4本）をbehaviorとして宣言し、dependencyとしてcall(deps.…)で呼べば、その選択はそのbehaviorのレポートで一度ずつ計測され、ここでは答えを値として読むので、このdecisionの道筋は4本になる。" +
        "いまのまま計測するには上限（--feasibility-ways）を16以上にする。",
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
