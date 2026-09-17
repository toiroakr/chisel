import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  behavior,
  defineSpecification,
  evaluateSpecification,
  example,
  examples,
  generateTodos,
  object,
  pending,
  runBehavior,
  string,
  sum,
  verifyConformance,
} from "../src/index.js";

const Input = sum("state", {
  draft: object({ id: string("Id") }),
  published: object({ id: string("Id") }),
});

const Result = sum("type", {
  accepted: object({ id: string("Id") }),
  rejected: object({ reason: string("Reason") }),
});

const Effect = sum("type", {
  notify: object({ id: string("Id") }),
});

function completeBehavior() {
  return behavior({
    name: "publish",
    input: Input,
    result: Result,
    effects: Effect,
    cases: {
      draft: {
        kind: "decision",
        id: "publish-draft",
        run: input => ({
          result: { type: "accepted", id: input.id },
          effects: [{ type: "notify", id: input.id }],
        }),
      },
      published: {
        kind: "decision",
        id: "reject-published",
        run: () => ({
          result: { type: "rejected", reason: "already-published" },
          effects: [],
        }),
      },
    },
    controls: {
      notify: {
        execution: "queue",
        idempotency: "required",
        compensation: "none",
      },
    },
  });
}

describe("chisel", () => {
  it("runs a decision and validates its trace", async () => {
    const definition = completeBehavior();
    const actual = await runBehavior(definition, { state: "draft", id: "a" });

    assert.deepEqual(actual, {
      result: { type: "accepted", id: "a" },
      effects: [{ type: "notify", id: "a" }],
    });
  });

  it("reports a complete specification", async () => {
    const definition = completeBehavior();
    const rows = examples(definition, [
      example<typeof definition>("publish draft", {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      }),
      example<typeof definition>("reject published", {
        given: { state: "published", id: "b" },
        expect: {
          result: { type: "rejected", reason: "already-published" },
          effects: [],
        },
      }),
    ]);
    const specification = defineSpecification({ name: "publishing", examples: rows });

    const report = await evaluateSpecification(specification);

    assert.equal(report.adequate, true);
    assert.deepEqual(report.input.missing, []);
    assert.deepEqual(report.result.missing, []);
    assert.deepEqual(report.effects.missing, []);
  });

  it("finds pending decisions and generates missing examples", async () => {
    const definition = behavior({
      name: "publish",
      input: Input,
      result: Result,
      effects: Effect,
      cases: {
        draft: {
          kind: "decision",
          id: "publish-draft",
          run: input => ({
            result: { type: "accepted", id: input.id },
            effects: [{ type: "notify", id: input.id }],
          }),
        },
        published: pending("Repeat publication policy is undecided"),
      },
      controls: { notify: pending("Delivery guarantee is undecided") },
    });
    const rows = examples(definition, [
      example<typeof definition>("publish draft", {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      }),
    ]);
    const specification = defineSpecification({ name: "publishing", examples: rows });

    const report = await evaluateSpecification(specification);
    const generated = generateTodos(specification);

    assert.equal(report.adequate, false);
    assert.deepEqual(report.input.missing, ["published"]);
    assert.deepEqual(report.pendingDecisions, [
      {
        variant: "published",
        reason: "Repeat publication policy is undecided",
      },
    ]);
    assert.deepEqual(generated, [
      {
        name: "publish: published",
        given: { state: "published", id: "<Id>" },
        reason: "Expected result for published must be decided by a human",
      },
    ]);
  });

  it("compares an implementation with the examples", async () => {
    const definition = completeBehavior();
    const rows = examples(definition, [
      example<typeof definition>("publish draft", {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      }),
    ]);

    const failures = await verifyConformance(rows, async input =>
      runBehavior(definition, input),
    );

    assert.deepEqual(failures, []);
  });
});
