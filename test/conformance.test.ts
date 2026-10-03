import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const lookup = c.behavior("lookup", {
  input: c.variants("type", { query: c.object({ id: c.string().min(1) }) }),
  result: c.variants("type", { found: c.object({ count: c.int().min(0) }) }),
  effects: c.variants("type", { logged: c.object({ id: c.string() }) }),
});

const rows = c.examples(lookup, {
  found: {
    given: { type: "query", id: "a" },
    expect: { result: c.caseOf("found"), effects: [] },
  },
});

describe("conformance at the schema boundary", () => {
  it("refuses an invalid result even when the expected case matches", async () => {
    const outcome = await c.test(rows, () => ({
      result: { type: "found" } as c.BehaviorResult<typeof lookup>,
      effects: [],
    }));

    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({ name: "found", message: expect.stringContaining("Result is invalid") });
  });
});

it("refuses invalid input before calling the subject", async () => {
  let called = false;
  const invalid = c.examples(lookup, {
    invalid: { given: { type: "query", id: "" }, expect: { result: c.caseOf("found"), effects: [] } },
  });
  const outcome = await c.test(invalid, () => {
    called = true;
    return { result: { type: "found", count: 1 }, effects: [] };
  });
  expect(called).toBe(false);
  expect(outcome.failures).toMatchObject([{ name: "invalid", message: expect.stringContaining("Example input is invalid") }]);
});

it("refuses an invalid expected effect even when production answers the same value", async () => {
  const invalid = { type: "logged" } as c.BehaviorEffect<typeof lookup>;
  const exampleSet = c.examples(lookup, {
    invalid: {
      given: { type: "query", id: "a" },
      expect: { result: c.caseOf("found"), effects: [invalid] },
    },
  });
  const outcome = await c.test(exampleSet, () => ({ result: { type: "found", count: 1 }, effects: [invalid] }));
  expect(outcome.failures).toMatchObject([{ message: expect.stringContaining("Expected effect is invalid") }]);
});

it("reports invalid actual effects at their index", async () => {
  const outcome = await c.test(rows, () => ({
    result: { type: "found", count: 1 },
    effects: [{ type: "logged" } as c.BehaviorEffect<typeof lookup>],
  }));
  expect(outcome.failures).toMatchObject([{ message: expect.stringContaining("Effect 0 is invalid") }]);
});

it("rejects an expectation that violates a result invariant", async () => {
  const invalid = c.examples(lookup, {
    invalid: {
      given: { type: "query", id: "a" },
      expect: { result: { type: "found", count: -1 }, effects: [] },
    },
  });
  const outcome = await c.test(invalid, () => ({ result: { type: "found", count: -1 }, effects: [] }));
  expect(outcome.failures).toMatchObject([{ message: expect.stringContaining("Expected result is invalid") }]);
});

describe("evaluating one recorded row", () => {
  const exampleSet = c.examples(lookup, {
    first: { given: { type: "query", id: "a" }, expect: { result: { type: "found", count: 1 }, effects: [] } },
    second: { given: { type: "query", id: "b" }, expect: { result: c.caseOf("found"), effects: [] } },
    pending: { given: { type: "query", id: "c" }, expect: c.todo("Ask the owner") },
  });

  it("lets the caller arrange a different world before each row", async () => {
    const seen: string[] = [];
    let count = 1;
    const subject: c.ConformanceSubject<typeof lookup> = input => {
      seen.push(input.id);
      return { result: { type: "found", count }, effects: [] };
    };
    expect(await c.evaluate(exampleSet, "first", subject)).toStrictEqual({
      name: "first", status: "passed", actual: { result: { type: "found", count: 1 }, effects: [] },
    });
    count = 20;
    expect(await c.evaluate(exampleSet, "second", subject)).toStrictEqual({
      name: "second", status: "passed", actual: { result: { type: "found", count: 20 }, effects: [] },
    });
    expect(seen).toStrictEqual(["a", "b"]);
  });

  it("returns a skipped row without executing production code", async () => {
    expect(await c.evaluate(exampleSet, "pending", () => { throw new Error("must not run"); })).toStrictEqual({
      name: "pending", status: "skipped", reason: "Ask the owner",
    });
  });

  it("refuses a misspelled row name", async () => {
    await expect(c.evaluate(exampleSet, "absent", () => { throw new Error("must not run"); })).rejects.toThrow("No example named absent in lookup");
  });

  it("keeps the actual answer beside a comparison failure", async () => {
    expect(await c.evaluate(exampleSet, "first", () => ({ result: { type: "found", count: 2 }, effects: [] }))).toMatchObject({
      name: "first", status: "failed", message: expect.stringContaining("Expected"),
      actual: { result: { type: "found", count: 2 }, effects: [] },
    });
  });

  it.each([null, undefined, {}, { result: { type: "found", count: 1 } }, { result: { type: "found", count: 1 }, effects: null }])(
    "reports a malformed execution without aborting the suite: %j", async value => {
      const outcome = await c.test(rows, () => value as c.Execution<c.BehaviorResult<typeof lookup>, c.BehaviorEffect<typeof lookup>>);
      expect(outcome.failures).toMatchObject([{ name: "found", message: expect.stringContaining("Execution is invalid") }]);
    },
  );

  it("returns a subject exception as a row failure", async () => {
    expect(await c.evaluate(exampleSet, "first", () => { throw new Error("database unavailable"); })).toStrictEqual({
      name: "first", status: "failed", message: "database unavailable",
    });
  });
});
