import { expect, it } from "vitest";
import * as c from "../src/index.js";
import { interpret } from "../src/model.js";

const emptyEffects = c.variants("kind", {});
const request = c.variants("kind", { request: c.object({}) });

it("evaluates a bound dependency once and projects its result into a condition and output", async () => {
  const answer = c.object({ accepted: c.boolean(), amount: c.int().min(1) });
  const definition = c.behavior("bound lookup", {
    input: request, result: c.int().min(0), effects: emptyEffects,
    requires: { lookup: c.dependency(c.boolean(), answer) },
  });
  const impl = c.implement(definition, { cases: { request: c.model("lookup", (_, deps) => ({
    result: c.bind(answer, c.call(deps.lookup, true), value => c.choose(value.accepted.$eq(true), value.amount, 0)), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("verified");
  let calls = 0;
  await expect(c.perform(impl, { kind: "request" }, { lookup: () => { calls++; return { accepted: true, amount: 7 }; } })).resolves.toStrictEqual({ result: 7, effects: [] });
  expect(calls).toBe(1);
  await expect(c.perform(impl, { kind: "request" }, { lookup: () => ({ accepted: false, amount: 7 }) })).resolves.toStrictEqual({ result: 0, effects: [] });
});

it("does not use a binding's later guard to prove its own construction", () => {
  const definition = c.behavior("circular binding", { input: request, result: c.int().min(0), effects: emptyEffects,
    requires: { lookup: c.dependency(c.boolean(), c.int()) } });
  const impl = c.implement(definition, { cases: { request: c.model("lookup", (_, deps) => ({
    result: c.bind(c.int().min(0), c.call(deps.lookup, true), value => c.choose(value.$gte(0), value, 0)), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("undetermined");
});

it("keeps the original whole input when a local is in scope", async () => {
  const definition = c.behavior("whole input", { input: request, result: request, effects: emptyEffects });
  const impl = c.implement(definition, { cases: { request: c.model("whole", input => ({
    result: c.bind(c.boolean(), true, () => input), effects: [],
  })) } });
  await expect(c.perform(impl, { kind: "request" })).resolves.toStrictEqual({ result: { kind: "request" }, effects: [] });
  expect(c.verify(impl).status).toBe("verified");
});

it("rejects locals that escape their lexical binding", () => {
  let escaped: c.TermOf<number>;
  const expression = c.bind(c.int(), 1, value => { escaped = value; return value; });
  const definition = c.behavior("escape", { input: request, result: c.int(), effects: emptyEffects });
  expect(() => c.implement(definition, { cases: { request: c.model("escape", () => ({ result: c.arithmetic("add", expression, escaped), effects: [] })) } })).toThrow("escapes its binding");
});

it("proves map bodies for arbitrary array lengths and mixed branch outcomes", async () => {
  const element = c.int();
  const output = c.int().min(0);
  const definition = c.behavior("clamp", { input: c.variants("kind", { request: c.object({ values: c.array(element) }) }), result: c.array(output), effects: emptyEffects });
  const impl = c.implement(definition, { cases: { request: c.model("clamp", input => ({
    result: c.map(element, output, input.values, value => c.choose(value.$gte(0), value, 0)), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("verified");
  await expect(c.perform(impl, { kind: "request", values: [-2, 4, -1, 9] })).resolves.toStrictEqual({ result: [0, 4, 0, 9], effects: [] });
  await expect(c.perform(impl, { kind: "request", values: [] })).resolves.toStrictEqual({ result: [], effects: [] });
});

it("checks a fold invariant at initialization and after each iteration", async () => {
  const element = c.int64().min(0n).max(100n);
  const accumulator = c.int64().min(0n).max(100n);
  const definition = c.behavior("maximum", { input: c.variants("kind", { request: c.object({ values: c.array(element) }) }), result: accumulator, effects: emptyEffects });
  const impl = c.implement(definition, { cases: { request: c.model("maximum", input => ({
    result: c.fold(element, accumulator, input.values, 0n, (maximum, value) => c.choose(value.$gt(maximum), value, maximum)), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("verified");
  await expect(c.perform(impl, { kind: "request", values: [3n, 1n, 9n] })).resolves.toStrictEqual({ result: 9n, effects: [] });
  await expect(c.perform(impl, { kind: "request", values: [] })).resolves.toStrictEqual({ result: 0n, effects: [] });
  const bad = c.implement(definition, { cases: { request: c.model("invalid initial", input => ({
    result: c.fold(element, accumulator, input.values, -1n, (_, value) => value), effects: [],
  })) } });
  expect(c.verify(bad).status).toBe("refuted");
  await expect(c.perform(bad, { kind: "request", values: [] })).rejects.toThrow("Invalid local construction");
});

it("does not certify an unsafe iteration just because supplied arrays are empty", () => {
  const definition = c.behavior("unsafe map", { input: request, result: c.array(c.int().min(0)), effects: emptyEffects,
    requires: { values: c.dependency(c.boolean(), c.array(c.int())) } });
  const impl = c.implement(definition, { cases: { request: c.model("unsafe", (_, deps) => ({
    result: c.map(c.int(), c.int().min(0), c.call(deps.values, true), value => value), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("undetermined");
});

it("shares the evaluation budget across iterations", () => {
  expect(() => interpret(c.map(c.int(), c.int(), [1, 2, 3], value => value), {}, { steps: 5 })).toThrow("step budget");
});

it("uses a case-scoped dependency guarantee only in that result case", async () => {
  const answer = c.variants("kind", { ok: c.object({ amount: c.int() }), missing: c.object({ amount: c.int() }) });
  const lookup = c.behavior("lookup", { input: c.variants("kind", { request: c.object({ minimum: c.int().min(1) }) }), result: answer, effects: emptyEffects,
    ensures: ensure => [ensure.when("positive answer", ["ok"], (input, value) => value.amount.$gte(input.minimum))] });
  const definition = c.behavior("conditional contract", { input: request, result: c.int().min(1), effects: emptyEffects, requires: { lookup: c.dependency(lookup) } });
  const impl = c.implement(definition, { cases: { request: c.model("lookup", (input, deps) => ({
    result: c.bind(answer, c.call(deps.lookup, { kind: "request", minimum: 1 }), value => c.choose(value.kind.$eq("ok"), value.amount, 1)), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("verified");
  await expect(c.perform(impl, { kind: "request" }, { lookup: () => ({ kind: "ok", amount: 0 }) })).rejects.toThrow("breaks ensures");
  const unsafe = c.implement(definition, { cases: { request: c.model("unguarded", (input, deps) => ({
    result: c.bind(answer, c.call(deps.lookup, { kind: "request", minimum: 1 }), value => value.amount), effects: [],
  })) } });
  expect(c.verify(unsafe).status).toBe("undetermined");
});

it("rejects reusing a binding declaration for independent evaluations", () => {
  const expression = c.bind(c.int(), 1, value => value);
  const definition = c.behavior("reuse", { input: request, result: c.int(), effects: emptyEffects });
  expect(() => c.implement(definition, { cases: { request: c.model("reuse", () => ({ result: c.arithmetic("add", expression, expression), effects: [] })) } })).toThrow("binding cannot be reused");
});

it.each(["condition", "linear", "quantified"] as const)("rejects an escaped local in a %s", mode => {
  let escaped: c.TermOf<number>;
  c.bind(c.int(), 1, value => { escaped = value; return value; });
  const definition = c.behavior("escaped condition", { input: c.variants("kind", { request: c.object({ values: c.array(c.int()) }) }), result: c.int(), effects: emptyEffects });
  expect(() => c.implement(definition, { cases: { request: c.model("escape", input => ({
    result: c.choose(mode === "condition" ? escaped.$gte(0) : mode === "linear" ? escaped.$plus(1).$gte(0) : input.values.$all(value => value.$gte(escaped)), 1, 0), effects: [],
  })) } })).toThrow("escapes its binding");
});

it("refuses input names that could shadow a local binding", () => {
  const definition = c.behavior("reserved input", { input: c.variants("kind", { request: c.object({ "#local:0": c.int() }) }), result: c.int(), effects: emptyEffects });
  expect(() => c.implement(definition, { cases: { request: c.model("reserved", () => ({ result: c.bind(c.int(), 1, value => value), effects: [] })) } })).toThrow("reserved local name");
});

it("proves nested loops and captured input fields without conflating iteration scopes", async () => {
  const element = c.int64().min(0n).max(100n);
  const output = c.int64().min(0n).max(200n);
  const definition = c.behavior("nested", {
    input: c.variants("kind", { request: c.object({ values: c.array(c.array(element)), offset: element }) }),
    result: c.array(c.array(output)), effects: emptyEffects,
  });
  const impl = c.implement(definition, { cases: { request: c.model("nested", input => ({
    result: c.map(c.array(element), c.array(output), input.values, row => c.map(element, output, row, value => c.arithmetic("add", value, input.offset))), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("verified");
  await expect(c.perform(impl, { kind: "request", values: [[1n, 2n], [], [3n]], offset: 10n })).resolves.toStrictEqual({ result: [[11n, 12n], [], [13n]], effects: [] });
});

it("does not leak a mapped call's facts into a separate call", async () => {
  const output = c.int().min(1);
  const definition = c.behavior("independent calls", { input: request, result: output, effects: emptyEffects,
    requires: { lookup: c.dependency(c.boolean(), c.int()) } });
  const impl = c.implement(definition, { cases: { request: c.model("independent", (_, deps) => ({
    result: c.bind(c.array(output), c.map(c.boolean(), output, [true], flag => c.bind(c.int(), c.call(deps.lookup, flag), value => c.choose(value.$gte(1), value, 1))), () => c.call(deps.lookup, false)), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("undetermined");
  await expect(c.perform(impl, { kind: "request" }, { lookup: flag => flag ? 1 : -1 })).rejects.toThrow();
});

it("rejects a fold whose update breaks its accumulator contract", async () => {
  const accumulator = c.int64().min(0n).max(100n);
  const definition = c.behavior("bounded sum", { input: request, result: accumulator, effects: emptyEffects,
    requires: { values: c.dependency(c.boolean(), c.array(accumulator)) } });
  const impl = c.implement(definition, { cases: { request: c.model("sum", (_, deps) => ({
    result: c.fold(accumulator, accumulator, c.call(deps.values, true), 0n, (sum, value) => c.arithmetic("add", sum, value)), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("undetermined");
  await expect(c.perform(impl, { kind: "request" }, { values: () => [60n, 60n] })).rejects.toThrow("Invalid local construction");
});

it("charges nested iteration proof paths to the same budget", () => {
  const definition = c.behavior("path budget", { input: request, result: c.array(c.int()), effects: emptyEffects,
    requires: { values: c.dependency(c.boolean(), c.array(c.int())) } });
  const impl = c.implement(definition, { cases: { request: c.model("map", (_, deps) => ({ result: c.map(c.int(), c.int(), c.call(deps.values, true), value => value), effects: [] })) } });
  expect(c.verify(impl, { ways: 1 }).status).toBe("undetermined");
  expect(c.verify(impl, { ways: 2 }).status).toBe("verified");
});

it("leaves local and iterated path coverage unmeasured instead of declaring it complete", async () => {
  const definition = c.behavior("local coverage", { input: request, result: c.int(), effects: emptyEffects });
  const impl = c.implement(definition, { cases: { request: c.model("local", () => ({ result: c.bind(c.boolean(), true, value => c.choose(value.$eq(true), 1, 0)), effects: [] })) } });
  const examples = c.examples(definition, { request: { given: { kind: "request" }, expect: { result: 1, effects: [] } } });
  const report = await c.check(c.spec("local coverage", { examples, implementation: impl }));
  expect(report.measures.constructions.status).toBe("verified");
  expect(report.measures.arms.status).toBe("unavailable");
  expect(report.verdict).toBe("undetermined");
  expect(c.generate(examples, impl, { ways: true }).notComposed).toContain("local: local and iteration branch coverage is not yet supported");
});

it("never applies one result case's guarantee to a different case", () => {
  const answer = c.variants("kind", { ok: c.object({ amount: c.int() }), missing: c.object({ amount: c.int() }) });
  const lookup = c.behavior("conditional lookup", { input: c.variants("kind", { request: c.object({ minimum: c.int().min(1) }) }), result: answer, effects: emptyEffects,
    ensures: ensure => [ensure.when("positive", ["ok"], (input, value) => value.amount.$gte(input.minimum))] });
  const definition = c.behavior("wrong case", { input: request, result: c.int().min(1), effects: emptyEffects, requires: { lookup: c.dependency(lookup) } });
  const impl = c.implement(definition, { cases: { request: c.model("wrong case", (_, deps) => ({
    result: c.bind(answer, c.call(deps.lookup, { kind: "request", minimum: 1 }), value => c.choose(value.kind.$eq("missing"), value.amount, 1)), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("undetermined");
});

it("allows strict checking of an iteration without local or repeated branches", async () => {
  const definition = c.behavior("simple map", { input: request, result: c.array(c.int()), effects: emptyEffects });
  const impl = c.implement(definition, { cases: { request: c.model("identity map", () => ({ result: c.map(c.int(), c.int(), [1, 2], value => value), effects: [] })) } });
  const examples = c.examples(definition, { request: { given: { kind: "request" }, expect: { result: [1, 2], effects: [] } } });
  const report = await c.check(c.spec("simple map", { examples, implementation: impl }));
  expect(report.verdict).toBe("satisfied");
});

it("does not turn an unresolved case guarantee into an unconditional fact through another binding", () => {
  const answer = c.variants("kind", { ok: c.object({ amount: c.int() }), missing: c.object({ amount: c.int() }) });
  const lookup = c.behavior("aliased lookup", { input: c.variants("kind", { request: c.object({ minimum: c.int().min(1) }) }), result: answer, effects: emptyEffects,
    ensures: ensure => [ensure.when("positive", ["ok"], (input, value) => value.amount.$gte(input.minimum))] });
  const definition = c.behavior("aliased case", { input: request, result: c.int().min(1), effects: emptyEffects, requires: { lookup: c.dependency(lookup) } });
  const impl = c.implement(definition, { cases: { request: c.model("alias", (_, deps) => ({
    result: c.bind(answer, c.call(deps.lookup, { kind: "request", minimum: 1 }), first => c.bind(answer, first, second => c.choose(second.kind.$eq("missing"), second.amount, 1))), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("undetermined");
});

it("matches variant-specific fields with an exhaustive typed result match", async () => {
  const answer = c.variants("kind", { missing: c.object({}), ok: c.object({ amount: c.int() }) });
  const lookup = c.behavior("variant lookup", { input: c.variants("kind", { request: c.object({ minimum: c.int().min(1) }) }), result: answer, effects: emptyEffects,
    ensures: ensure => [ensure.when("positive", ["ok"], (input, value) => value.amount.$gte(input.minimum))] });
  const definition = c.behavior("matched lookup", { input: request, result: c.int().min(1), effects: emptyEffects, requires: { lookup: c.dependency(lookup) } });
  const impl = c.implement(definition, { cases: { request: c.model("match", (_, deps) => ({
    result: c.matchValue(answer, c.call(deps.lookup, { kind: "request", minimum: 1 }), {
      missing: () => 1,
      ok: value => value.amount,
    }), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("verified");
  await expect(c.perform(impl, { kind: "request" }, { lookup: () => ({ kind: "ok", amount: 9 }) })).resolves.toStrictEqual({ result: 9, effects: [] });
  await expect(c.perform(impl, { kind: "request" }, { lookup: () => ({ kind: "missing" }) })).resolves.toStrictEqual({ result: 1, effects: [] });
});

it("requires every variant body and refuses inherited match handlers", () => {
  const schema = c.variants("kind", { one: c.object({}), two: c.object({}) });
  // @ts-expect-error The second variant requires a body.
  expect(() => c.matchValue(schema, { kind: "one" }, { one: () => 1 })).toThrow("every variant");
  const handlers = { one: () => 1, two: () => 2 };
  const inherited: typeof handlers = Object.create(handlers);
  expect(() => c.matchValue(schema, { kind: "one" }, inherited)).toThrow("every variant");
});
