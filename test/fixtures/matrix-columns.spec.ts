import * as c from "../../src/index.js";

const State = c.object({ count: c.int64().min(0n).max(1n), label: c.enum(['a"b', "c"] as const) });
const declaration = c.machine("matrix columns", {
  state: State, command: c.enum(["noop"] as const), initial: [{ count: 0n, label: 'a"b' }],
  update: state => ({ state }),
});

export const specification = c.specifyMachine(declaration, { columns: ["count", "label"] });
