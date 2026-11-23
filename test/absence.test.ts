import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const label = c.variants("state", { absent: c.object({}), given: c.object({ value: c.string().min(1) }) });
const owner = c.behavior("owner", {
  input: c.variants("kind", { ask: c.object({ name: label, note: c.string().optional(), tags: c.record(c.string()) }) }),
  result: c.variants("verdict", { owner: c.object({ name: c.string() }), none: c.object({}) }),
  effects: c.variants("kind", {}),
});
const none = { result: { verdict: "none" as const }, effects: [] };

describe("a comparison reading a value that may be left out", () => {
  it("is refused in a guard, naming where the value may be left out", () => {
    expect(() => c.implement(owner, { cases: { ask: c.action("note", {
      guards: input => [input.note.$eq("x").$else(() => none)], run: () => none,
    }) } })).toThrow(new c.SpecificationError("guard in note reads $.note, which may be left out: write its absence as a case of a sum"));
  });

  it("is refused for a field some cases of a sum do not declare, unless the guard has settled the case", () => {
    expect(() => c.implement(owner, { cases: { ask: c.action("value", {
      guards: input => [input.name.value.$eq("x").$else(() => none)], run: () => none,
    }) } })).toThrow("guard in value reads $.name.value, which may be left out at $.name: write its absence as a case of a sum");
    expect(() => c.implement(owner, { cases: { ask: c.action("settled", {
      guards: input => [input.name.state.$eq("given").$and(input.name.value.$eq("x")).$else(() => none)], run: () => none,
    }) } })).not.toThrow();
    expect(() => c.implement(owner, { cases: { ask: c.action("earlier guard", {
      guards: input => [input.name.state.$ne("absent").$else(() => none), input.name.value.$eq("x").$else(() => none)], run: () => none,
    }) } })).not.toThrow();
  });

  it("is refused for an entry of a record read by its key", () => {
    expect(() => c.implement(owner, { cases: { ask: c.action("tag", {
      guards: input => [input.tags["owner"]!.$eq("x").$else(() => none)], run: () => none,
    }) } })).toThrow("guard in tag reads $.tags.owner, which may be left out: write its absence as a case of a sum");
  });

  it("is refused against undefined, which no value is", () => {
    expect(() => c.object({ n: c.int() }).refine(v => v.n.$ne(undefined as never)))
      .toThrow("refine compares with undefined, which no value is: write the absence as a case of a sum");
  });

  it("is refused in a model unless a choice around it settles the case", () => {
    expect(() => c.implement(owner, { cases: { ask: c.model("unsettled", input => ({
      result: c.choose(input.name.value.$eq("x"), { verdict: "none" }, { verdict: "none" }), effects: [],
    })) } })).toThrow("model unsettled reads $.name.value, which may be left out at $.name: write its absence as a case of a sum");
    expect(() => c.implement(owner, { cases: { ask: c.model("settled", input => ({
      result: c.choose(input.name.state.$eq("given"), c.choose(input.name.value.$eq("x"), { verdict: "none" }, { verdict: "none" }), { verdict: "none" }), effects: [],
    })) } })).not.toThrow();
  });

  it("is refused in an ensures clause reading an answer field its cases may leave out", () => {
    const shape = {
      input: c.variants("kind", { ask: c.object({ n: c.int() }) }),
      result: c.variants("verdict", { some: c.object({ n: c.int() }), none: c.object({}) }),
      effects: c.variants("kind", {}),
    };
    expect(() => c.behavior("answer", { ...shape, ensures: clause => [clause.always("same", (input, value) => value.n.$eq(input.n))] }))
      .toThrow("Ensures same reads value.n, which may be left out at value: write its absence as a case of a sum");
    expect(() => c.behavior("answer", { ...shape, ensures: clause => [clause.when("same", ["some"], (input, value) => value.n.$eq(input.n))] }))
      .not.toThrow();
  });
});

