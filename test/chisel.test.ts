import { describe, expect, it } from "vitest";
import {
  generate,
  action,
  todo,
  behavior,
  spec,
  check,
  example,
  examples,
  implement,
  isBehavior,
  isSpecification,
  object,
  perform,
  SpecificationError,
  string,
  variants,
  test,
} from "../src/index.js";

const Input = variants("state", {
  draft: object({ id: string("Id") }),
  published: object({ id: string("Id") }),
});

const Result = variants("type", {
  accepted: object({ id: string("Id") }),
  rejected: object({ reason: string("Reason") }),
});

const Effect = variants("type", {
  notify: object({ id: string("Id") }),
});

function publishingBehavior() {
  return behavior("publish", {
    input: Input,
    result: Result,
    effects: Effect,
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

    const generated = generate(definition).rows;

    expect(generated.map(row => row.given)).toStrictEqual([
      { state: "draft", id: "<Id>" },
      { state: "published", id: "<Id>" },
    ]);
  });

  it("keeps human answers separate from the implementation", async () => {
    const definition = publishingBehavior();
    const rows = examples(definition, {
      "publish draft": {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      },
      "published behavior is unanswered": {
        given: { state: "published", id: "b" },
        expect: todo("A human must decide repeated publication"),
      },
    });
    const specification = spec("publishing", { examples: rows });

    const report = await check(specification);

    expect(report.implementation).toBe("missing");
    expect(report.input.missing).toStrictEqual(["published"]);
    expect(report.unanswered.map(row => row.variant)).toStrictEqual(["published"]);
    expect(report.adequate).toBe(false);
  });

  it("runs an implementation after expectations have been decided", async () => {
    const definition = publishingBehavior();
    const implementation = publishingImplementation(definition);

    const actual = await perform(implementation, {
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
    const rows = examples(definition, {
      "publish draft": {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      },
      "reject published": {
        given: { state: "published", id: "b" },
        expect: {
          result: { type: "rejected", reason: "already-published" },
          effects: [],
        },
      },
    });
    const specification = spec("publishing", {
      examples: rows,
      implementation,
    });

    const report = await check(specification);
    const { failures } = await test(rows, input =>
      perform(implementation, input),
    );

    expect(report.adequate).toBe(true);
    expect(failures).toStrictEqual([]);
  });
});

describe("effects as the only vocabulary of side effects", () => {
  it("does not accept a dependsOn list on a behavior", () => {
    behavior("publish", {
      input: Input,
      result: Result,
      effects: Effect,
      // @ts-expect-error effects already name every effect a behavior may emit
      dependsOn: ["notify"],
    });
  });

  it("does not accept a dependsOn list on an action", () => {
    action("publish-draft", {
      // @ts-expect-error effects already name every effect a behavior may emit
      dependsOn: ["notify"],
      run: () => ({ result: { type: "rejected", reason: "never" }, effects: [] }),
    });
  });

  it("leaves dependency issues out of the report", async () => {
    const definition = publishingBehavior();
    const report = await check(
      spec("publishing", {
        examples: examples(definition, {}),
        implementation: publishingImplementation(definition),
      }),
    );

    expect("dependencyIssues" in report).toBe(false);
  });
});

describe("check failure reporting", () => {
  it("reports a failure when the implementation disagrees with an example", async () => {
    const definition = publishingBehavior();
    const implementation = publishingImplementation(definition);
    const rows = examples(definition, {
      "publish draft": {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "wrong-id" },
          effects: [{ type: "notify", id: "a" }],
        },
      },
    });
    const specification = spec("publishing", {
      examples: rows,
      implementation,
    });

    const report = await check(specification);

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
        published: todo("再公開時の挙動が未確定です"),
      },
      controls: {
        notify: {
          execution: "queue",
          idempotency: "required",
          compensation: "none",
        },
      },
    });
    const specification = spec("publishing", {
      examples: examples(definition, {}),
      implementation,
    });

    const report = await check(specification);

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
    const specification = spec("publishing", {
      examples: examples(definition, {}),
      implementation,
    });

    const report = await check(specification);

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
        notify: todo("制御方針が未確定です"),
      },
    });
    const specification = spec("publishing", {
      examples: examples(definition, {}),
      implementation,
    });

    const report = await check(specification);

    expect(report.controlGaps).toStrictEqual([
      { effect: "notify", reason: "制御方針が未確定です" },
    ]);
  });
});

describe("perform error handling", () => {
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
        published: todo("再公開時の挙動が未確定です"),
      },
      controls: {},
    });

    await expect(
      perform(implementation, { state: "published", id: "b" }),
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
      perform(implementation, { state: "draft", id: "a" }),
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
      perform(implementation, { state: "draft", id: "a" }),
    ).rejects.toThrow(SpecificationError);
  });
});

