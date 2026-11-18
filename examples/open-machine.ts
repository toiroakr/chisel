import * as c from "../src/runtime.js";

// The command and state schemas are open. Model checking cannot enumerate
// every command, while the inductive proof can establish this invariant.
export const openMachine = c.machine("open counter", {
  state: c.int(), command: c.int(), initial: [0],
  update: state => ({ state }),
});
