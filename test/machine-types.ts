import * as c from "../src/runtime.js";

const State = c.int().min(0).max(2);
const Command = c.boolean();

c.machine("typed", {
  state: State, command: Command, initial: [0],
  update: (state, command, machine) => ({
    state: machine.choose(command.$eq(true), state.$plus(1), state),
  }),
});

c.machine("unsupported construction", {
  state: State, command: Command, initial: [0],
  // @ts-expect-error General model expressions cannot be used in a machine transition.
  update: state => ({ state: c.construct(State, state) }),
});

c.machine("unsupported arithmetic", {
  state: State, command: Command, initial: [0],
  // @ts-expect-error Runtime-only arithmetic expressions cannot be used in a machine transition.
  update: state => ({ state: c.arithmetic("multiply", state, 2) }),
});

c.machine("unsupported measured term", {
  state: c.string(), command: Command, initial: [""],
  update: state => ({
    // @ts-expect-error Machine terms do not expose operations absent from TLA+ transitions.
    state: state.$trim(),
  }),
});

// @ts-expect-error Optional state has no exact machine/TLA+ representation.
c.machine("unsupported schema", {
  state: c.string().optional(), command: Command, initial: [""],
  update: state => ({ state }),
});

// @ts-expect-error Nested schemas are checked at the machine boundary too.
c.machine("unsupported nested schema", {
  state: c.array(c.decimal(2)), command: Command, initial: [[]],
  update: state => ({ state }),
});

c.machine("null", {
  state: c.literal(null), command: Command, initial: [null],
  update: state => ({ state }),
});

// @ts-expect-error Fractional numeric literals are not yet supported by the TLA+ compiler.
c.machine("fractional literal", { state: c.literal(0.5), command: Command, initial: [0.5], update: state => ({ state }) });