describe("a comparison reading a value that may be left out, inside a quantifier or an iteration", () => {
  const lines = c.object({ lines: c.array(c.object({ n: c.int().optional() })) });

  it("names the array element by what the author wrote, not by the name its term is rooted at", () => {
    expect(() => lines.refine(v => v.lines.$all(line => line.n.$gte(0)))).toThrow(
      "refine reads $.lines[].n, which may be left out: write its absence as a case of a sum");
  });

  it("names the element of an array a model iterates over the same way", () => {
    const sum = c.behavior("sum", {
      input: c.variants("kind", { go: lines }),
      result: c.int(),
      effects: c.variants("kind", {}),
    });
    expect(() => c.implement(sum, { cases: { go: c.model("count", input => ({
      result: c.fold(c.object({ n: c.int().optional() }), c.int(), input.lines, 0, (total, line) => c.choose(line.n.$gt(0), 1, total)),
      effects: [],
    })) } })).toThrow("model count reads $.lines[].n, which may be left out: write its absence as a case of a sum");
  });
});

describe("a match over a field of the input", () => {
  const implementation = c.implement(owner, { cases: { ask: c.model("who", input => ({
    result: c.matchValue(label, input.name, {
      absent: () => ({ verdict: "none" as const }),
      given: name => ({ verdict: "owner" as const, name: name.value }),
    }),
    effects: [],
  })) } });

  it("is measured like a guard on the field's discriminant and proved under it", async () => {
    const report = await c.check(c.spec("owner", { implementation, examples: c.examples(owner, {
      absent: { given: { kind: "ask", name: { state: "absent" }, tags: {} }, expect: none },
      given: { given: { kind: "ask", name: { state: "given", value: "x" }, tags: {} }, expect: { result: { verdict: "owner", name: "x" }, effects: [] } },
    }) }));
    expect({
      arms: report.measures.arms.status,
      rules: report.measures.rules.status,
      comparisons: report.measures.comparisons.status,
      constructions: report.measures.constructions.status,
      failures: report.failures,
    }).toStrictEqual({ arms: "complete", rules: "complete", comparisons: "complete", constructions: "verified", failures: [] });
  });

  it("answers as it did before", () => {
    expect(c.performSync(implementation, { kind: "ask", name: { state: "given", value: "x" }, tags: {} }))
      .toStrictEqual({ result: { verdict: "owner", name: "x" }, effects: [] });
  });
});

describe("a guard on a field of a sum's case", () => {
  const no = () => ({ result: { 結果: "却下" as const }, effects: [] });
  const yes = () => ({ result: { 結果: "受付" as const }, effects: [] });
  const 丁 = c.variants("有無", { なし: c.object({}), あり: c.object({ 戊: c.int().min(3) }) });
  const 受け付ける = c.behavior("受け付ける", {
    input: c.variants("状態", { 入力済み: c.object({ 丁 }) }),
    result: c.variants("結果", { 受付: c.object({}), 却下: c.object({}) }),
    effects: c.variants("種類", {}),
  });
  const 五以上 = c.implement(受け付ける, { cases: { 入力済み: c.action("五以上", {
    guards: input => [input.丁.有無.$eq("あり").$and(input.丁.戊.$gte(5)).$else(no)], run: yes,
  }) } });
  const rows = c.examples(受け付ける, { なし: { given: { 状態: "入力済み", 丁: { 有無: "なし" } }, expect: no() } });

  it("draws its border on the field under the case, so generate composes each point by taking the case", () => {
    const generated = c.generate(rows, 五以上);
    expect(generated.notComposed).toStrictEqual([]);
    expect(generated.rows.map(row => [row.name.replace("受け付ける: ", ""), row.given])).toStrictEqual([
      ["@入力済み.丁 = あり", { 状態: "入力済み", 丁: { 有無: "あり", 戊: 3 } }],
      ["@入力済み.丁@あり.戊 IN (> 3)", { 状態: "入力済み", 丁: { 有無: "あり", 戊: 4 } }],
      ["@入力済み.丁@あり.戊 = 5 <= v", { 状態: "入力済み", 丁: { 有無: "あり", 戊: 5 } }],
      ["@入力済み.丁@あり.戊 IN (> 5)", { 状態: "入力済み", 丁: { 有無: "あり", 戊: 6 } }],
    ]);
  });

  it("divides the field under the case into the guard's classes", async () => {
    const report = await c.check(c.spec("受け付ける", { implementation: 五以上, examples: rows }));
    const field = report.partitions.find(partition => partition.path === "@入力済み.丁@あり.戊");
    expect(field?.kind === "divided" ? field.missing : undefined).toStrictEqual(["3 <= v < 5", "5 <= v"]);
  });
});

