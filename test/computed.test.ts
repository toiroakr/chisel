import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { fieldsTurnedOn } from "../src/model.js";

const effects = c.variants("kind", {});
const statuses = (report: c.AdequacyReport) =>
  report.measures.rules.status === "complete" ? report.measures.rules.rules.map(rule => `${rule.way}: ${rule.status}`) : report.measures.rules;

describe("a choice on a value the model computes", () => {
  const pair = c.behavior("pair", { input: c.variants("kind", { request: c.object({ a: c.int().min(0).max(100), b: c.int().min(0).max(100) }) }), result: c.int(), effects });
  const row = (a: number, b: number, result: number) => ({ given: { kind: "request" as const, a, b }, expect: { result, effects: [] } });

  it("reads a sum of input numbers as that expression, drawing its border on the input", async () => {
    const summed = c.implement(pair, { cases: { request: c.model("sum", input => ({
      result: c.bind(c.int(), c.arithmetic("add", input.a, input.b), total => c.choose(total.$gte(100), total, 0)),
      effects: [],
    })) } });
    const rows = c.examples(pair, { big: row(60, 40, 100), small: row(10, 20, 0) });
    const report = await c.check(c.spec("pair", { implementation: summed, examples: rows }));
    expect(statuses(report)).toStrictEqual(["$.a + $.b >= 100 holds → otherwise: met", "$.a + $.b >= 100 fails → otherwise: met"]);
    expect(c.generate(rows, summed).rows.map(row => row.name)).toContain("pair: @request.a + @request.b − 100 OFF (= -1)");
  });

  it("reads a bound choice of values as a value of its own, settled by search", async () => {
    const chosen = c.implement(pair, { cases: { request: c.model("choose", input => ({
      result: c.bind(c.int(), c.choose(input.a.$gt(50), input.a, 0), value => c.choose(value.$gte(3), 1, 0)),
      effects: [],
    })) } });
    const report = await c.check(c.spec("pair", { implementation: chosen, examples: c.examples(pair, { high: row(60, 0, 1), low: row(10, 0, 0) }) }));
    expect(statuses(report)).toStrictEqual([
      "$.a > 50 holds, choose >= 3 holds → otherwise: met",
      "$.a > 50 holds, choose >= 3 fails → otherwise: no row owed",
      "$.a > 50 fails, choose >= 3 holds → otherwise: no row owed",
      "$.a > 50 fails, choose >= 3 fails → otherwise: met",
    ]);
  });

  it("reads a quotient by a whole number multiplied out", async () => {
    const divided = c.implement(pair, { cases: { request: c.model("quotient", input => ({
      result: c.bind(c.rational(), c.quotient(input.a, 7), share => c.choose(share.$gte(new c.Rational(3n)), 1, 0)),
      effects: [],
    })) } });
    const report = await c.check(c.spec("pair", { implementation: divided, examples: c.examples(pair, { high: row(30, 0, 1) }) }));
    expect(statuses(report)).toStrictEqual(["$.a >= 21 holds → otherwise: met", "$.a >= 21 fails → otherwise: gap"]);
  });

  it("settles a way through a value it cannot read as an expression by running the case's inputs", async () => {
    const small = c.behavior("small", { input: c.variants("kind", { request: c.object({ a: c.int().min(0).max(9), b: c.int().min(0).max(9) }) }), result: c.int(), effects });
    const within = (bound: number) => c.implement(small, { cases: { request: c.model("product", input => ({
      result: c.bind(c.int(), c.arithmetic("multiply", input.a, input.b), value => c.choose(value.$gte(bound), 1, 0)),
      effects: [],
    })) } });
    const one = { one: { given: { kind: "request" as const, a: 1, b: 1 }, expect: { result: 0, effects: [] } } };
    const found = await c.check(c.spec("small", { implementation: within(50), examples: c.examples(small, one) }));
    expect(statuses(found)).toStrictEqual(["multiply($.a, $.b) >= 50 holds → otherwise: gap", "multiply($.a, $.b) >= 50 fails → otherwise: met"]);
    expect(c.generate(c.examples(small, one), within(50)).rows.map(row => row.given)).toContainEqual({ kind: "request", a: 6, b: 9 });
    const none = await c.check(c.spec("small", { implementation: within(82), examples: c.examples(small, one) }));
    expect(statuses(none)).toStrictEqual(["multiply($.a, $.b) >= 82 holds → otherwise: no row owed", "multiply($.a, $.b) >= 82 fails → otherwise: met"]);
  });

  it("does not refute a way by the exact product of numbers the runtime multiplies in floating point", async () => {
    const floats = c.behavior("floats", { input: c.variants("kind", { request: c.object({ a: c.number().min(0.1).max(0.1), b: c.number().min(0.2).max(0.2) }) }), result: c.int(), effects });
    const product = c.implement(floats, { cases: { request: c.model("product", input => ({
      result: c.bind(c.number(), c.arithmetic("multiply", input.a, input.b), value => c.choose(value.$gt(0.02), 1, 0)),
      effects: [],
    })) } });
    const report = await c.check(c.spec("floats", { implementation: product, examples: c.examples(floats, {}) }));
    expect(statuses(report)).toStrictEqual(["multiply($.a, $.b) > 0.02 holds → otherwise: gap", "multiply($.a, $.b) > 0.02 fails → otherwise: undecided"]);
  });

  it("tries an input field whose name starts with # like any other, since only the local names are reserved", async () => {
    const hashed = c.behavior("hashed", { input: c.variants("kind", { request: c.object({ "#a": c.int().min(1).max(2), b: c.int().min(1).max(2) }) }), result: c.int(), effects });
    const product = c.implement(hashed, { cases: { request: c.model("product", input => ({
      result: c.bind(c.int(), c.arithmetic("multiply", input["#a"], input.b), value => c.choose(value.$eq(4), 1, 0)),
      effects: [],
    })) } });
    const one = { one: { given: { kind: "request" as const, "#a": 1, b: 1 }, expect: { result: 0, effects: [] } } };
    const report = await c.check(c.spec("hashed", { implementation: product, examples: c.examples(hashed, one) }));
    expect(report.measures.rules.status === "complete" ? report.measures.rules.rules.map(rule => rule.status) : report.measures.rules).toStrictEqual(["gap", "met"]);
  });

  it("leaves a way undecided, not without a row owed, where the fields the search leaves out have no placeholder the input takes", async () => {
    const unread = c.array(c.boolean()).length(1).refine(flags => flags.$all(flag => flag.$eq(true)));
    const small = c.behavior("unread", { input: c.variants("kind", { request: c.object({ a: c.int().min(0).max(9), b: c.int().min(0).max(9), flags: unread }) }), result: c.int(), effects });
    const product = c.implement(small, { cases: { request: c.model("product", input => ({
      result: c.bind(c.int(), c.arithmetic("multiply", input.a, input.b), value => c.choose(value.$gte(50), 1, 0)),
      effects: [],
    })) } });
    const one = { one: { given: { kind: "request" as const, a: 1, b: 1, flags: [true] }, expect: { result: 0, effects: [] } } };
    const report = await c.check(c.spec("unread", { implementation: product, examples: c.examples(small, one) }));
    expect(statuses(report)).toStrictEqual(["multiply($.a, $.b) >= 50 holds → otherwise: undecided", "multiply($.a, $.b) >= 50 fails → otherwise: met"]);
  });

  it("owes no row where a product of factors of at least 2 would be a prime, and finds the factors of a composite", async () => {
    const wide = c.behavior("wide", { input: c.variants("kind", { request: c.object({ a: c.int().min(2), b: c.int().min(2) }) }), result: c.int(), effects });
    const equalTo = (target: number) => c.implement(wide, { cases: { request: c.model("factored", input => ({
      result: c.bind(c.int(), c.arithmetic("multiply", input.a, input.b), value => c.choose(value.$eq(target), 1, 0)),
      effects: [],
    })) } });
    const rows = c.examples(wide, { two: { given: { kind: "request", a: 2, b: 2 }, expect: { result: 0, effects: [] } } });
    expect(statuses(await c.check(c.spec("wide", { implementation: equalTo(1000003), examples: rows })))).toStrictEqual([
      "multiply($.a, $.b) == 1000003 holds → otherwise: no row owed",
      "multiply($.a, $.b) == 1000003 fails → otherwise: met",
    ]);
    expect(statuses(await c.check(c.spec("wide", { implementation: equalTo(1000001), examples: rows })))).toStrictEqual([
      "multiply($.a, $.b) == 1000001 holds → otherwise: gap",
      "multiply($.a, $.b) == 1000001 fails → otherwise: met",
    ]);
    expect(c.generate(rows, equalTo(1000001)).rows.map(row => row.given)).toContainEqual({ kind: "request", a: 101, b: 9901 });
  });

  it("owes no row where the bounds of what a product reads leave it no value taking the way", async () => {
    const wide = c.behavior("wide", { input: c.variants("kind", { request: c.object({ a: c.int().min(2), b: c.int().min(2) }) }), result: c.int(), effects });
    const below = c.implement(wide, { cases: { request: c.model("below", input => ({
      result: c.bind(c.int(), c.arithmetic("multiply", input.a, input.b), value => c.choose(value.$lt(4), 1, 0)),
      effects: [],
    })) } });
    const report = await c.check(c.spec("wide", { implementation: below, examples: c.examples(wide, { two: { given: { kind: "request", a: 2, b: 2 }, expect: { result: 0, effects: [] } } }) }));
    expect(statuses(report)).toStrictEqual(["multiply($.a, $.b) < 4 holds → otherwise: no row owed", "multiply($.a, $.b) < 4 fails → otherwise: met"]);
  });

  it("leaves undecided a way no input it tries takes, where it cannot try them all", async () => {
    // No cubes of positive integers add up to a cube; telling so takes Fermat's last theorem.
    const cubes = c.behavior("cubes", { input: c.variants("kind", { request: c.object({ a: c.int().min(1), b: c.int().min(1), c: c.int().min(1) }) }), result: c.int(), effects });
    const cube = (term: c.Template<number>) => c.arithmetic("multiply", c.arithmetic("multiply", term, term), term);
    const fermat = c.implement(cubes, { cases: { request: c.model("fermat", input => ({
      result: c.bind(c.int(), c.arithmetic("subtract", c.arithmetic("add", cube(input.a), cube(input.b)), cube(input.c)), value => c.choose(value.$eq(0), 1, 0)),
      effects: [],
    })) } });
    const report = await c.check(c.spec("cubes", { implementation: fermat, examples: c.examples(cubes, { one: { given: { kind: "request", a: 1, b: 1, c: 1 }, expect: { result: 0, effects: [] } } }) }));
    expect(report.measures.rules.status === "complete" ? report.measures.rules.rules.map(rule => rule.status) : report.measures.rules).toStrictEqual(["undecided", "met"]);
  });



});

