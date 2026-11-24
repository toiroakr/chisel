import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { Decimal } from "decimal.js";
import { interpret } from "../src/model.js";
import { identityOf } from "../src/proof.js";
import { linearCombination, positionTerm } from "../src/rule.js";

const effects = c.variants("kind", {});
const answer = c.variants("v", { yes: c.object({}), no: c.object({}) });
const yes = { v: "yes" as const }, no = { v: "no" as const };
type Answer = c.Infer<typeof answer>;

// What the model answers as written, before implement reads its bindings where
// they are read, and what the implemented model answers.
function bothWays<I extends Record<string, unknown>>(shape: c.Schema<I>, build: (input: c.TermOf<I>) => unknown, inputs: readonly I[]) {
  const definition = c.behavior("same", { input: c.variants("kind", { go: shape as never }), result: answer, effects });
  const decision = c.model("same", input => ({ result: build(input as never) as never, effects: [] }));
  const implementation = c.implement(definition, { cases: { go: decision } } as never);
  return inputs.map(given => {
    const input = { kind: "go", ...given };
    const written = (interpret((decision as { expression: unknown }).expression, input) as { result: Answer }).result;
    const performed = c.performSync(implementation as never, input as never).result;
    return [written, performed];
  });
}

describe("implement answers as the model is written", () => {
  it("adds numbers in floating point", () => {
    const shape = c.object({ a: c.number(), b: c.number() });
    for (const [written, performed] of bothWays(shape, input =>
      c.bind(c.number(), c.arithmetic("add", input.a, input.b), sum => c.choose<Answer>(sum.$eq(0.3), yes, no)), [{ a: 0.1, b: 0.2 }, { a: 0.1, b: 0.1 }])) {
      expect(performed).toStrictEqual(written);
    }
  });

  it("reads a quotient compared with a rational multiplied out, as it runs", () => {
    const shape = c.object({ x: c.int() });
    for (const [written, performed] of bothWays(shape, input =>
      c.bind(c.rational(), c.quotient(input.x, 7), share => c.choose<Answer>(share.$gte(new c.Rational(3n)), yes, no)), [{ x: 30 }, { x: 14 }, { x: -30 }])) {
      expect(performed).toStrictEqual(written);
    }
  });

  it("refuses a rational compared with a plain number, which it never is", () => {
    expect(() => bothWays(c.object({ x: c.int() }), input =>
      c.bind(c.rational(), c.quotient(input.x, 7), share => c.choose<Answer>(share.$gte(3 as never), yes, no)), []))
      .toThrow("guard in same compares quotient($.x, 7), a rational, with 3, which it is never compared with: quotient($.x, 7) >= 3");
  });

  it("keeps decimals whose parts cancel a decimal", () => {
    const shape = c.object({ a: c.decimal(2), b: c.decimal(2) });
    for (const [written, performed] of bothWays(shape, input =>
      c.bind(c.decimal(2), c.arithmetic("subtract", input.a, input.a), zero => c.choose<Answer>(zero.$lt(input.b), yes, no)),
    [{ a: new Decimal("1.5"), b: new Decimal("0.01") }, { a: new Decimal("2"), b: new Decimal("-0.01") }])) {
      expect(performed).toStrictEqual(written);
    }
  });

  it("runs the model as written, however its measured view reads it", () => {
    const shape = c.object({ f: c.boolean(), a: c.int(), b: c.int() });
    const inputs = [{ f: true, a: 1, b: 1 }, { f: false, a: 5, b: 1 }, { f: false, a: 1, b: 9 }];
    for (const [written, performed] of bothWays(shape, input =>
      c.bind(c.int(), c.arithmetic("add", input.a, 4503599627370496), big =>
        c.choose<Answer>(big.$gt(input.b.$plus(4503599627370496)), yes, no)), inputs)) {
      expect(performed).toStrictEqual(written);
    }
  });

  it("still parses a field it binds, a field that may be left out among them", () => {
    const X = c.int();
    const definition = c.behavior("optional", {
      input: c.variants("kind", { go: c.object({ x: X.optional() }) }),
      result: c.object({ v: c.int().optional() }),
      effects,
    });
    const implementation = c.implement(definition, { cases: { go: c.model("carry", input => ({ result: c.bind(X, input.x, v => ({ v }) as never), effects: [] })) } });
    expect(() => c.performSync(implementation, { kind: "go" })).toThrow("Invalid local construction");
  });

  it("keeps a binding a read of it cannot be read without", () => {
    const S = c.string();
    const definition = c.behavior("length", { input: c.variants("kind", { go: c.object({ s: S }) }), result: answer, effects });
    const implementation = c.implement(definition, { cases: { go: c.model("length", input => ({
      result: c.bind(S, input.s, s => c.choose<Answer>(s.$length().$plus(1).$gt(3), yes, no)), effects: [],
    })) } });
    expect(c.performSync(implementation, { kind: "go", s: "abc" }).result).toStrictEqual(yes);
    expect(c.performSync(implementation, { kind: "go", s: "ab" }).result).toStrictEqual(no);
  });

  it("names the bindings of each branch a bound choice is spread over afresh", () => {
    const shape = c.object({ f: c.boolean(), a: c.int(), b: c.int() });
    const inputs = [{ f: true, a: 1, b: 1 }, { f: false, a: 5, b: 1 }, { f: false, a: 1, b: 9 }];
    for (const [written, performed] of bothWays(shape, input =>
      c.bind(c.int(), c.choose(input.f.$eq(true), input.a, c.arithmetic("subtract", input.b, 3)), x =>
        c.bind(c.int(), c.arithmetic("add", x, input.a), y => c.choose<Answer>(y.$gt(input.b), yes, no))), inputs)) {
      expect(performed).toStrictEqual(written);
    }
  });
});