describe("a match over a field under a schema written again", () => {
  const written = () => c.variants("state", { absent: c.object({}), given: c.object({ value: c.string().min(1) }) });
  const asked = c.behavior("asked", {
    input: c.variants("kind", { ask: c.object({ name: written() }) }),
    result: c.variants("verdict", { owner: c.object({ name: c.string() }), none: c.object({}) }),
    effects: c.variants("kind", {}),
  });
  const rows = c.examples(asked, {
    absent: { given: { kind: "ask", name: { state: "absent" } }, expect: none },
    given: { given: { kind: "ask", name: { state: "given", value: "xyz" } }, expect: { result: { verdict: "owner", name: "xyz" }, effects: [] } },
  });
  const matching = (schema: ReturnType<typeof written>) => c.implement(asked, { cases: { ask: c.model("who", input => ({
    result: c.matchValue(schema, input.name, { absent: () => ({ verdict: "none" as const }), given: name => ({ verdict: "owner" as const, name: name.value }) }),
    effects: [],
  })) } });

  it("is measured, and proved where the field's schema holds of it", async () => {
    const report = await c.check(c.spec("asked", { implementation: matching(written()), examples: rows }));
    expect([report.measures.arms.status, report.measures.rules.status, report.measures.constructions.status]).toStrictEqual(["complete", "complete", "verified"]);
  });

  it("still parses the field with the schema it is matched under", async () => {
    const narrower = c.variants("state", { absent: c.object({}), given: c.object({ value: c.string().min(5) }) });
    const implementation = matching(narrower);
    const report = await c.check(c.spec("asked", { implementation, examples: rows }));
    expect([report.measures.arms.status, report.measures.constructions.status]).toStrictEqual(["complete", "refuted"]);
    await expect(c.perform(implementation, { kind: "ask", name: { state: "given", value: "xyz" } })).rejects.toThrow("Invalid local construction");
  });
});

describe("a guard on a field every case of a sum declares", () => {
  it("divides the field under each case", async () => {
    const no = () => ({ result: { 結果: "却下" as const }, effects: [] });
    const 丁 = c.variants("種", { 甲: c.object({ 戊: c.int().min(0) }), 乙: c.object({ 戊: c.int().min(0), 己: c.boolean() }) });
    const 受け付ける = c.behavior("受け付ける", {
      input: c.variants("状態", { 入力済み: c.object({ 丁 }) }),
      result: c.variants("結果", { 受付: c.object({}), 却下: c.object({}) }),
      effects: c.variants("種類", {}),
    });
    const 五以上 = c.implement(受け付ける, { cases: { 入力済み: c.action("五以上", {
      guards: input => [input.丁.戊.$gte(5).$else(no)], run: () => ({ result: { 結果: "受付" as const }, effects: [] }),
    }) } });
    const report = await c.check(c.spec("受け付ける", { implementation: 五以上, examples: c.examples(受け付ける, {}) }));
    const divided = (path: string) => {
      const found = report.partitions.find(partition => partition.path === path);
      return found?.kind === "divided" ? found.missing : undefined;
    };
    expect([divided("@入力済み.丁@甲.戊"), divided("@入力済み.丁@乙.戊")]).toStrictEqual([["0 <= v < 5", "5 <= v"], ["0 <= v < 5", "5 <= v"]]);
  });
});

describe("a comparison reading through a nested object some cases of a sum leave without the field", () => {
  const nested = c.variants("kind", { a: c.object({ p: c.object({ q: c.int() }) }), b: c.object({ p: c.object({}) }) });
  it("is refused where one case declares the object without the field", () => {
    expect(() => nested.refine(value => value.p.q.$gte(1))).toThrow("refine reads $.p.q, which may be left out at $.p: write its absence as a case of a sum");
  });
  it("is accepted where the discriminant condition has left only the case that declares it", () => {
    expect(() => nested.refine(value => value.kind.$ne("a").$or(value.p.q.$gte(1)))).not.toThrow();
  });
});
