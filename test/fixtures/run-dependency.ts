import * as c from "../../src/index.js";

const lookup = c.behavior("lookup", {
  input: c.variants("type", { query: c.object({}) }),
  result: c.int(),
  effects: c.variants("type", {}),
  requires: { stock: c.dependency(c.int()) },
});

export const implementation = c.implement(lookup, {
  cases: { query: c.action("stock", { run: (_, deps) => ({ result: deps.stock, effects: [] }) }) },
});