describe("a choice inside a map or a fold", () => {
  const line = c.object({ qty: c.int().min(0), urgent: c.boolean() });
  const order = c.behavior("order", { input: c.variants("kind", { request: c.object({ lines: c.array(line) }) }), result: c.array(c.int()), effects });
  const flagged = c.implement(order, { cases: { request: c.model("each", input => ({
    result: c.map(line, c.int(), input.lines, each => c.choose(each.urgent.$eq(true).$and(each.qty.$gte(5)), 1, 0)),
    effects: [],
  })) } });
  const rows = c.examples(order, { one: { given: { kind: "request", lines: [{ qty: 1, urgent: true }] }, expect: { result: [0], effects: [] } } });

  it("is measured as ways one element takes through the body", async () => {
    const report = await c.check(c.spec("order", { implementation: flagged, examples: rows }));
    expect(statuses(report)).toStrictEqual([
      "otherwise: met",
      "each of $.lines[]: $.lines[].urgent == true holds, $.lines[].qty >= 5 holds → otherwise: gap",
      "each of $.lines[]: $.lines[].urgent == true holds, $.lines[].qty >= 5 fails → otherwise: met",
      "each of $.lines[]: $.lines[].urgent == true fails → otherwise: gap",
    ]);
  });

  it("composes each way and border point on the element's position", () => {
    const generated = c.generate(rows, flagged, { ways: true });
    expect(generated.notComposed).toStrictEqual([]);
    expect(generated.rows.map(row => row.given)).toContainEqual({ kind: "request", lines: [{ qty: 5, urgent: true }] });
    expect(generated.rows.map(row => row.name)).toContain("order: @request.lines[].qty OFF (= 4)");
  });

  it("measures a fold's choices on its accumulator by running the case's inputs", async () => {
    const totals = c.behavior("totals", { input: c.variants("kind", { request: c.object({ xs: c.array(c.int().min(0).max(9)).max(3) }) }), result: c.int(), effects });
    const capped = c.implement(totals, { cases: { request: c.model("capped", input => ({
      result: c.fold(c.int().min(0).max(9), c.int().min(0), input.xs, 0, (total, x) => c.choose(total.$gte(10), total, c.arithmetic("add", total, x))),
      effects: [],
    })) } });
    const report = await c.check(c.spec("totals", { implementation: capped, examples: c.examples(totals, {
      few: { given: { kind: "request", xs: [1, 2] }, expect: { result: 3, effects: [] } },
    }) }));
    expect(statuses(report)).toStrictEqual([
      "otherwise: met",
      "each of $.xs[]: accumulator >= 10 holds → otherwise: gap",
      "each of $.xs[]: accumulator >= 10 fails → otherwise: met",
    ]);
  });
});