describe("a way through a dependency whose ensures relate its answer to its argument", () => {
  it("is tried with the argument, not taken for one no input takes", async () => {
    const level = c.behavior("level", {
      input: c.variants("kind", { req: c.object({ n: c.int() }) }), result: c.int().min(0).max(9), effects,
      ensures: clause => [clause.always("same", (input, value) => value.$eq(input.n))],
    });
    const tripled = c.behavior("tripled", {
      input: c.variants("kind", { go: c.object({ n: c.int() }) }), result: c.int(), effects,
      dependencies: { level: c.dependency(level) },
    });
    const implementation = c.implement(tripled, { cases: { go: c.model("tripled", (input, deps) => ({
      result: c.bind(c.int(), c.arithmetic("multiply", c.call(deps.level, { kind: "req", n: input.n }), 3), total => c.choose(total.$gte(27), 1, 0)),
      effects: [],
    })) } });
    const report = await c.check(c.spec("tripled", { implementation, examples: c.examples(tripled, {}) }));
    expect(report.measures.rules.status === "complete" ? report.measures.rules.rules.map(rule => rule.status) : report.measures.rules)
      .not.toContain("no row owed");
  });
});

describe("a read that may be left out", () => {
  it("is read in the model as written, a local bound under a schema that is always there", () => {
    const definition = c.behavior("bound", { input: c.variants("kind", { go: c.object({ x: c.int().optional() }) }), result: c.int(), effects });
    expect(() => c.implement(definition, { cases: { go: c.model("bound", input => ({ result: c.bind(c.int(), input.x as never, v => c.choose(v.$gte(1), 1, 0)), effects: [] })) } }))
      .not.toThrow();
  });

  it("is an element of an array read by its index", () => {
    expect(() => c.object({ items: c.array(c.int()) }).refine(v => (v.items as unknown as Record<string, c.TermOf<number>>)["0"]!.$gte(1)))
      .toThrow("refine reads $.items.0, which may be left out: write its absence as a case of a sum");
  });
});

describe("a read through a sum", () => {
  it("is refused where any case leaves the value out, whichever case is declared first", () => {
    for (const cases of [
      { A: c.object({ p: c.object({ q: c.int() }) }), B: c.object({ p: c.object({ q: c.int().optional() }) }) },
      { B: c.object({ p: c.object({ q: c.int().optional() }) }), A: c.object({ p: c.object({ q: c.int() }) }) },
    ]) {
      expect(() => c.object({ s: c.variants("k", cases) }).refine(v => v.s.p.q.$gte(1)))
        .toThrow("refine reads $.s.p.q, which may be left out: write its absence as a case of a sum");
    }
  });
});

