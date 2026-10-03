import * as c from "../src/index.js";

export const countFlags = c.behavior("count-flags", {
  input: c.variants("kind", { request: c.object({ first: c.boolean(), second: c.boolean() }) }),
  result: c.int().min(0).max(2),
  effects: c.variants("kind", {}),
});
export const implementation = c.implement(countFlags, {
  cases: {
    request: c.model("count", input => ({
      result: c.arithmetic("add", c.choose(input.first.$eq(true), 1, 0), c.choose(input.second.$eq(true), 1, 0)),
      effects: [],
    })),
  },
});
export const specification = c.spec("count flags", {
  implementation,
  examples: c.examples(countFlags, {
    neither: { given: { kind: "request", first: false, second: false }, expect: { result: 0, effects: [] } },
    first: { given: { kind: "request", first: true, second: false }, expect: { result: 1, effects: [] } },
    second: { given: { kind: "request", first: false, second: true }, expect: { result: 1, effects: [] } },
    both: { given: { kind: "request", first: true, second: true }, expect: { result: 2, effects: [] } },
  }),
});
