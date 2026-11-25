import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { describeRule } from "../src/rule.js";

const 結果 = c.variants("結果", { 受付: c.object({}), 却下: c.object({}) });
const 却下 = () => ({ result: { 結果: "却下" as const }, effects: [] });
const 受付 = () => ({ result: { 結果: "受付" as const }, effects: [] });

const 登録 = c.behavior("登録", {
  input: c.variants("kind", { request: c.object({ email: c.string(), rates: c.record(c.int()), tags: c.array(c.string()) }) }),
  result: 結果,
  effects: c.variants("種類", {}),
});
const 社員だけ = c.implement(登録, {
  cases: {
    request: c.action("社員だけ", {
      guards: v => [
        v.email.$endsWith("@example.com").$else(却下),
        v.rates.$hasKey("USD").$else(却下),
        v.tags.$includes("vip").$else(却下),
      ],
      run: 受付,
    }),
  },
});
const row = (email: string, rates: Record<string, number>, tags: string[], answer: "受付" | "却下") => ({
  given: { kind: "request" as const, email, rates, tags },
  expect: { result: { 結果: answer }, effects: [] },
});

describe("relations of a place to a value the source writes", () => {
  it("runs as the String, record and array methods do", async () => {
    await expect(c.perform(社員だけ, { kind: "request", email: "a@example.com", rates: { USD: 1 }, tags: ["vip"] })).resolves.toStrictEqual(受付());
    await expect(c.perform(社員だけ, { kind: "request", email: "a@example.org", rates: { USD: 1 }, tags: ["vip"] })).resolves.toStrictEqual(却下());
    await expect(c.perform(社員だけ, { kind: "request", email: "a@example.com", rates: { EUR: 1 }, tags: ["vip"] })).resolves.toStrictEqual(却下());
    await expect(c.perform(社員だけ, { kind: "request", email: "a@example.com", rates: { USD: 1 }, tags: [] })).resolves.toStrictEqual(却下());
  });

  it("divides each place into the classes the relation comes out in, and owes a row in each", async () => {
    const report = await c.check(c.spec("登録", { examples: c.examples(登録, { 通る: row("a@example.com", { USD: 1 }, ["vip"], "受付") }), implementation: 社員だけ }));

    expect(report.partitions.filter(partition => partition.kind === "divided").map(partition => [partition.path, partition.kind === "divided" ? partition.missing : []])).toStrictEqual([
      ["@request.email", ['¬endsWith("@example.com")']],
      ["@request.rates", ['¬hasKey("USD")']],
      ["@request.tags", ['¬includes("vip")']],
    ]);
    expect(report.measures.comparisons).toStrictEqual({ status: "complete" });
  });

  it("offers a row in each class no row stands in", () => {
    const { rows } = c.generate(c.examples(登録, { 通る: row("a@example.com", { USD: 1 }, ["vip"], "受付") }), 社員だけ);

    expect(rows.filter(item => !item.name.includes(" × ")).map(item => [item.name, item.given])).toStrictEqual([
      ['登録: @request.email = ¬endsWith("@example.com")', { kind: "request", email: "", rates: { USD: 1 }, tags: ["vip"] }],
      ['登録: @request.rates = ¬hasKey("USD")', { kind: "request", email: "a@example.com", rates: {}, tags: ["vip"] }],
      ['登録: @request.tags = ¬includes("vip")', { kind: "request", email: "a@example.com", rates: { USD: 1 }, tags: [] }],
    ]);
  });

  it("describes a relation as the reports write it", () => {
    expect(社員だけ.cases.request.kind === "rules" && 社員だけ.cases.request.guards.map(guard => describeRule(guard.condition))).toStrictEqual([
      'endsWith($.email, "@example.com")',
      'hasKey($.rates, "USD")',
      'includes($.tags, "vip")',
    ]);
  });
});

describe("relations in a model, in feasibility and in the absence check", () => {
  const 判定 = c.behavior("判定", {
    input: c.variants("kind", { request: c.object({ code: c.string(), prefix: c.string(), note: c.string().optional() }) }),
    result: c.enum(["A", "B", "C"]),
    effects: c.variants("種類", {}),
  });

  it("chooses on a relation in a model, a bound field read through it", async () => {
    const implementation = c.implement(判定, {
      cases: {
        request: c.model("判定する", input => ({
          result: c.bind(c.string(), input.code, code => c.choose(code.$startsWith("AB"), "A" as const, c.choose(code.$startsWith(input.prefix), "B" as const, "C" as const))),
          effects: [],
        })),
      },
    });
    await expect(c.perform(implementation, { kind: "request", code: "ABC", prefix: "X" })).resolves.toStrictEqual({ result: "A", effects: [] });
    await expect(c.perform(implementation, { kind: "request", code: "XY", prefix: "X" })).resolves.toStrictEqual({ result: "B", effects: [] });
    await expect(c.perform(implementation, { kind: "request", code: "QQ", prefix: "X" })).resolves.toStrictEqual({ result: "C", effects: [] });
  });

  it("owes no row on a way whose relations contradict each other by their laws", async () => {
    const implementation = c.implement(判定, {
      cases: {
        request: c.model("矛盾", input => ({
          result: c.choose(input.code.$startsWith("AB"), c.choose(input.code.$startsWith("A"), "A" as const, "B" as const), "C" as const),
          effects: [],
        })),
      },
    });
    const report = await c.check(c.spec("判定", { examples: c.examples(判定, {}), implementation }));

    expect(report.measures.rules.status === "complete" ? report.measures.rules.rules.map(rule => `${rule.way}: ${rule.status}`) : report.measures.rules).toStrictEqual([
      'startsWith($.code, "AB") holds, startsWith($.code, "A") holds → otherwise: gap',
      'startsWith($.code, "AB") holds, startsWith($.code, "A") fails → otherwise: no row owed',
      'startsWith($.code, "AB") fails → otherwise: gap',
    ]);
  });

  it("refuses a relation reading a field that may be left out", () => {
    expect(() => c.implement(判定, {
      cases: { request: c.action("読む", { guards: v => [v.note.$contains("x").$else(() => ({ result: "C" as const, effects: [] }))], run: () => ({ result: "A" as const, effects: [] }) }) },
    })).toThrow("reads $.note, which may be left out");
  });
});
