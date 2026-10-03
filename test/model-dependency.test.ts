import { expect, it } from "vitest";
import * as c from "../src/index.js";

it("rejects function dependencies inherited from the declaration map prototype", () => {
  const declarations = { lookup: c.dependency(c.boolean(), c.boolean()) };
  const requires: typeof declarations = Object.create(declarations);
  const definition = c.behavior("inherited declaration", {
    input: c.variants("kind", { request: c.object({}) }),
    result: c.boolean(), effects: c.variants("kind", {}), requires,
  });
  expect(() => c.implement(definition, { cases: { request: c.model("lookup", (_, deps) => ({
    result: c.call(deps.lookup, true), effects: [],
  })) } })).toThrow("call requires a declared function dependency");
});

it("does not prove or execute calls whose declaration was moved to a prototype", async () => {
  const requires = { lookup: c.dependency(c.boolean(), c.boolean()) };
  const definition = c.behavior("changed declaration", {
    input: c.variants("kind", { request: c.object({}) }),
    result: c.boolean(), effects: c.variants("kind", {}), requires,
  });
  const impl = c.implement(definition, { cases: { request: c.model("lookup", (_, deps) => ({
    result: c.call(deps.lookup, true), effects: [],
  })) } });
  Object.setPrototypeOf(requires, { lookup: requires.lookup });
  Reflect.deleteProperty(requires, "lookup");
  expect(c.verify(impl).status).toBe("undetermined");
  await expect(c.perform(impl, { kind: "request" }, { lookup: value => value })).rejects.toThrow("Missing function dependency lookup");
});