describe("a way through a value computed from a dependency", () => {
  it("tries every stand-in a value dependency may hold", async () => {
    const rated = c.behavior("rated", {
      input: c.variants("kind", { request: c.object({ a: c.int().min(0).max(9) }) }), result: c.int(), effects,
      dependencies: { rate: c.dependency(c.int().min(0).max(9)) },
    });
    const at = (bound: number) => c.implement(rated, { cases: { request: c.model("rated", (input, deps) => ({
      result: c.bind(c.int(), c.arithmetic("multiply", input.a, deps.rate), value => c.choose(value.$gte(bound), 1, 0)),
      effects: [],
    })) } });
    const rows = c.examples(rated, { one: { given: { kind: "request", a: 1 }, with: { rate: 1 }, expect: { result: 0, effects: [] } } });
    expect(statuses(await c.check(c.spec("rated", { implementation: at(50), examples: rows })))).toStrictEqual([
      "multiply($.a, deps.rate) >= 50 holds → otherwise: gap",
      "multiply($.a, deps.rate) >= 50 fails → otherwise: met",
    ]);
    expect(c.generate(rows, at(50)).rows.map(row => [row.given, row.with])).toContainEqual([{ kind: "request", a: 6 }, { rate: 9 }]);
    expect(statuses(await c.check(c.spec("rated", { implementation: at(82), examples: rows })))).toStrictEqual([
      "multiply($.a, deps.rate) >= 82 holds → otherwise: no row owed",
      "multiply($.a, deps.rate) >= 82 fails → otherwise: met",
    ]);
  });

  it("tries every answer a function dependency's contract allows, and offers what a fake row asks", async () => {
    const priced = c.behavior("priced", {
      input: c.variants("kind", { request: c.object({ sku: c.string() }) }), result: c.int(), effects,
      dependencies: { price: c.dependency(c.string(), c.int().min(1).max(100)) },
    });
    const tripled = c.implement(priced, { cases: { request: c.model("tripled", (input, deps) => ({
      result: c.bind(c.int(), c.arithmetic("multiply", c.call(deps.price, input.sku), 3), total => c.choose(total.$gte(200), 1, 0)),
      effects: [],
    })) } });
    const fakes = [c.fake(priced, "price", [["cheap", 10], ["dear", 70]])];
    const rows = c.examples(priced, { cheap: { given: { kind: "request", sku: "cheap" }, expect: { result: 0, effects: [] } } });
    const report = await c.check(c.spec("priced", { implementation: tripled, examples: rows, fakes }));
    expect(statuses(report)).toStrictEqual([
      "multiply(price(), 3) >= 200 holds → otherwise: gap",
      "multiply(price(), 3) >= 200 fails → otherwise: met",
    ]);
    // A price is whole, so three times it is never 200 or 199.
    expect(report.borders.find(border => border.rule === "guard multiply(price(), 3) >= 200")?.points.map(point => `${point.role}: ${point.status}`))
      .toStrictEqual(["ON: no row owed", "OFF: no row owed", "IN: gap", "OUT: met"]);
    const generated = c.generate(rows, tripled, { fakes });
    expect(generated.notComposed).toStrictEqual([]);
    expect(generated.rows.map(row => row.given)).toContainEqual({ kind: "request", sku: "dear" });
  });
});