describe("generateExamples", () => {
  it("only generates rows for variants not already covered by an example", () => {
    const definition = publishingBehavior();
    const rows = examples(definition, {
      "publish draft": {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      },
    });

    const generated = generate(rows).rows;

    expect(generated.map(row => row.given)).toStrictEqual([
      { state: "published", id: "<Id>" },
    ]);
  });

  it("treats an unanswered row as covering its input variant", () => {
    const definition = publishingBehavior();
    const rows = examples(definition, {
      "published behavior is unanswered": {
        given: { state: "published", id: "b" },
        expect: todo("A human must decide repeated publication"),
      },
    });

    const generated = generate(rows).rows;

    expect(generated.map(row => row.given)).toStrictEqual([
      { state: "draft", id: "<Id>" },
    ]);
  });
});

describe("test", () => {
  it("reports a failure when the subject disagrees with an answered example", async () => {
    const definition = publishingBehavior();
    const rows = examples(definition, {
      "publish draft": {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      },
    });

    const { failures } = await test(rows, () => ({
      result: { type: "rejected" as const, reason: "already-published" },
      effects: [],
    }));

    expect(failures.map(failure => failure.name)).toStrictEqual(["publish draft"]);
  });

  it("stringifies a thrown non-Error value as the failure message", async () => {
    const definition = publishingBehavior();
    const rows = examples(definition, {
      "publish draft": {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      },
    });

    const { failures } = await test(rows, () => {
      throw "boom";
    });

    expect(failures).toStrictEqual([{ name: "publish draft", message: "boom" }]);
  });

  it("skips a row whose answer is still todo without calling the subject, and says so", async () => {
    const definition = publishingBehavior();
    const rows = examples(definition, {
      "published behavior is unanswered": {
        given: { state: "published", id: "b" },
        expect: todo("A human must decide repeated publication"),
      },
    });
    let calls = 0;

    const failures = await test(rows, input => {
      calls += 1;
      return { result: { type: "accepted" as const, id: input.id }, effects: [] };
    });

    expect({ calls, outcome: failures }).toStrictEqual({
      calls: 0,
      outcome: {
        failures: [],
        skipped: [
          { name: "published behavior is unanswered", reason: "A human must decide repeated publication" },
        ],
      },
    });
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
  it("is true for a value built with spec()", () => {
    const definition = publishingBehavior();
    const specification = spec("publishing", {
      examples: examples(definition, {}),
    });

    expect(isSpecification(specification)).toBe(true);
  });

  it("is false for a value that is not a specification", () => {
    expect(isSpecification(null)).toBe(false);
    expect(isSpecification(publishingBehavior())).toBe(false);
  });
});

describe("perform invalid input and cases", () => {
  it("throws SpecificationError when the input fails schema validation", async () => {
    const definition = publishingBehavior();
    const implementation = publishingImplementation(definition);

    await expect(
      perform(implementation, { state: "draft", id: 42 } as never),
    ).rejects.toThrow(SpecificationError);
    await expect(
      perform(implementation, { state: "draft", id: 42 } as never),
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
      perform(implementation, { state: "published", id: "b" }),
    ).rejects.toThrow(SpecificationError);
    await expect(
      perform(implementation, { state: "published", id: "b" }),
    ).rejects.toThrow("No decision for input variant published");
  });
});

describe("undeclared keys", () => {
  it("fails a row whose model answers with a key the result does not declare", async () => {
    const definition = publishingBehavior();
    const implementation = implement(definition, {
      cases: {
        draft: action("leak the input", {
          run: input => {
            const answer = { ...input, secret: "leak" };
            return { result: { type: "accepted", ...answer }, effects: [] };
          },
        }),
        published: action("reject", {
          run: () => ({ result: { type: "rejected", reason: "already-published" }, effects: [] }),
        }),
      },
      controls: { notify: { execution: "queue", idempotency: "required", compensation: "none" } },
    });
    const rows = examples(definition, {
      "publish a draft": {
        given: { state: "draft", id: "a" },
        expect: { result: { type: "accepted", id: "a" }, effects: [] },
      },
    });

    const report = await check(spec("publishing", { examples: rows, implementation }));

    expect(report.failures).toStrictEqual([
      {
        name: "publish a draft",
        message: "Invalid result: $.state: Unexpected key; $.secret: Unexpected key",
      },
    ]);
  });

  it("fails a row whose given carries a key the input does not declare", async () => {
    const definition = publishingBehavior();
    const rows = examples(definition, {
      "draft with a stray key": {
        given: { state: "draft", id: "a", secret: "leak" } as never,
        expect: { result: { type: "accepted", id: "a" }, effects: [] },
      },
    });

    const report = await check(spec("publishing", { examples: rows }));

    expect(report.failures).toStrictEqual([
      { name: "draft with a stray key", message: "Example input is invalid" },
    ]);
  });
});

describe("check example validation", () => {
  it("reports a failure when an example's given value fails schema validation", async () => {
    const definition = publishingBehavior();
    const rows = examples(definition, {
      "invalid given": {
        given: { state: "archived", id: "a" } as never,
        expect: { result: { type: "accepted", id: "a" }, effects: [] },
      },
    });
    const specification = spec("publishing", { examples: rows });

    const report = await check(specification);

    expect(report.failures).toStrictEqual([
      { name: "invalid given", message: "Example input is invalid" },
    ]);
  });

  it("reports a failure when an example's expected result fails schema validation", async () => {
    const definition = publishingBehavior();
    const rows = examples(definition, {
      "invalid expected result": {
        given: { state: "draft", id: "a" },
        expect: { result: { type: "unknown-type" } as never, effects: [] },
      },
    });
    const specification = spec("publishing", { examples: rows });

    const report = await check(specification);

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
    const rows = examples(definition, {
      "publish draft": {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      },
    });
    const specification = spec("publishing", {
      examples: rows,
      implementation,
    });

    const report = await check(specification);

    expect(report.failures).toStrictEqual([{ name: "publish draft", message: "boom" }]);
  });
});

describe("coverage-driven adequacy vetoes", () => {
  it("treats a non-sum result schema as trivially fully covered", async () => {
    const definition = behavior("publish", {
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
    const rows = examples(definition, {
      "publish draft": {
        given: { state: "draft", id: "a" },
        expect: { result: "accepted", effects: [{ type: "notify", id: "a" }] },
      },
      "reject published": {
        given: { state: "published", id: "b" },
        expect: { result: "already-published", effects: [] },
      },
    });
    const specification = spec("publishing", {
      examples: rows,
      implementation,
    });

    const report = await check(specification);

    expect(report.result).toStrictEqual({ covered: [], missing: [], excluded: [], total: 0 });
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
    const rows = examples(definition, {
      "publish draft": {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      },
      "publish published": {
        given: { state: "published", id: "b" },
        expect: {
          result: { type: "accepted", id: "b" },
          effects: [{ type: "notify", id: "b" }],
        },
      },
    });
    const specification = spec("publishing", {
      examples: rows,
      implementation,
    });

    const report = await check(specification);

    expect(report.result).toStrictEqual({
      covered: ["accepted"],
      missing: ["rejected"],
      excluded: [],
      total: 2,
    });
    expect(report.failures).toStrictEqual([]);
    expect(report.adequate).toBe(false);
  });

  it("vetoes adequacy when an example never covers one of the effect variants", async () => {
    const EffectWithAudit = variants("type", {
      notify: object({ id: string("Id") }),
      audit: object({ id: string("Id") }),
    });
    const definition = behavior("publish", {
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
    const rows = examples(definition, {
      "publish draft": {
        given: { state: "draft", id: "a" },
        expect: {
          result: { type: "accepted", id: "a" },
          effects: [{ type: "notify", id: "a" }],
        },
      },
      "reject published": {
        given: { state: "published", id: "b" },
        expect: {
          result: { type: "rejected", reason: "already-published" },
          effects: [],
        },
      },
    });
    const specification = spec("publishing", {
      examples: rows,
      implementation,
    });

    const report = await check(specification);

    expect(report.effects).toStrictEqual({
      covered: ["notify"],
      missing: ["audit"],
      excluded: [],
      total: 2,
    });
    expect(report.controlGaps).toStrictEqual([]);
    expect(report.adequate).toBe(false);
  });
});

describe("todo", () => {
  const 受け付ける = behavior("受け付ける", {
    input: variants("状態", { 入力済み: object({}), 取消済み: object({}) }),
    result: variants("結果", { 受付: object({}) }),
    effects: variants("種類", { 通知: object({}) }),
  });

  it("marks an owed answer, an unwritten case and an undecided control alike", async () => {
    const report = await check(
      spec("受付", {
        examples: examples(受け付ける, {
          入力済み: { given: { 状態: "入力済み" }, expect: todo("答えは未定") },
        }),
        implementation: implement(受け付ける, {
          cases: {
            入力済み: action("受け付ける", { run: () => ({ result: { 結果: "受付" }, effects: [] }) }),
            取消済み: todo("取消の扱いは未定"),
          },
          controls: { 通知: todo("通知の方式は未定") },
        }),
      }),
    );

    expect({
      unanswered: report.unanswered.map(row => row.reason),
      pending: report.pendingDecisions.map(item => item.reason),
      controls: report.controlGaps.map(gap => gap.reason),
    }).toStrictEqual({
      unanswered: ["答えは未定"],
      pending: ["取消の扱いは未定"],
      controls: ["通知の方式は未定"],
    });
  });
});

describe("a row that reaches a decision still todo", () => {
  it("is not a failure but a row that could not run, beside the open decision", async () => {
    const definition = publishingBehavior();
    const report = await check(
      spec("publishing", {
        examples: examples(definition, {
          "publish draft": {
            given: { state: "draft", id: "a" },
            expect: {
              result: { type: "accepted", id: "a" },
              effects: [{ type: "notify", id: "a" }],
            },
          },
        }),
        implementation: implement(definition, {
          cases: { draft: todo("not decided"), published: todo("not decided either") },
        }),
      }),
    );

    expect({ failures: report.failures, incompleteness: report.incompleteness }).toStrictEqual({
      failures: [],
      incompleteness: [{ kind: "row not run", subject: "publish draft", reason: "判断が未定（draft）" }],
    });
  });
});
