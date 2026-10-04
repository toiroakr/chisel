import { expect, it } from "vitest";
import * as c from "../src/index.js";
import { runTraced } from "../src/behavior.js";

const flags = c.behavior("flags", {
  input: c.variants("kind", { input: c.object({ a: c.boolean(), b: c.boolean() }) }),
  result: c.int().min(0).max(2), effects: c.variants("kind", {}),
});
const count = c.implement(flags, { cases: { input: c.model("count", input => ({
  result: c.arithmetic("add", c.choose(input.a.$eq(true), 1, 0), c.choose(input.b.$eq(true), 1, 0)), effects: [],
})) } });
it("reads every decision that contributes to a computation", async () => {
  expect(c.verify(count).status).toBe("verified");
  expect((await runTraced(count, { kind: "input", a: true, b: false })).way?.steps).toHaveLength(2);
  const rows = c.examples(flags, {
    neither: { given: { kind: "input", a: false, b: false }, expect: { result: 0, effects: [] } },
    both: { given: { kind: "input", a: true, b: true }, expect: { result: 2, effects: [] } },
  });
  const report = await c.check(c.spec("count", { examples: rows, implementation: count }));
  expect(report.verdict).toBe("not_satisfied");
  expect(report.measures.rules.status).toBe("complete");
  if (report.measures.rules.status === "complete") expect(report.measures.rules.rules).toHaveLength(4);
  expect(c.generate(rows, count, { ways: true }).rows.map(row => row.given)).toContainEqual({ kind: "input", a: false, b: true });
});
it("finds a construction counterexample outside the example rows", () => {
  const invalid = c.implement(flags, { cases: { input: c.model("bad", input => ({
    result: c.choose(input.a.$eq(true), 3, 0), effects: [],
  })) } });
  const proof = c.verify(invalid);
  expect(proof.status).toBe("refuted");
  expect(proof.decisions[0]!.counterexample).toMatchObject({ a: true });
});
it("proves a constrained value is safe to return over an unbounded input domain", () => {
  const positive = c.behavior("positive", { input: c.variants("kind", { input: c.object({ n: c.int().min(1) }) }), result: c.int().min(0), effects: c.variants("kind", {}) });
  const identity = c.implement(positive, { cases: { input: c.model("identity", input => ({ result: input.n, effects: [] })) } });
  expect(c.verify(identity).status).toBe("verified");
});
it("validates intermediate constructions even when their result schema is weaker", () => {
  const invalid = c.implement(flags, { cases: { input: c.model("constructor", () => ({ result: c.construct(c.int().min(1), 0), effects: [] })) } });
  expect(c.verify(invalid).status).toBe("refuted");
});
it("never calls an opaque callback to claim a static proof", async () => {
  let invoked = 0;
  const opaque = c.implement(flags, { cases: { input: c.action("opaque", { run: () => { invoked++; return { result: 0, effects: [] }; } }) } });
  expect(c.verify(opaque).status).toBe("undetermined");
  expect(invoked).toBe(0);
});
it("proves path-specific output invariants", () => {
  const absolute = c.behavior("absolute", { input: c.variants("kind", { input: c.object({ n: c.int() }) }), result: c.int().min(0), effects: c.variants("kind", {}) });
  const impl = c.implement(absolute, { cases: { input: c.model("nonnegative", input => ({ result: c.choose(input.n.$gte(0), input.n, 0), effects: [] })) } });
  expect(c.verify(impl).status).toBe("verified");
});
it("certifies a complete expression model and every pair obligation", async () => {
  const { specification } = await import("../examples/verified.spec.js");
  const report = await c.check(specification);
  expect(report.verdict).toBe("satisfied");
  expect(report.adequate).toBe(true);
});
it("proves value dependencies over their entire finite domain", () => {
  const definition = c.behavior("dependent", { input: c.variants("kind", { input: c.object({}) }), result: c.boolean(), effects: c.variants("kind", {}), requires: { enabled: c.dependency(c.boolean()) } });
  const impl = c.implement(definition, { cases: { input: c.model("enabled", (_, deps) => ({ result: deps.enabled, effects: [] })) } });
  expect(c.verify(impl).status).toBe("verified");
});
it("proves exact arithmetic ranges without enumerating all inputs", () => {
  const definition = c.behavior("large", { input: c.variants("kind", { input: c.object({ n: c.int64().min(0n).max(10000000000000000n) }) }), result: c.int64().min(1n), effects: c.variants("kind", {}) });
  const impl = c.implement(definition, { cases: { input: c.model("increment", input => ({ result: c.arithmetic("add", input.n, 1n), effects: [] })) } });
  expect(c.verify(impl).status).toBe("verified");
});
it("does not prove overflowing intermediate arithmetic", () => {
  const definition = c.behavior("overflow", { input: c.variants("kind", { input: c.object({ n: c.int() }) }), result: c.int(), effects: c.variants("kind", {}) });
  const impl = c.implement(definition, { cases: { input: c.model("increment", input => ({ result: c.arithmetic("add", input.n, 1), effects: [] })) } });
  expect(c.verify(impl).status).not.toBe("verified");
});
it("enforces value dependency assumptions at the execution boundary", async () => {
  const definition = c.behavior("dependent-bound", { input: c.variants("kind", { input: c.object({}) }), result: c.int().min(1), effects: c.variants("kind", {}), requires: { minimum: c.dependency(c.int().min(1)) } });
  const impl = c.implement(definition, { cases: { input: c.model("minimum", (_, deps) => ({ result: c.choose(deps.minimum.$gte(1), deps.minimum, 1), effects: [] })) } });
  expect(c.verify(impl).status).toBe("verified");
  await expect(c.perform(impl, { kind: "input" }, { minimum: 0 })).rejects.toThrow("Invalid dependency minimum");
});
it("does not certify a pipeline whose next stage rejects an earlier result", async () => {
  const first = c.behavior("first", {
    input: c.variants("kind", { start: c.object({}) }),
    result: c.variants("kind", { next: c.object({ n: c.int() }) }),
    effects: c.variants("kind", {}),
  });
  const second = c.behavior("second", {
    input: c.variants("kind", { next: c.object({ n: c.int().min(1) }) }),
    result: c.variants("kind", { done: c.object({}) }),
    effects: c.variants("kind", {}),
  });
  const producer = c.implement(first, { cases: { start: c.model("zero", () => ({ result: { kind: "next", n: 0 }, effects: [] })) } });
  const consumer = c.implement(second, { cases: { next: c.model("done", () => ({ result: { kind: "done" }, effects: [] })) } });
  const [, joined] = c.compose("joined", [producer, consumer]);
  await expect(c.perform(joined, { kind: "start" })).rejects.toThrow("Invalid input");
  expect(c.verify(joined).status).not.toBe("verified");
});
it("certifies a pipeline when every finite result satisfies the next input", () => {
  const first = c.behavior("finite producer", {
    input: c.variants("kind", { start: c.object({}) }),
    result: c.variants("kind", { next: c.object({ n: c.int().min(1).max(2) }) }),
    effects: c.variants("kind", {}),
  });
  const second = c.behavior("finite consumer", {
    input: c.variants("kind", { next: c.object({ n: c.int().min(1) }) }),
    result: c.variants("kind", { done: c.object({}) }),
    effects: c.variants("kind", {}),
  });
  const producer = c.implement(first, { cases: { start: c.model("one", () => ({ result: { kind: "next", n: 1 }, effects: [] })) } });
  const consumer = c.implement(second, { cases: { next: c.model("done", () => ({ result: { kind: "done" }, effects: [] })) } });
  const [, joined] = c.compose("finite pipeline", [producer, consumer]);
  expect(c.verify(joined).status).toBe("verified");
});
it("preserves an input field named #deps when no dependencies are declared", async () => {
  const definition = c.behavior("input field", {
    input: c.variants("kind", { input: c.object({ "#deps": c.boolean() }) }),
    result: c.boolean(), effects: c.variants("kind", {}),
  });
  const impl = c.implement(definition, { cases: { input: c.model("identity", input => ({ result: input["#deps"], effects: [] })) } });
  await expect(c.perform(impl, { kind: "input", "#deps": true })).resolves.toEqual({ result: true, effects: [] });
  await expect(c.perform(impl, { kind: "input", "#deps": true }, {})).resolves.toStrictEqual({ result: true, effects: [] });
  expect(c.verify(impl).status).toBe("verified");
});
