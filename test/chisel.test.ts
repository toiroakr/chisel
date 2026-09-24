import { describe, expect, it } from "vitest";
import {
  behavior,
  defineSpecification,
  evaluateSpecification,
  example,
  examples,
  generateExamples,
  implement,
  isBehavior,
  isSpecification,
  object,
  pending,
  runImplementation,
  SpecificationError,
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

    expect(generated.map(row => row.given)).toStrictEqual([
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

    expect(report.implementation).toBe("missing");
    expect(report.input.missing).toStrictEqual(["published"]);
    expect(report.unanswered.map(row => row.variant)).toStrictEqual(["published"]);
    expect(report.adequate).toBe(false);
  });

  it("runs an implementation after expectations have been decided", async () => {
    const definition = publishingBehavior();
    const implementation = publishingImplementation(definition);

    const actual = await runImplementation(implementation, {
      state: "draft",
      id: "a",
    });

    expect(actual).toStrictEqual({
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

    expect(report.adequate).toBe(true);
    expect(report.dependencyIssues).toStrictEqual([]);
    expect(failures).toStrictEqual([]);
  });
});

describe("behavior.dependsOn defaults", () => {
  it("defaults dependsOn to an empty array when omitted", () => {
    const definition = behavior({
      name: "no-deps",
      input: Input,
      result: Result,
      effects: Effect,
    });

    expect(definition.dependsOn).toStrictEqual([]);
  });
});

describe("dependency issues", () => {
  it("reports an unknown effect named in the behavior's dependsOn", async () => {
    const definition = behavior({
      name: "publish",
      input: Input,
      result: Result,
      effects: Effect,
      dependsOn: ["mail"],
    });
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

    expect(report.dependencyIssues).toStrictEqual([
      { variant: undefined, reason: "未知の作用'mail'に依存すると宣言されています" },
    ]);
    expect(report.adequate).toBe(false);
  });

  it("reports an unknown effect named in a decision's dependsOn", async () => {
    const definition = publishingBehavior();
    const implementation = implement(definition, {
      cases: {
        draft: {
          kind: "decision",
          id: "publish-draft",
          dependsOn: ["mail"],
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
    const specification = defineSpecification({
      name: "publishing",
      examples: examples(definition, []),
      implementation,
    });

    const report = await evaluateSpecification(specification);

    expect(report.dependencyIssues).toStrictEqual([
      { variant: "draft", reason: "未知の作用'mail'に依存すると宣言されています" },
    ]);
  });

  it("reports an unknown behavior-level dependency even without an implementation", async () => {
    const definition = behavior({
      name: "publish",
      input: Input,
      result: Result,
      effects: Effect,
      dependsOn: ["mail"],
    });
    const specification = defineSpecification({
      name: "publishing",
      examples: examples(definition, []),
    });

    const report = await evaluateSpecification(specification);

    expect(report.dependencyIssues).toStrictEqual([
      { variant: undefined, reason: "未知の作用'mail'に依存すると宣言されています" },
    ]);
  });
});

describe("evaluateSpecification failure reporting", () => {
  it("reports a failure when the implementation disagrees with an example", async () => {
    const definition = publishingBehavior();
    const implementation = publishingImplementation(definition);
    const rows = examples(definition, [
      example(definition, "publish draft", {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "wrong-id" },
          effects: [{ type: "notify", id: "a" }],
        },
      }),
    ]);
    const specification = defineSpecification({
      name: "publishing",
      examples: rows,
      implementation,
    });

    const report = await evaluateSpecification(specification);

    expect(report.failures.map(failure => failure.name)).toStrictEqual(["publish draft"]);
    expect(report.adequate).toBe(false);
  });

  it("reports a pending decision as unimplemented", async () => {
    const definition = publishingBehavior();
    const implementation = implement(definition, {
      cases: {
        draft: {
          kind: "decision",
          id: "publish-draft",
          run: input => ({
            result: { type: "accepted", id: input.id },
            effects: [{ type: "notify", id: input.id }],
          }),
        },
        published: pending("再公開時の挙動が未確定です"),
      },
      controls: {
        notify: {
          execution: "queue",
          idempotency: "required",
          compensation: "none",
        },
      },
    });
    const specification = defineSpecification({
      name: "publishing",
      examples: examples(definition, []),
      implementation,
    });

    const report = await evaluateSpecification(specification);

    expect(report.pendingDecisions).toStrictEqual([
      { variant: "published", reason: "再公開時の挙動が未確定です" },
    ]);
    expect(report.adequate).toBe(false);
  });

  it("reports a control gap when an effect has no control policy", async () => {
    const definition = publishingBehavior();
    const implementation = implement(definition, {
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
      controls: {},
    });
    const specification = defineSpecification({
      name: "publishing",
      examples: examples(definition, []),
      implementation,
    });

    const report = await evaluateSpecification(specification);

    expect(report.controlGaps).toStrictEqual([
      { effect: "notify", reason: "control policy is missing" },
    ]);
  });

  it("reports a control gap when a control policy is pending", async () => {
    const definition = publishingBehavior();
    const implementation = implement(definition, {
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
        notify: pending("制御方針が未確定です"),
      },
    });
    const specification = defineSpecification({
      name: "publishing",
      examples: examples(definition, []),
      implementation,
    });

    const report = await evaluateSpecification(specification);

    expect(report.controlGaps).toStrictEqual([
      { effect: "notify", reason: "制御方針が未確定です" },
    ]);
  });
});

describe("runImplementation error handling", () => {
  it("throws when the selected decision is pending", async () => {
    const definition = publishingBehavior();
    const implementation = implement(definition, {
      cases: {
        draft: {
          kind: "decision",
          id: "publish-draft",
          run: input => ({
            result: { type: "accepted", id: input.id },
            effects: [{ type: "notify", id: input.id }],
          }),
        },
        published: pending("再公開時の挙動が未確定です"),
      },
      controls: {},
    });

    await expect(
      runImplementation(implementation, { state: "published", id: "b" }),
    ).rejects.toThrow(SpecificationError);
  });

  it("throws when a decision returns a result that does not match the schema", async () => {
    const definition = publishingBehavior();
    const implementation = implement(definition, {
      cases: {
        draft: {
          kind: "decision",
          id: "publish-draft",
          run: () => ({
            result: { type: "unknown-type" } as never,
            effects: [],
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
      controls: {},
    });

    await expect(
      runImplementation(implementation, { state: "draft", id: "a" }),
    ).rejects.toThrow(SpecificationError);
  });

  it("throws when a decision returns an effect that does not match the schema", async () => {
    const definition = publishingBehavior();
    const implementation = implement(definition, {
      cases: {
        draft: {
          kind: "decision",
          id: "publish-draft",
          run: input => ({
            result: { type: "accepted", id: input.id },
            effects: [{ type: "unknown-effect" } as never],
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
      controls: {},
    });

    await expect(
      runImplementation(implementation, { state: "draft", id: "a" }),
    ).rejects.toThrow(SpecificationError);
  });
});

describe("generateExamples", () => {
  it("only generates rows for variants not already covered by an example", () => {
    const definition = publishingBehavior();
    const rows = examples(definition, [
      example(definition, "publish draft", {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      }),
    ]);

    const generated = generateExamples(rows);

    expect(generated.map(row => row.given)).toStrictEqual([
      { state: "published", id: "<Id>" },
    ]);
  });

  it("treats an unanswered row as covering its input variant", () => {
    const definition = publishingBehavior();
    const rows = examples(definition, [
      example(definition, "published behavior is unanswered", {
        given: { state: "published", id: "b" },
        expect: unanswered("A human must decide repeated publication"),
      }),
    ]);

    const generated = generateExamples(rows);

    expect(generated.map(row => row.given)).toStrictEqual([
      { state: "draft", id: "<Id>" },
    ]);
  });
});

describe("verifyConformance", () => {
  it("reports a failure when the subject disagrees with an answered example", async () => {
    const definition = publishingBehavior();
    const rows = examples(definition, [
      example(definition, "publish draft", {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      }),
    ]);

    const failures = await verifyConformance(rows, () => ({
      result: { type: "rejected" as const, reason: "already-published" },
      effects: [],
    }));

    expect(failures.map(failure => failure.name)).toStrictEqual(["publish draft"]);
  });

  it("stringifies a thrown non-Error value as the failure message", async () => {
    const definition = publishingBehavior();
    const rows = examples(definition, [
      example(definition, "publish draft", {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      }),
    ]);

    const failures = await verifyConformance(rows, () => {
      throw "boom";
    });

    expect(failures).toStrictEqual([{ name: "publish draft", message: "boom" }]);
  });

  it("skips unanswered rows without calling the subject", async () => {
    const definition = publishingBehavior();
    const rows = examples(definition, [
      example(definition, "published behavior is unanswered", {
        given: { state: "published", id: "b" },
        expect: unanswered("A human must decide repeated publication"),
      }),
    ]);
    let calls = 0;

    const failures = await verifyConformance(rows, input => {
      calls += 1;
      return { result: { type: "accepted" as const, id: input.id }, effects: [] };
    });

    expect(calls).toBe(0);
    expect(failures).toStrictEqual([]);
  });
});

describe("isBehavior", () => {
  it("is true for a value built with behavior()", () => {
    expect(isBehavior(publishingBehavior())).toBe(true);
  });

  it("is false for a value that is not a behavior", () => {
    expect(isBehavior(null)).toBe(false);
    expect(isBehavior({ kind: "not-a-behavior" })).toBe(false);
    expect(isBehavior(publishingImplementation(publishingBehavior()))).toBe(false);
  });
});

describe("isSpecification", () => {
  it("is true for a value built with defineSpecification()", () => {
    const definition = publishingBehavior();
    const specification = defineSpecification({
      name: "publishing",
      examples: examples(definition, []),
    });

    expect(isSpecification(specification)).toBe(true);
  });

  it("is false for a value that is not a specification", () => {
    expect(isSpecification(null)).toBe(false);
    expect(isSpecification(publishingBehavior())).toBe(false);
  });
});

describe("runImplementation invalid input and cases", () => {
  it("throws SpecificationError when the input fails schema validation", async () => {
    const definition = publishingBehavior();
    const implementation = publishingImplementation(definition);

    await expect(
      runImplementation(implementation, { state: "draft", id: 42 } as never),
    ).rejects.toThrow(SpecificationError);
    await expect(
      runImplementation(implementation, { state: "draft", id: 42 } as never),
    ).rejects.toThrow("Invalid input");
  });

  it("throws SpecificationError when no decision is registered for the input's variant", async () => {
    const definition = publishingBehavior();
    const implementation = implement(definition, {
      cases: {
        draft: {
          kind: "decision",
          id: "publish-draft",
          run: (input: { readonly id: string }) => ({
            result: { type: "accepted", id: input.id },
            effects: [{ type: "notify", id: input.id }],
          }),
        },
      } as never,
      controls: {},
    });

    await expect(
      runImplementation(implementation, { state: "published", id: "b" }),
    ).rejects.toThrow(SpecificationError);
    await expect(
      runImplementation(implementation, { state: "published", id: "b" }),
    ).rejects.toThrow("No decision for input variant published");
  });
});

describe("evaluateSpecification example validation", () => {
  it("reports a failure when an example's given value fails schema validation", async () => {
    const definition = publishingBehavior();
    const rows = examples(definition, [
      example(definition, "invalid given", {
        given: { state: "archived", id: "a" } as never,
        expect: { result: { type: "accepted", id: "a" }, effects: [] },
      }),
    ]);
    const specification = defineSpecification({ name: "publishing", examples: rows });

    const report = await evaluateSpecification(specification);

    expect(report.failures).toStrictEqual([
      { name: "invalid given", message: "Example input is invalid" },
    ]);
  });

  it("reports a failure when an example's expected result fails schema validation", async () => {
    const definition = publishingBehavior();
    const rows = examples(definition, [
      example(definition, "invalid expected result", {
        given: { state: "draft", id: "a" },
        expect: { result: { type: "unknown-type" } as never, effects: [] },
      }),
    ]);
    const specification = defineSpecification({ name: "publishing", examples: rows });

    const report = await evaluateSpecification(specification);

    expect(report.failures).toStrictEqual([
      { name: "invalid expected result", message: "Expected result is invalid" },
    ]);
  });

  it("catches an implementation that throws and reports it as a failure", async () => {
    const definition = publishingBehavior();
    const implementation = implement(definition, {
      cases: {
        draft: {
          kind: "decision",
          id: "publish-draft",
          run: () => {
            throw new Error("boom");
          },
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
    const rows = examples(definition, [
      example(definition, "publish draft", {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      }),
    ]);
    const specification = defineSpecification({
      name: "publishing",
      examples: rows,
      implementation,
    });

    const report = await evaluateSpecification(specification);

    expect(report.failures).toStrictEqual([{ name: "publish draft", message: "boom" }]);
  });
});

describe("coverage-driven adequacy vetoes", () => {
  it("treats a non-sum result schema as trivially fully covered", async () => {
    const definition = behavior({
      name: "publish",
      input: Input,
      result: string("Message"),
      effects: Effect,
    });
    const implementation = implement(definition, {
      cases: {
        draft: {
          kind: "decision",
          id: "publish-draft",
          run: () => ({ result: "accepted", effects: [{ type: "notify", id: "a" }] }),
        },
        published: {
          kind: "decision",
          id: "reject-published",
          run: () => ({ result: "already-published", effects: [] }),
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
    const rows = examples(definition, [
      example(definition, "publish draft", {
        given: { state: "draft", id: "a" },
        expect: { result: "accepted", effects: [{ type: "notify", id: "a" }] },
      }),
      example(definition, "reject published", {
        given: { state: "published", id: "b" },
        expect: { result: "already-published", effects: [] },
      }),
    ]);
    const specification = defineSpecification({
      name: "publishing",
      examples: rows,
      implementation,
    });

    const report = await evaluateSpecification(specification);

    expect(report.result).toStrictEqual({ covered: [], missing: [], total: 0 });
    expect(report.adequate).toBe(true);
  });

  it("vetoes adequacy when an example never covers one of the result variants", async () => {
    const definition = publishingBehavior();
    const implementation = implement(definition, {
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
          id: "accept-published-too",
          run: input => ({
            result: { type: "accepted", id: input.id },
            effects: [{ type: "notify", id: input.id }],
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
    const rows = examples(definition, [
      example(definition, "publish draft", {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      }),
      example(definition, "publish published", {
        given: { state: "published", id: "b" },
        expect: {
          result: { type: "accepted", id: "b" },
          effects: [{ type: "notify", id: "b" }],
        },
      }),
    ]);
    const specification = defineSpecification({
      name: "publishing",
      examples: rows,
      implementation,
    });

    const report = await evaluateSpecification(specification);

    expect(report.result).toStrictEqual({
      covered: ["accepted"],
      missing: ["rejected"],
      total: 2,
    });
    expect(report.failures).toStrictEqual([]);
    expect(report.adequate).toBe(false);
  });

  it("vetoes adequacy when an example never covers one of the effect variants", async () => {
    const EffectWithAudit = sum("type", {
      notify: object({ id: string("Id") }),
      audit: object({ id: string("Id") }),
    });
    const definition = behavior({
      name: "publish",
      input: Input,
      result: Result,
      effects: EffectWithAudit,
    });
    const implementation = implement(definition, {
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
        audit: {
          execution: "direct",
          idempotency: "not-required",
          compensation: "none",
        },
      },
    });
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

    expect(report.effects).toStrictEqual({
      covered: ["notify"],
      missing: ["audit"],
      total: 2,
    });
    expect(report.controlGaps).toStrictEqual([]);
    expect(report.adequate).toBe(false);
  });
});