describe("a concatenation", () => {
  it("is read as a value of its own, as NFC may join its parts into fewer characters", async () => {
    const named = c.behavior("named", { input: c.variants("kind", { request: c.object({ first: c.string(), last: c.string() }) }), result: c.int(), effects });
    const joined = c.implement(named, { cases: { request: c.model("joined", input => ({
      result: c.bind(c.string(), c.concat(input.first, input.last), full => c.choose(full.$length().$eq(2), 1, 0)),
      effects: [],
    })) } });
    // "e" and a combining acute accent join into the one character "é".
    expect(c.performSync(joined, { kind: "request", first: "e", last: "\u0301" })).toStrictEqual({ result: 0, effects: [] });
    expect(c.performSync(joined, { kind: "request", first: "a", last: "b" })).toStrictEqual({ result: 1, effects: [] });
    const rows = c.examples(named, { short: { given: { kind: "request", first: "a", last: "bc" }, expect: { result: 0, effects: [] } } });
    const report = await c.check(c.spec("named", { implementation: joined, examples: rows }));
    expect(statuses(report)).toStrictEqual([
      'length(concat($.first, $.last)) == 2 holds → otherwise: gap',
      'length(concat($.first, $.last)) == 2 fails → otherwise: met',
    ]);
  });
});

describe("the fields a search varies", () => {
  const shape = c.object({ a: c.int(), b: c.int(), xs: c.array(c.int()), n: c.int() });
  const input = (build: (input: c.TermOf<c.Infer<typeof shape>>, deps: never) => unknown) =>
    (c.model("fields", (given, deps) => ({ result: build(given as never, deps as never) as never, effects: [] })) as unknown as { expression: unknown }).expression;

  it("are every field where the model reads the whole input", () => {
    expect(fieldsTurnedOn(input(given => c.bind(shape, given as never, whole => c.choose((whole as unknown as c.TermOf<{ a: number }>).a.$gt(0), 1, 0))))).toBeUndefined();
  });

  it("take in what a quantifier's condition reads", () => {
    expect([...fieldsTurnedOn(input(given => c.choose(given.xs.$all(x => x.$lt(given.b)), 1, 0)))!].sort()).toStrictEqual(["b", "xs"]);
  });

  it("take in what an iteration computes with", () => {
    expect([...fieldsTurnedOn(input(given => c.bind(c.int(), c.fold(c.int(), c.int(), given.xs, 0, (sum, x) => c.arithmetic("add", sum, c.arithmetic("multiply", x, given.n))), total => c.choose(total.$gt(0), 1, 0))))!].sort())
      .toStrictEqual(["n", "xs"]);
  });

  it("take in what a dependency is asked, whatever it answers", () => {
    const echo = c.behavior("echo", { input: c.variants("kind", { req: c.object({ n: c.int().min(0) }) }), result: c.int(), effects });
    const asking = c.behavior("asking", { input: c.variants("kind", { go: shape }), result: c.int(), effects, dependencies: { echo: c.dependency(echo) } });
    const implementation = c.implement(asking, { cases: { go: c.model("asking", (given, deps) => ({
      result: c.bind(c.int(), c.call(deps.echo, { kind: "req", n: given.a }), answer => c.choose(answer.$gt(0), 1, 0)), effects: [],
    })) } });
    expect([...fieldsTurnedOn((implementation.cases.go as unknown as { expression: unknown }).expression)!]).toStrictEqual(["a"]);
  });
});
