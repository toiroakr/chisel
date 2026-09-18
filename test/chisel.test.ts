import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  behavior,
  defineSpecification,
  evaluateSpecification,
  example,
  examples,
  generateExamples,
  implement,
  object,
  runImplementation,
  string,
  sum,
  unanswered,
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

function publishingBehavior() {
  return behavior({
    name: "publish",
    input: Input,
    result: Result,
    effects: Effect,
    dependsOn: ["notify"],
  });
}

function publishingImplementation(definition: ReturnType<typeof publishingBehavior>) {
  return implement(definition, {
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
  it("generates unanswered examples from a behavior declaration", () => {
    const definition = publishingBehavior();

    const generated = generateExamples(definition);

    assert.deepEqual(generated.map(row => row.given), [
      { state: "draft", id: "<Id>" },
      { state: "published", id: "<Id>" },
    ]);
  });

  it("keeps human answers separate from the implementation", async () => {
    const definition = publishingBehavior();
    const rows = examples(definition, [
      example(definition, "publish draft", {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      }),
      example(definition, "published behavior is unanswered", {
        given: { state: "published", id: "b" },
        expect: unanswered("A human must decide repeated publication"),
      }),
    ]);
    const specification = defineSpecification({ name: "publishing", examples: rows });

    const report = await evaluateSpecification(specification);

    assert.equal(report.implementation, "missing");
    assert.deepEqual(report.input.missing, ["published"]);
    assert.deepEqual(report.unanswered.map(row => row.variant), ["published"]);
    assert.equal(report.adequate, false);
  });

  it("runs an implementation after expectations have been decided", async () => {
    const definition = publishingBehavior();
    const implementation = publishingImplementation(definition);

    const actual = await runImplementation(implementation, {
      state: "draft",
      id: "a",
    });

    assert.deepEqual(actual, {
      result: { type: "accepted", id: "a" },
      effects: [{ type: "notify", id: "a" }],
    });
  });

  it("accepts a model that satisfies all human-approved examples", async () => {
    const definition = publishingBehavior();
    const implementation = publishingImplementation(definition);
    const rows = examples(definition, [
      example(definition, "publish draft", {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      }),
      example(definition, "reject published", {
        given: { state: "published", id: "b" },
        expect: {
          result: { type: "rejected", reason: "already-published" },
          effects: [],
        },
      }),
    ]);
    const specification = defineSpecification({
      name: "publishing",
      examples: rows,
      implementation,
    });

    const report = await evaluateSpecification(specification);
    const failures = await verifyConformance(rows, input =>
      runImplementation(implementation, input),
    );

    assert.equal(report.adequate, true);
    assert.deepEqual(failures, []);
  });
});
