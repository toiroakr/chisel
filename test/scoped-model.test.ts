import { Decimal } from "decimal.js";
import { expect, it } from "vitest";
import * as c from "../src/index.js";
import { interpret, iterationEntries, iterationsOf, localsOf } from "../src/model.js";
import { eachWayOf } from "../src/ways.js";
import { choiceFacts } from "../src/absence.js";

const emptyEffects = c.variants("kind", {});
const request = c.variants("kind", { request: c.object({}) });

it("evaluates a bound dependency once and projects its result into a condition and output", async () => {
  const answer = c.object({ accepted: c.boolean(), amount: c.int().min(1) });
  const definition = c.behavior("bound lookup", {
    input: request, result: c.int().min(0), effects: emptyEffects,
    dependencies: { lookup: c.dependency(c.boolean(), answer) },
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
    dependencies: { lookup: c.dependency(c.boolean(), c.int()) } });
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
    dependencies: { values: c.dependency(c.boolean(), c.array(c.int())) } });
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
  const definition = c.behavior("conditional contract", { input: request, result: c.int().min(1), effects: emptyEffects, dependencies: { lookup: c.dependency(lookup) } });
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
    dependencies: { lookup: c.dependency(c.boolean(), c.int()) } });
  const impl = c.implement(definition, { cases: { request: c.model("independent", (_, deps) => ({
    result: c.bind(c.array(output), c.map(c.boolean(), output, [true], flag => c.bind(c.int(), c.call(deps.lookup, flag), value => c.choose(value.$gte(1), value, 1))), () => c.call(deps.lookup, false)), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("undetermined");
  await expect(c.perform(impl, { kind: "request" }, { lookup: flag => flag ? 1 : -1 })).rejects.toThrow();
});

it("rejects a fold whose update breaks its accumulator contract", async () => {
  const accumulator = c.int64().min(0n).max(100n);
  const definition = c.behavior("bounded sum", { input: request, result: accumulator, effects: emptyEffects,
    dependencies: { values: c.dependency(c.boolean(), c.array(accumulator)) } });
  const impl = c.implement(definition, { cases: { request: c.model("sum", (_, deps) => ({
    result: c.fold(accumulator, accumulator, c.call(deps.values, true), 0n, (sum, value) => c.arithmetic("add", sum, value)), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("undetermined");
  await expect(c.perform(impl, { kind: "request" }, { values: () => [60n, 60n] })).rejects.toThrow("Invalid local construction");
});

it("charges nested iteration proof paths to the same budget", () => {
  const definition = c.behavior("path budget", { input: request, result: c.array(c.int()), effects: emptyEffects,
    dependencies: { values: c.dependency(c.boolean(), c.array(c.int())) } });
  const impl = c.implement(definition, { cases: { request: c.model("map", (_, deps) => ({ result: c.map(c.int(), c.int(), c.call(deps.values, true), value => value), effects: [] })) } });
  expect(c.verify(impl, { ways: 1 }).status).toBe("undetermined");
  expect(c.verify(impl, { ways: 2 }).status).toBe("verified");
});

it("reads a choice on a constant a model binds as settled, owing no row for the outcome it never takes", async () => {
  const definition = c.behavior("local coverage", { input: request, result: c.int(), effects: emptyEffects });
  const impl = c.implement(definition, { cases: { request: c.model("local", () => ({ result: c.bind(c.boolean(), true, value => c.choose(value.$eq(true), 1, 0)), effects: [] })) } });
  const examples = c.examples(definition, { request: { given: { kind: "request" }, expect: { result: 1, effects: [] } } });
  const report = await c.check(c.spec("local coverage", { examples, implementation: impl }));
  expect(report.measures.rules.status === "complete" ? report.measures.rules.rules.map(rule => rule.status) : report.measures.rules).toStrictEqual(["met", "no row owed"]);
  expect(report.verdict).toBe("satisfied");
});

it("never applies one result case's guarantee to a different case", () => {
  const answer = c.variants("kind", { ok: c.object({ amount: c.int() }), missing: c.object({ amount: c.int() }) });
  const lookup = c.behavior("conditional lookup", { input: c.variants("kind", { request: c.object({ minimum: c.int().min(1) }) }), result: answer, effects: emptyEffects,
    ensures: ensure => [ensure.when("positive", ["ok"], (input, value) => value.amount.$gte(input.minimum))] });
  const definition = c.behavior("wrong case", { input: request, result: c.int().min(1), effects: emptyEffects, dependencies: { lookup: c.dependency(lookup) } });
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
  const definition = c.behavior("aliased case", { input: request, result: c.int().min(1), effects: emptyEffects, dependencies: { lookup: c.dependency(lookup) } });
  const impl = c.implement(definition, { cases: { request: c.model("alias", (_, deps) => ({
    result: c.bind(answer, c.call(deps.lookup, { kind: "request", minimum: 1 }), first => c.bind(answer, first, second => c.choose(second.kind.$eq("missing"), second.amount, 1))), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("undetermined");
});

it("matches variant-specific fields with an exhaustive typed result match", async () => {
  const answer = c.variants("kind", { missing: c.object({}), ok: c.object({ amount: c.int() }) });
  const lookup = c.behavior("variant lookup", { input: c.variants("kind", { request: c.object({ minimum: c.int().min(1) }) }), result: answer, effects: emptyEffects,
    ensures: ensure => [ensure.when("positive", ["ok"], (input, value) => value.amount.$gte(input.minimum))] });
  const definition = c.behavior("matched lookup", { input: request, result: c.int().min(1), effects: emptyEffects, dependencies: { lookup: c.dependency(lookup) } });
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

it("reads an element of a map over a field of a dependency's answer as opaque, since no input field holds it", () => {
  const answered = c.object({ items: c.array(c.int()) });
  const definition = c.behavior("answered iteration", { input: request, result: c.array(c.int()), effects: emptyEffects,
    dependencies: { lookup: c.dependency(c.boolean(), answered) } });
  const decision = c.model<c.Infer<typeof definition.input>, readonly number[], never, c.BehaviorDeps<typeof definition>>("map", (_, deps) => ({
    result: c.bind(answered, c.call(deps.lookup, true), answer => c.map(c.int(), c.int(), answer.items, value => value)), effects: [],
  }));
  expect(localsOf(decision.expression).map(local => local.opaque)).toStrictEqual([true]);
});

it("lists the ways through an iteration body one at a time, since a body may have more paths than a caller will list", () => {
  const element = c.object(Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`f${index}`, c.boolean()])));
  const definition = c.behavior("wide body", {
    input: c.variants("kind", { go: c.object({ xs: c.array(element) }) }), result: c.array(c.int()), effects: emptyEffects,
  });
  const impl = c.implement(definition, { cases: { go: c.model("go", input => ({
    result: c.map(element, c.int(), input.xs, flags => Array.from({ length: 25 }).reduce<c.Template<number>>(
      (sum, _, index) => c.arithmetic("add", sum, c.choose((flags as unknown as Record<string, c.TermOf<boolean>>)[`f${index}`]!.$eq(true), 1, 0)), 0)),
    effects: [],
  })) } });
  const ways = eachWayOf(impl.cases.go as never);
  expect([ways.next(), ways.next()].map(way => way.done)).toStrictEqual([false, false]);
});

it.each([[0, "no row owed"], [3, "gap"]] as const)("owes a row for the body of an iteration only where the array can hold an element (max %i)", async (max, status) => {
  const definition = c.behavior("entry", {
    input: c.variants("kind", { go: c.object({ xs: c.array(c.int()).max(max) }) }), result: c.array(c.int()), effects: emptyEffects,
  });
  const impl = c.implement(definition, { cases: { go: c.model("go", input => ({
    result: c.map(c.int(), c.int(), input.xs, x => c.choose(x.$gte(5), 1, 0)), effects: [],
  })) } });
  const rows = c.examples(definition, { none: { given: { kind: "go", xs: [] }, expect: { result: [], effects: [] } } });
  const report = await c.check(c.spec("entry", { implementation: impl, examples: rows }));
  const rules = report.measures.rules;
  expect(rules.status === "complete" ? rules.rules.filter(rule => rule.way.startsWith("each of")).map(rule => rule.status) : rules).toStrictEqual([status, status]);
});

it.each([[true, "no row owed"], [false, "gap"]] as const)("carries the choice that leads into an iteration to its body ways (enabled held to false: %s)", async (held, status) => {
  const shape = c.object({ enabled: c.boolean(), xs: c.array(c.int()) });
  const definition = c.behavior("entered", {
    input: c.variants("kind", { go: held ? shape.refine(v => v.enabled.$eq(false)) : shape }), result: c.array(c.int()), effects: emptyEffects,
  });
  const impl = c.implement(definition, { cases: { go: c.model("go", input => ({
    result: c.choose(input.enabled.$eq(true), c.map(c.int(), c.int(), input.xs, x => c.choose(x.$gte(5), 1, 0)), []), effects: [],
  })) } });
  const rows = c.examples(definition, { none: { given: { kind: "go", enabled: false, xs: [] }, expect: { result: [], effects: [] } } });
  const report = await c.check(c.spec("entered", { implementation: impl, examples: rows }));
  const rules = report.measures.rules;
  expect(rules.status === "complete" ? rules.rules.filter(rule => rule.way.startsWith("each of")).map(rule => rule.status) : rules).toStrictEqual([status, status]);
});

it("reads a decimal threshold only under the cases of a sum the enclosing choices leave possible", () => {
  const payload = c.variants("tier", { coarse: c.object({ amount: c.decimal(1) }), fine: c.object({ amount: c.decimal(2) }) });
  const definition = c.behavior("tiered", {
    input: c.variants("kind", { go: c.object({ payload }) }), result: c.int(), effects: emptyEffects,
  });
  const build = (tier: "coarse" | "fine") => () => c.implement(definition, { cases: { go: c.model("go", input => ({
    result: c.choose(input.payload.tier.$eq(tier), c.choose(input.payload.amount.$eq(new Decimal("0.01")), 1, 0), 0), effects: [],
  })) } });
  expect(build("fine")).not.toThrow();
  expect(build("coarse")).toThrow("which no decimal(1) holds");
});

it("holds a dependency's answer bound inside an iteration to the schema it is bound under, so a choice no answer can take owes no row", async () => {
  const definition = c.behavior("answered body", {
    input: c.variants("kind", { go: c.object({ xs: c.array(c.int()).max(3) }) }), result: c.array(c.int()), effects: emptyEffects,
    dependencies: { lookup: c.dependency(c.int(), c.boolean()) },
  });
  const impl = c.implement(definition, { cases: { go: c.model("go", (input, deps) => ({
    result: c.map(c.int(), c.int(), input.xs, x =>
      c.bind(c.boolean().refine(v => v.$eq(true)), c.call(deps.lookup, x), found => c.choose(found.$eq(true), 1, 0))),
    effects: [],
  })) } });
  const rows = c.examples(definition, { none: { given: { kind: "go", xs: [] }, expect: { result: [], effects: [] } } });
  const report = await c.check(c.spec("answered body", { implementation: impl, examples: rows }));
  const rules = report.measures.rules;
  expect(rules.status === "complete" ? rules.rules.filter(rule => rule.way.startsWith("each of")).map(rule => rule.status) : rules).toStrictEqual(["gap", "no row owed"]);
});

it("lists the body ways of an iteration once, however many outcomes of the choice reach it", () => {
  const definition = c.behavior("reached twice", {
    input: c.variants("kind", { go: c.object({ a: c.boolean(), b: c.boolean(), xs: c.array(c.int()) }) }), result: c.array(c.int()), effects: emptyEffects,
  });
  const impl = c.implement(definition, { cases: { go: c.model("go", input => ({
    result: c.choose(input.a.$eq(true).$or(input.b.$eq(true)), c.map(c.int(), c.int(), input.xs, x => c.choose(x.$gte(5), 1, 0)), []), effects: [],
  })) } });
  expect([...eachWayOf(impl.cases.go as never)].filter(way => way.within !== undefined)).toHaveLength(2);
});

it("keeps the facts a choose is reached under when one expression is read twice under the same choice", () => {
  let written: unknown;
  c.model("shared", (input: any) => {
    const inner = c.choose(input.m.$eq(2), 1, 0);
    const outer = c.choose(input.n.$eq(1), inner, 0);
    written = { p: outer, q: outer };
    return { result: 0 as never, effects: [] };
  });
  expect([...choiceFacts(written).values()].map(facts => facts.length).sort()).toStrictEqual([0, 1]);
});

it("reads a decimal threshold of an iteration's element under the cases the enclosing choice leaves possible", () => {
  const payload = c.variants("tier", { coarse: c.object({ amount: c.decimal(1) }), fine: c.object({ amount: c.decimal(2) }) });
  const element = c.object({ payload });
  const definition = c.behavior("tiered items", {
    input: c.variants("kind", { go: c.object({ xs: c.array(element) }) }), result: c.array(c.int()), effects: emptyEffects,
  });
  const build = (tier: "coarse" | "fine") => () => c.implement(definition, { cases: { go: c.model("go", input => ({
    result: c.map(element, c.int(), input.xs, x => c.choose(x.payload.tier.$eq(tier), c.choose(x.payload.amount.$eq(new Decimal("0.01")), 1, 0), 0)), effects: [],
  })) } });
  expect(build("fine")).not.toThrow();
  expect(build("coarse")).toThrow("which no decimal(1) holds");
});

it("lists iteration discovery without expanding the choices that hold no iteration", () => {
  const flags = Array.from({ length: 28 }, (_, index) => `f${index}`);
  const element = c.object(Object.fromEntries(flags.flatMap(name => [[`${name}a`, c.boolean()], [`${name}b`, c.boolean()]])));
  const definition = c.behavior("wide condition", {
    input: c.variants("kind", { go: c.object({ xs: c.array(element) }) }), result: c.array(c.int()), effects: emptyEffects,
  });
  const impl = c.implement(definition, { cases: { go: c.model("go", input => ({
    result: c.map(element, c.int(), input.xs, x => {
      const row = x as unknown as Record<string, c.TermOf<boolean>>;
      const condition = flags.map(name => row[`${name}a`]!.$eq(true).$or(row[`${name}b`]!.$eq(true))).reduce((all, one) => all.$and(one));
      return c.choose(condition, 1, 0);
    }), effects: [],
  })) } });
  const started = Date.now();
  expect([...iterationEntries((impl.cases.go as never as { expression: unknown }).expression)]).toHaveLength(1);
  expect(Date.now() - started).toBeLessThan(2000);
});

it("proves a field under a choice that settles a sum to the case that leaves out a field an invariant reads behind its discriminant", () => {
  const sum = c.variants("t", { a: c.object({ x: c.int() }), b: c.object({}) });
  const shape = c.object({ s: sum, n: c.int().min(0) }).refine(v => v.s.t.$ne("a").$or(v.s.x.$gte(1)));
  const definition = c.behavior("settled sum", { input: c.variants("kind", { go: shape }), result: c.int().min(0), effects: emptyEffects });
  const impl = c.implement(definition, { cases: { go: c.model("go", input => ({ result: c.choose(input.s.t.$eq("b"), input.n, 0), effects: [] })) } });
  expect(c.verify(impl).status).toBe("verified");
});

it("owes no row for the body of an iteration that every way of entering it contradicts", async () => {
  const shape = c.object({ a: c.boolean(), b: c.boolean(), xs: c.array(c.int()) }).refine(v => v.a.$eq(false).$and(v.b.$eq(false)));
  const definition = c.behavior("entered twice", { input: c.variants("kind", { go: shape }), result: c.array(c.int()), effects: emptyEffects });
  const impl = c.implement(definition, { cases: { go: c.model("go", input => ({
    result: c.choose(input.a.$eq(true).$or(input.b.$eq(true)), c.map(c.int(), c.int(), input.xs, x => c.choose(x.$gte(5), 1, 0)), []), effects: [],
  })) } });
  const rows = c.examples(definition, { none: { given: { kind: "go", a: false, b: false, xs: [] }, expect: { result: [], effects: [] } } });
  const rules = (await c.check(c.spec("entered twice", { implementation: impl, examples: rows }))).measures.rules;
  expect(rules.status === "complete" ? rules.rules.filter(rule => rule.way.startsWith("each of")).map(rule => rule.status) : rules).toStrictEqual(["no row owed", "no row owed"]);
});

it("stops looking for the ways into an iteration past a bound, however many outcomes the choices before it have", () => {
  const flags = Array.from({ length: 28 }, (_, index) => `f${index}`);
  const element = c.object({ ...Object.fromEntries(flags.flatMap(name => [[`${name}a`, c.boolean()], [`${name}b`, c.boolean()]])), ys: c.array(c.int()) });
  const definition = c.behavior("nested", { input: c.variants("kind", { go: c.object({ xs: c.array(element) }) }), result: c.array(c.int()), effects: emptyEffects });
  const impl = c.implement(definition, { cases: { go: c.model("go", input => ({
    result: c.map(element, c.int(), input.xs, x => {
      const row = x as unknown as Record<string, c.TermOf<boolean> & c.TermOf<number[]>>;
      const condition = flags.map(name => row[`${name}a`]!.$eq(true).$or(row[`${name}b`]!.$eq(true))).reduce((all, one) => all.$and(one));
      return c.choose(condition, c.map(c.int(), c.int(), (x as unknown as { ys: never }).ys, y => c.choose(y.$gte(1), 1, 0)), 0) as never;
    }), effects: [],
  })) } });
  const started = Date.now();
  const ways = eachWayOf(impl.cases.go as never);
  for (let index = 0; index < 3; index++) ways.next();
  expect(Date.now() - started).toBeLessThan(2000);
});

it("proves under a case of a sum whose own invariant reads a field only another case declares", () => {
  const sum = c.variants("t", { a: c.object({ p: c.object({ x: c.int() }) }), b: c.object({ p: c.object({}) }) })
    .refine(v => v.t.$ne("a").$or(v.p.x.$gte(1)));
  const definition = c.behavior("sum invariant", { input: c.variants("kind", { go: c.object({ s: sum, n: c.int().min(0) }) }), result: c.int().min(0), effects: emptyEffects });
  const impl = c.implement(definition, { cases: { go: c.model("go", input => ({ result: c.choose(input.s.t.$eq("b"), input.n, 0), effects: [] })) } });
  expect(c.verify(impl).status).toBe("verified");
});

it("still lists the body ways of an iteration whose ways in are too many to list, and marks them unlisted", () => {
  const flags = Array.from({ length: 14 }, (_, index) => `f${index}`);
  const element = c.object({ ...Object.fromEntries(flags.flatMap(name => [[`${name}a`, c.boolean()], [`${name}b`, c.boolean()]])), ys: c.array(c.int()) });
  const definition = c.behavior("many ways in", { input: c.variants("kind", { go: c.object({ xs: c.array(element) }) }), result: c.array(c.int()), effects: emptyEffects });
  const impl = c.implement(definition, { cases: { go: c.model("go", input => ({
    result: c.map(element, c.int(), input.xs, x => {
      const row = x as unknown as Record<string, c.TermOf<boolean>>;
      const condition = flags.map(name => row[`${name}a`]!.$eq(true).$or(row[`${name}b`]!.$eq(true))).reduce((all, one) => all.$and(one));
      return c.choose(condition, c.map(c.int(), c.int(), (x as unknown as { ys: never }).ys, y => c.choose(y.$gte(1), 1, 0)), 0) as never;
    }), effects: [],
  })) } });
  const inner = iterationsOf((impl.cases.go as never as { expression: unknown }).expression).find(node => node.body !== undefined && iterationsOf(node.body).length === 0);
  const ways = [...eachWayOf(impl.cases.go as never)].filter(way => way.within === inner);
  expect(ways.length).toBeGreaterThan(0);
  expect(ways.every(way => way.entryUnlisted === true && way.entered === undefined)).toBe(true);
});
