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
      guards: input => [input.tags["sdk-name"]!.$eq("x").$else(() => none)], run: () => none,
    }) } })).toThrow("guard in tag reads $.tags.sdk-name, which may be left out: write its absence as a case of a sum");
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
