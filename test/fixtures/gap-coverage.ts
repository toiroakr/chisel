import {
  behavior,
  defineSpecification,
  example,
  examples,
  implement,
  object,
  string,
  sum,
  unanswered,
} from "../../src/index.js";

const Input = sum("state", {
  ready: object({ id: string("Id") }),
  archived: object({ id: string("Id") }),
});
const Result = sum("type", {
  ok: object({ id: string("Id") }),
});
const Effect = sum("type", {
  none: object({}),
});

export const unreferencedBehavior = behavior({
  name: "unreferenced",
  input: Input,
  result: Result,
  effects: Effect,
});

function inlineBehavior() {
  return behavior({
    name: "inline check",
    input: Input,
    result: Result,
    effects: Effect,
    dependsOn: ["mail"],
  });
}

const definition = inlineBehavior();

const implementation = implement(definition, {
  cases: {
    ready: {
      kind: "decision",
      id: "ready",
      run: input => ({ result: { type: "ok", id: input.id }, effects: [] }),
    },
    archived: {
      kind: "decision",
      id: "archived",
      run: () => ({ result: { type: "ok", id: "mismatched" }, effects: [] }),
    },
  },
  controls: {
    none: { execution: "direct", idempotency: "not-required", compensation: "none" },
  },
});

export const inlineSpec = defineSpecification({
  name: "inline check",
  examples: examples(definition, [
    example(definition, "ready", {
      given: { state: "ready", id: "a" },
      expect: unanswered("undecided"),
    }),
    example(definition, "archived", {
      given: { state: "archived", id: "b" },
      expect: { result: { type: "ok", id: "b" }, effects: [] },
    }),
  ]),
  implementation,
});