describe("what a run of a rewritten model records", () => {
  it("is one way through a condition written once and read in two places", async () => {
    const pair = c.behavior("pair", { input: c.variants("kind", { request: c.object({ a: c.int().min(0).max(100), b: c.int().min(0).max(100) }) }), result: c.int(), effects });
    const row = (a: number, b: number, result: number) => ({ given: { kind: "request" as const, a, b }, expect: { result, effects: [] } });
    const implementation = c.implement(pair, { cases: { request: c.model("shared", input => ({
      result: c.bind(c.int(), input.a, v => {
        const high = v.$gt(50);
        return c.choose(high, c.choose(input.b.$gt(5), 2, 1), c.choose(high, 3, 0));
      }),
      effects: [],
    })) } });
    const report = await c.check(c.spec("pair", { implementation, examples: c.examples(pair, { hh: row(60, 10, 2), hl: row(60, 0, 1), l: row(10, 0, 0) }) }));
    const rules = report.measures.rules;
    expect(rules.status === "complete" ? rules.rules.map(rule => `${rule.way}: ${rule.status}`) : rules).toStrictEqual([
      "$.a > 50 holds, $.b > 5 holds → otherwise: met",
      "$.a > 50 holds, $.b > 5 fails → otherwise: met",
      "$.a > 50 fails, $.a > 50 holds → otherwise: no row owed",
      "$.a > 50 fails, $.a > 50 fails → otherwise: met",
    ]);
  });

  it("measures a sum with a fractional constant on the field it reads", async () => {
    const pair = c.behavior("half", { input: c.variants("kind", { request: c.object({ a: c.number(), b: c.number() }) }), result: c.int(), effects });
    const implementation = c.implement(pair, { cases: { request: c.model("half", input => ({
      result: c.bind(c.number(), input.a, v => c.choose(v.$plus(0.5).$gt(input.b), 1, 0)), effects: [],
    })) } });
    const report = await c.check(c.spec("half", { implementation, examples: c.examples(pair, {}) }));
    const rules = report.measures.rules;
    expect(rules.status === "complete" ? rules.rules.map(rule => rule.way) : rules).toStrictEqual(["$.a + 0.5 > $.b holds → otherwise", "$.a + 0.5 > $.b fails → otherwise"]);
  });

  it("refuses a number compared with a bound no number is, as it settles without one", () => {
    const definition = c.behavior("bounded", { input: c.variants("kind", { go: c.object({ a: c.number() }) }), result: c.int(), effects });
    for (const [bound, text] of [[Infinity, "Infinity"], [Number.NaN, "NaN"]] as const) {
      expect(() => c.implement(definition, { cases: { go: c.model("bounded", input => ({ result: c.choose(input.a.$lt(bound), 1, 0), effects: [] })) } }))
        .toThrow(`guard in bounded compares $.a with ${text}, which no number is, so it settles without a value: $.a < ${text}`);
    }
  });

  it("refuses a local read outside its binding, wherever the node reading it is placed", () => {
    const definition = c.behavior("leak", { input: c.variants("kind", { go: c.object({ a: c.int() }) }), result: c.object({ x: c.int(), y: c.int() }), effects });
    let leaked: unknown;
    expect(() => c.implement(definition, { cases: { go: c.model("leak", input => ({
      result: { x: c.bind(c.int(), input.a, v => (leaked = c.choose(v.$gt(0), 1, 0)) as never), y: leaked as never }, effects: [],
    })) } })).toThrow("escapes its binding");
  });

  it("does not read a constant its fold would round", async () => {
    const shape = c.object({ a: c.int(), b: c.number() });
    for (const [written, performed] of bothWays(shape, input =>
      c.bind(c.int(), c.arithmetic("add", input.a, 1e15), v => c.choose<Answer>(v.$plus(0.3).$gt(input.b), yes, no)), [{ a: 2 ** 51 - 1e15, b: 2 ** 51 }])) {
      expect(performed).toStrictEqual(written);
    }
    const definition = c.behavior("rounded", { input: c.variants("kind", { go: shape }), result: c.int(), effects });
    const implementation = c.implement(definition, { cases: { go: c.model("rounded", input => ({
      result: c.bind(c.int(), c.arithmetic("add", input.a, 1e15), v => c.choose(v.$plus(0.3).$gt(input.b), 1, 0)), effects: [],
    })) } });
    const rules = (await c.check(c.spec("rounded", { implementation, examples: c.examples(definition, {}) }))).measures.rules;
    expect(rules.status === "complete" ? rules.rules.map(rule => rule.way) : rules)
      .toStrictEqual(["add($.a, 1000000000000000) + 0.3 > $.b holds → otherwise", "add($.a, 1000000000000000) + 0.3 > $.b fails → otherwise"]);
  });
});

