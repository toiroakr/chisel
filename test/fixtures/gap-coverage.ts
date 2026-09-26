import {
  todo,
  behavior,
  spec,
  example,
  examples,
  implement,
  object,
  string,
  variants,
} from "../../src/index.js";

const Input = variants("state", {
  ready: object({ id: string() }),
  archived: object({ id: string() }),
});
const Result = variants("type", {
  ok: object({ id: string() }),
});
const Effect = variants("type", {
  none: object({}),
});

export const unreferencedBehavior = behavior("unreferenced", {
  input: Input,
  result: Result,
  effects: Effect,
});

function inlineBehavior() {
  return behavior("inline check", {
    input: Input,
    result: Result,
    effects: Effect,
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

export const inlineSpec = spec("inline check", {
  examples: examples(definition, {
    "ready": {
      given: { state: "ready", id: "a" },
      expect: todo("undecided"),
    },
    "archived": {
      given: { state: "archived", id: "b" },
      expect: { result: { type: "ok", id: "b" }, effects: [] },
    },
  }),
  implementation,
});