it("proves a function dependency call from its declared contract", async () => {
  const definition = c.behavior("pricing", {
    input: c.variants("kind", { request: c.object({ quantity: c.int().min(1).max(100) }) }),
    result: c.int().min(1).max(101), effects: c.variants("kind", {}),
    requires: { price: c.dependency(c.int().min(1).max(100), c.int().min(0).max(100)) },
  });
  const impl = c.implement(definition, { cases: { request: c.model("pricing", (input, deps) => ({
    result: c.arithmetic("add", c.call(deps.price, input.quantity), 1), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("verified");
  await expect(c.perform(impl, { kind: "request", quantity: 2 }, { price: n => n * 2 })).resolves.toStrictEqual({ result: 5, effects: [] });
  await expect(c.perform(impl, { kind: "request", quantity: 2 }, { price: () => -1 })).rejects.toThrow("Invalid dependency price result");
});

it("does not certify a dependency argument outside its input contract", async () => {
  const definition = c.behavior("invalid call", {
    input: c.variants("kind", { request: c.object({ quantity: c.int() }) }),
    result: c.int(), effects: c.variants("kind", {}),
    requires: { price: c.dependency(c.int().min(1), c.int()) },
  });
  const impl = c.implement(definition, { cases: { request: c.model("invalid call", (input, deps) => ({ result: c.call(deps.price, input.quantity), effects: [] })) } });
  expect(c.verify(impl).status).toBe("undetermined");
  let calls = 0;
  await expect(c.perform(impl, { kind: "request", quantity: 0 }, { price: () => { calls++; return 1; } })).rejects.toThrow("Invalid dependency price input");
  expect(calls).toBe(0);
});

it("checks and uses a dependency's postcondition", async () => {
  const bounded = c.behavior("bounded", {
    input: c.variants("kind", { request: c.object({ minimum: c.int().min(1) }) }),
    result: c.int(), effects: c.variants("kind", {}),
    ensures: ensure => [ensure.always("positive", (input, value) => value.$gte(input.minimum))],
  });
  const definition = c.behavior("uses bounded", {
    input: c.variants("kind", { request: c.object({}) }),
    result: c.int().min(1), effects: c.variants("kind", {}),
    requires: { bounded: c.dependency(bounded) },
  });
  const impl = c.implement(definition, { cases: { request: c.model("call", (input, deps) => ({ result: c.call(deps.bounded, { kind: "request", minimum: 1 }), effects: [] })) } });
  expect(c.verify(impl).status).toBe("verified");
  await expect(c.perform(impl, { kind: "request" }, { bounded: () => 0 })).rejects.toThrow("breaks ensures positive");
});

it("does not require an unused function dependency to be invoked for a proof", () => {
  const definition = c.behavior("unused", {
    input: c.variants("kind", { request: c.object({}) }),
    result: c.int(), effects: c.variants("kind", {}),
    requires: { lookup: c.dependency(c.string(), c.int()) },
  });
  const impl = c.implement(definition, { cases: { request: c.model("constant", () => ({ result: 1, effects: [] })) } });
  expect(c.verify(impl).status).toBe("verified");
});
it("isolates values returned by a dependency from later calls", async () => {
  const { Decimal } = await import("decimal.js");
  const definition = c.behavior("stable dependency values", {
    input: c.variants("kind", { request: c.object({}) }),
    result: c.decimal(0).min(new Decimal(2)).max(new Decimal(2)), effects: c.variants("kind", {}),
    requires: { amount: c.dependency(c.boolean(), c.decimal(0).min(new Decimal(1)).max(new Decimal(1))) },
  });
  const impl = c.implement(definition, { cases: { request: c.model("sum", (_, deps) => ({
    result: c.arithmetic("add", c.call(deps.amount, false), c.call(deps.amount, true)), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("verified");
  const shared = new Decimal(1);
  const actual = await c.perform(impl, { kind: "request" }, { amount: second => {
    if (!second) return shared;
    shared.d[0] = 9;
    return new Decimal(1);
  } });
  expect(String(actual.result)).toBe("2");
});
it("does not assume two dependency calls return the same value", () => {
  const definition = c.behavior("independent calls", {
    input: c.variants("kind", { request: c.object({}) }),
    result: c.object({ first: c.boolean(), second: c.boolean() }).refine(value => value.first.$eq(value.second)),
    effects: c.variants("kind", {}), requires: { flag: c.dependency(c.boolean(), c.boolean()) },
  });
  const impl = c.implement(definition, { cases: { request: c.model("twice", (_, deps) => ({
    result: { first: c.call(deps.flag, true), second: c.call(deps.flag, true) }, effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("undetermined");
});

it("uses a path condition to establish a dependency's input contract", () => {
  const definition = c.behavior("guarded dependency", {
    input: c.variants("kind", { request: c.object({ n: c.int() }) }),
    result: c.int().min(0), effects: c.variants("kind", {}),
    requires: { price: c.dependency(c.int().min(1), c.int().min(0)) },
  });
  const impl = c.implement(definition, { cases: { request: c.model("guarded call", (input, deps) => ({
    result: c.choose(input.n.$gte(1), c.call(deps.price, input.n), 0), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("verified");
});

it("strictly checks a function dependency model using its fake table", async () => {
  const definition = c.behavior("toggle", {
    input: c.variants("kind", { request: c.object({ enabled: c.boolean() }) }),
    result: c.boolean(), effects: c.variants("kind", {}),
    requires: { toggle: c.dependency(c.boolean(), c.boolean()) },
  });
  const impl = c.implement(definition, { cases: { request: c.model("toggle", (input, deps) => ({ result: c.call(deps.toggle, input.enabled), effects: [] })) } });
  const specification = c.spec("toggle", {
    implementation: impl,
    examples: c.examples(definition, {
      on: { given: { kind: "request", enabled: false }, expect: { result: true, effects: [] } },
      off: { given: { kind: "request", enabled: true }, expect: { result: false, effects: [] } },
    }),
    fakes: [c.fake(definition, "toggle", [[true, false], [false, true]])],
  });
  expect((await c.check(specification)).verdict).toBe("satisfied");
});
it("passes the input value without internal dependency bindings", async () => {
  const shape = c.variants("kind", { request: c.object({ n: c.int().min(1) }) });
  const definition = c.behavior("whole input", {
    input: shape, result: c.int().min(1), effects: c.variants("kind", {}),
    requires: { lookup: c.dependency(shape, c.int().min(1)) },
  });
  const impl = c.implement(definition, { cases: { request: c.model("whole", (input, deps) => ({ result: c.call(deps.lookup, input), effects: [] })) } });
  await expect(c.perform(impl, { kind: "request", n: 1 }, { lookup: input => input.n })).resolves.toStrictEqual({ result: 1, effects: [] });
  expect(c.verify(impl).status).toBe("verified");
});

it("rejects a dependency namespace that collides with an input field", () => {
  expect(() => c.behavior("collision", {
    input: c.variants("kind", { request: c.object({ "#deps": c.boolean() }) }),
    result: c.boolean(), effects: c.variants("kind", {}),
    requires: { flag: c.dependency(c.boolean()) },
  })).toThrow("#deps is reserved");
});

it("keeps input and value dependencies stable when a callback mutates retained values", async () => {
  const { Decimal } = await import("decimal.js");
  const one = c.decimal(0).min(new Decimal(1)).max(new Decimal(1));
  const definition = c.behavior("stable model scope", {
    input: c.variants("kind", { request: c.object({ amount: one }) }),
    result: c.decimal(0).min(new Decimal(3)).max(new Decimal(3)), effects: c.variants("kind", {}),
    requires: { amount: c.dependency(one), mutate: c.dependency(c.boolean(), one) },
  });
  const impl = c.implement(definition, { cases: { request: c.model("sum", (input, deps) => ({
    result: c.arithmetic("add", c.call(deps.mutate, true), c.arithmetic("add", input.amount, deps.amount)), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("verified");
  const inputAmount = new Decimal(1);
  const dependencyAmount = new Decimal(1);
  const actual = await c.perform(impl, { kind: "request", amount: inputAmount }, {
    amount: dependencyAmount,
    mutate: () => {
      inputAmount.d[0] = 9;
      dependencyAmount.d[0] = 9;
      return new Decimal(1);
    },
  });
  expect(String(actual.result)).toBe("3");
});

it("rejects mutable host objects instead of sharing them across dependency boundaries", async () => {
  const hostDate = {
    ...c.object({}), kind: "host-date",
    parse(value: unknown): c.ValidationResult<Date> {
      return value instanceof Date ? { success: true, value } : { success: false, issues: [{ path: "$", message: "Expected Date" }] };
    },
    placeholder: () => new Date(0),
  } as unknown as c.Schema<unknown>;
  const definition = c.behavior("host object", {
    input: c.variants("kind", { request: c.object({}) }),
    result: hostDate, effects: c.variants("kind", {}),
    requires: { date: c.dependency(c.boolean(), hostDate) },
  });
  const impl = c.implement(definition, { cases: { request: c.model("date", (_, deps) => ({ result: c.call(deps.date, true), effects: [] })) } });
  await expect(c.perform(impl, { kind: "request" }, { date: () => new Date(0) })).rejects.toThrow("Cannot snapshot an unsupported host object");
});

it("rejects a dependency namespace collision with the input discriminant", () => {
  expect(() => c.behavior("reserved discriminant", {
    input: c.variants("#deps", { request: c.object({}) }),
    result: c.boolean(), effects: c.variants("kind", {}),
    requires: { enabled: c.dependency(c.boolean()) },
  })).toThrow("#deps is reserved");
});

it("does not resolve a missing function dependency from Object.prototype", async () => {
  const definition = c.behavior("own dependency", {
    input: c.variants("kind", { request: c.object({}) }),
    result: c.string(), effects: c.variants("kind", {}),
    requires: { toString: c.dependency(c.boolean(), c.string()) },
  });
  const implementation = c.implement(definition, { cases: { request: c.model("lookup", (_, deps) => ({ result: c.call(deps.toString, true), effects: [] })) } });
  await expect(c.perform(implementation, { kind: "request" }, {})).rejects.toThrow("Missing function dependency toString");
  await expect(c.perform(implementation, { kind: "request" }, { toString: () => "declared" })).resolves.toStrictEqual({ result: "declared", effects: [] });
});
