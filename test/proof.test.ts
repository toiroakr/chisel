import { expect, it } from "vitest";
import * as c from "../src/index.js";

it("preserves a quantified input invariant when returning the same collection", () => {
  const positive = c.array(c.int()).refine(xs => xs.$all(x => x.$gte(1)));
  const definition = c.behavior("carry", {
    input: c.variants("kind", { input: c.object({ values: positive }) }),
    result: positive, effects: c.variants("kind", {}),
  });
  const impl = c.implement(definition, { cases: { input: c.model("carry", input => ({
    result: c.construct(positive, input.values), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("verified");
});

it("uses an all guard to prove a collection construction", () => {
  const positive = c.array(c.int()).refine(xs => xs.$all(x => x.$gte(1)));
  const definition = c.behavior("guarded", {
    input: c.variants("kind", { input: c.object({ values: c.array(c.int()) }) }),
    result: positive, effects: c.variants("kind", {}),
  });
  const impl = c.implement(definition, { cases: { input: c.model("guarded", input => ({
    result: c.choose(input.values.$all(x => x.$gte(1)), c.construct(positive, input.values), c.construct(positive, [])),
    effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("verified");
});

it("carries a quantified relation declared on a parent object", () => {
  const positive = c.array(c.int()).refine(xs => xs.$all(x => x.$gte(1)));
  const definition = c.behavior("parent", {
    input: c.variants("kind", { input: c.object({ cart: c.object({ values: c.array(c.int()) }).refine(cart => cart.values.$all(x => x.$gte(1))) }) }),
    result: positive, effects: c.variants("kind", {}),
  });
  const impl = c.implement(definition, { cases: { input: c.model("parent", input => ({ result: input.cart.values, effects: [] })) } });
  expect(c.verify(impl).status).toBe("verified");
});

it("keeps nested quantifier bindings distinct", () => {
  const matrix = c.array(c.array(c.int())).refine(rows => rows.$all(row => row.$all(value => value.$gte(1))));
  const definition = c.behavior("matrix", {
    input: c.variants("kind", { input: c.object({ rows: c.array(c.array(c.int())) }) }),
    result: matrix, effects: c.variants("kind", {}),
  });
  const impl = c.implement(definition, { cases: { input: c.model("matrix", input => ({
    result: c.choose(input.rows.$all(row => row.$all(value => value.$gte(1))), c.construct(matrix, input.rows), []), effects: [],
  })) } });
  expect(c.verify(impl).status).toBe("verified");
});

it("does not use any as evidence that all elements satisfy a condition", () => {
  const positive = c.array(c.int()).refine(xs => xs.$all(x => x.$gte(1)));
  const definition = c.behavior("some", {
    input: c.variants("kind", { input: c.object({ values: c.array(c.int()) }) }),
    result: positive, effects: c.variants("kind", {}),
  });
  const impl = c.implement(definition, { cases: { input: c.model("some", input => ({
    result: c.choose(input.values.$any(x => x.$gte(1)), c.construct(positive, input.values), []), effects: [],
  })) } });
  expect(c.verify(impl, { candidates: 1 }).status).toBe("undetermined");
});

it("does not transfer a quantified fact to a different collection", () => {
  const positive = c.array(c.int()).refine(xs => xs.$all(x => x.$gte(1)));
  const definition = c.behavior("other", {
    input: c.variants("kind", { input: c.object({ left: c.array(c.int()), right: c.array(c.int()) }) }),
    result: positive, effects: c.variants("kind", {}),
  });
  const impl = c.implement(definition, { cases: { input: c.model("other", input => ({
    result: c.choose(input.left.$all(x => x.$gte(1)), c.construct(positive, input.right), []), effects: [],
  })) } });
  expect(c.verify(impl, { candidates: 1 }).status).toBe("undetermined");
});

it("proves compatible collection element schemas without enumerating the collection", () => {
  const definition = c.behavior("element bounds", {
    input: c.variants("kind", { input: c.object({ values: c.array(c.object({ n: c.int().min(1) })) }) }),
    result: c.array(c.object({ n: c.int().min(0) })), effects: c.variants("kind", {}),
  });
  const impl = c.implement(definition, { cases: { input: c.model("elements", input => ({ result: input.values, effects: [] })) } });
  expect(c.verify(impl).status).toBe("verified");
});

it("does not skip an element invariant while proving structural compatibility", () => {
  const definition = c.behavior("unsafe elements", {
    input: c.variants("kind", { input: c.object({ values: c.array(c.object({ n: c.int() })) }) }),
    result: c.array(c.object({ n: c.int().min(1) })), effects: c.variants("kind", {}),
  });
  const impl = c.implement(definition, { cases: { input: c.model("elements", input => ({ result: input.values, effects: [] })) } });
  expect(c.verify(impl, { candidates: 1 }).status).toBe("undetermined");
});
it("does not use a denied all guard to certify a collection", () => {
  const positive = c.array(c.int()).refine(xs => xs.$all(x => x.$gte(1)));
  const definition = c.behavior("denied", {
    input: c.variants("kind", { input: c.object({ values: c.array(c.int()) }) }),
    result: positive, effects: c.variants("kind", {}),
  });
  const impl = c.implement(definition, { cases: { input: c.model("denied", input => ({
    result: c.choose(input.values.$all(x => x.$gte(1)), c.construct(positive, []), c.construct(positive, input.values)), effects: [],
  })) } });
  expect(c.verify(impl, { candidates: 1 }).status).toBe("undetermined");
});

it("preserves free variables when substituting a quantified postcondition", () => {
  const definition = c.behavior("captured bound", {
    input: c.variants("kind", { input: c.object({ lower: c.int(), upper: c.int(), values: c.array(c.int()) }) }),
    result: c.object({ limit: c.int(), values: c.array(c.int()) }).refine(value => value.values.$all(item => item.$gte(value.limit))),
    effects: c.variants("kind", {}),
  });
  const impl = c.implement(definition, { cases: { input: c.model("wrong bound", input => ({
    result: { limit: input.upper, values: c.choose(input.values.$all(item => item.$gte(input.lower)), input.values, []) }, effects: [],
  })) } });
  expect(c.verify(impl, { candidates: 1 }).status).toBe("undetermined");
});
it("proves an unbounded pipeline boundary from structural and numeric contracts", () => {
  const first = c.behavior("producer", {
    input: c.variants("kind", { start: c.object({}) }),
    result: c.variants("kind", { next: c.object({ values: c.array(c.int().min(1)) }) }),
    effects: c.variants("kind", {}),
  });
  const second = c.behavior("consumer", {
    input: c.variants("kind", { next: c.object({ values: c.array(c.int().min(0)) }) }),
    result: c.variants("kind", { done: c.object({}) }), effects: c.variants("kind", {}),
  });
  const producer = c.implement(first, { cases: { start: c.model("empty", () => ({ result: { kind: "next", values: [] }, effects: [] })) } });
  const consumer = c.implement(second, { cases: { next: c.model("done", () => ({ result: { kind: "done" }, effects: [] })) } });
  const [, joined] = c.compose("contract pipeline", [producer, consumer]);
  expect(c.verify(joined).status).toBe("verified");
});

it("verifies pipeline contracts with an inherited object property as the discriminant", () => {
  const first = c.behavior("prototype tag producer", {
    input: c.variants("toString", { start: c.object({}) }),
    result: c.variants("toString", { next: c.object({}) }),
    effects: c.variants("toString", {}),
  });
  const second = c.behavior("prototype tag consumer", {
    input: c.variants("toString", { next: c.object({}) }),
    result: c.variants("toString", { done: c.object({}) }),
    effects: c.variants("toString", {}),
  });
  const producer = c.implement(first, { cases: { start: c.model("produce", () => ({ result: { toString: "next" }, effects: [] })) } });
  const consumer = c.implement(second, { cases: { next: c.model("consume", () => ({ result: { toString: "done" }, effects: [] })) } });
  const [, joined] = c.compose("prototype tag pipeline", [producer, consumer]);
  expect(c.verify(joined).status).toBe("verified");
});

it("verifies pipeline contracts with outer tagged invariants", () => {
  const first = c.behavior("outer producer", {
    input: c.variants("kind", { start: c.object({}) }),
    result: c.variants("kind", { next: c.object({ n: c.int() }) }).refine(value => value.kind.$eq("next").$and(value.n.$gte(1))),
    effects: c.variants("kind", {}),
  });
  const second = c.behavior("outer consumer", {
    input: c.variants("kind", { next: c.object({ n: c.int() }) }).refine(value => value.kind.$eq("next").$and(value.n.$gte(0))),
    result: c.variants("kind", { done: c.object({}) }), effects: c.variants("kind", {}),
  });
  const producer = c.implement(first, { cases: { start: c.model("produce", () => ({ result: { kind: "next", n: 1 }, effects: [] })) } });
  const consumer = c.implement(second, { cases: { next: c.model("consume", () => ({ result: { kind: "done" }, effects: [] })) } });
  const [, joined] = c.compose("outer contract pipeline", [producer, consumer]);
  expect(c.verify(joined).status).toBe("verified");
});

it("does not transfer quantified facts between dotted keys and nested paths", async () => {
  const bounded = c.array(c.int()).refine(values => values.$all(value => value.$lte(1000)));
  const definition = c.behavior("distinct paths", {
    input: c.variants("kind", { request: c.object({ "a.b": bounded, a: c.object({ b: c.array(c.int()) }) }) }),
    result: bounded, effects: c.variants("kind", {}),
  });
  const implementation = c.implement(definition, { cases: { request: c.model("nested values", input => ({ result: input.a.b, effects: [] })) } });
  expect(c.verify(implementation, { candidates: 64 }).status).toBe("undetermined");
  await expect(c.perform(implementation, { kind: "request", "a.b": [1], a: { b: [1001] } })).rejects.toThrow("Invalid result");
});

it("checks finite pipeline domains with outer invariants", () => {
  const first = c.behavior("finite producer", {
    input: c.variants("kind", { start: c.object({}) }),
    result: c.variants("kind", { next: c.object({ n: c.int().min(1).max(3) }) }).refine(value => value.kind.$eq("next").$and(value.n.$eq(1).$or(value.n.$eq(3)))),
    effects: c.variants("kind", {}),
  });
  const second = c.behavior("finite consumer", {
    input: c.variants("kind", { next: c.object({ n: c.int() }) }).refine(value => value.n.$ne(2)),
    result: c.variants("kind", { done: c.object({}) }), effects: c.variants("kind", {}),
  });
  const producer = c.implement(first, { cases: { start: c.model("produce", () => ({ result: { kind: "next", n: 1 }, effects: [] })) } });
  const consumer = c.implement(second, { cases: { next: c.model("consume", () => ({ result: { kind: "done" }, effects: [] })) } });
  const [, joined] = c.compose("finite outer contracts", [producer, consumer]);
  expect(c.verify(joined).status).toBe("verified");
});