describe("a search over a model's inputs", () => {
  it("varies a field a value computed before the choice may throw on", async () => {
    const divided = c.behavior("divided", {
      input: c.variants("kind", { request: c.object({ a: c.int().min(0).max(100), z: c.int().min(0).max(5) }) }),
      result: c.object({ q: c.number(), r: c.int() }), effects,
    });
    const implementation = c.implement(divided, { cases: { request: c.model("divided", input => ({
      result: { q: c.arithmetic("divide", 12, input.z), r: c.bind(c.int(), c.choose(input.a.$gt(50), input.a, 0), v => c.choose(v.$gte(3), 1, 0)) },
      effects: [],
    })) } });
    const rows = c.examples(divided, { high: { given: { kind: "request", a: 60, z: 1 }, expect: { result: { q: 12, r: 1 }, effects: [] } } });
    const report = await c.check(c.spec("divided", { implementation, examples: rows }));
    const rules = report.measures.rules;
    expect(rules.status === "complete" ? rules.rules.find(rule => rule.way === "$.a > 50 fails, choose >= 3 fails → otherwise")?.status : rules).toBe("gap");
  });

  it("owes no row past the range the schema a sum is bound under allows", async () => {
    const pair = c.behavior("pair", {
      input: c.variants("kind", { request: c.object({ a: c.int().min(0).max(100), b: c.int().min(0).max(100) }) }),
      result: c.int(),
      effects,
    });
    const capped = c.implement(pair, { cases: { request: c.model("capped", input => ({
      result: c.bind(c.int().max(150), c.arithmetic("add", input.a, input.b), total => c.choose(total.$gte(160), total, 0)),
      effects: [],
    })) } });
    const rows = c.examples(pair, { small: { given: { kind: "request", a: 10, b: 20 }, expect: { result: 0, effects: [] } } });
    const report = await c.check(c.spec("pair", { implementation: capped, examples: rows }));
    const measured = report.measures.rules;
    if (measured.status === "unavailable") throw new Error("the ways were not measured");
    expect(measured.rules.find(way => way.way.includes("holds"))?.status).toBe("no row owed");
    const offered = c.generate(rows, capped).rows.map(row => row.given as { a: number; b: number });
    expect(offered.filter(given => given.a + given.b >= 160)).toStrictEqual([]);
  });
});

it("does not read a sum whose weights are rounded before they cancel", () => {
  const big = Number.MAX_SAFE_INTEGER;
  const scaled = linearCombination([{ operand: positionTerm(["z"], "value"), coefficient: big }]);
  expect(linearCombination([{ operand: scaled, coefficient: 3 }, { operand: scaled, coefficient: -2 }, { operand: scaled, coefficient: -1 }])).toBeUndefined();
});

it("tells an invariant over the key a.b under a quantifier from one over the path a.b", () => {
  const ofKey = c.object({ xs: c.array(c.object({ "a.b": c.int() })) }).refine(v => v.xs.$all(x => x["a.b"].$gte(0))).invariants[0]!;
  const ofPath = c.object({ xs: c.array(c.object({ a: c.object({ b: c.int() }) })) }).refine(v => v.xs.$all(x => x.a.b.$gte(0))).invariants[0]!;
  expect(identityOf(ofKey)).not.toBe(identityOf(ofPath));
});
