import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const State = c.int().min(0).max(2);
const Command = c.enum(["go", "finish"] as const);

function example(invariant = c.invariant<number>("at most two", state => state.$lte(2))) {
  return c.machine("two steps", {
    state: State,
    command: Command,
    initial: [0],
    invariants: [invariant],
    update: (state, command) => ({
      state: c.choose(state.$lt(2), state.$plus(1), state),
      commands: c.choose(command.$eq("go"), ["finish" as const], [] as const),
    }),
  });
}

describe("executable state machine", () => {
  it("executes emitted commands through the same reducer", () => {
    const result = c.runMachine(example(), 0, "go");
    expect(result.state).toBe(2);
    expect(result.steps.map(step => [step.command, step.before, step.after])).toEqual([
      ["go", 0, 1], ["finish", 1, 2],
    ]);
  });

  it("checks every reachable state and both commands", () => {
    expect(c.checkMachine(example())).toEqual({ status: "held", states: 3, transitions: 6 });
  });

  it("returns the shortest command sequence to a broken invariant", () => {
    const declaration = example(c.invariant<number>("at most one", state => state.$lte(1)));
    expect(c.checkMachine(declaration)).toMatchObject({
      status: "broken", counterexample: { start: 0, commands: ["go"], reason: "Invariant at most one failed" },
    });
    expect(() => c.runMachine(declaration, 0, "go")).toThrow("Invariant at most one failed");
  });

  it("checks properties of each individual transition", () => {
    const declaration = c.machine("counter", {
      state: State, command: c.enum(["up", "down"] as const), initial: [1],
      transitions: [c.transition<number>("never decreases", (before, after) => after.$gte(before))],
      update: (state, command) => ({ state: c.choose(command.$eq("up"), state.$plus(1), state.$minus(1)) }),
    });
    expect(c.checkMachine(declaration)).toMatchObject({
      status: "broken", counterexample: { start: 1, commands: ["down"], steps: [{ before: 1, after: 0 }] },
    });
  });

  it("reports bounds and open command domains as undetermined", () => {
    expect(c.checkMachine(example(), { maxStates: 2 })).toMatchObject({ status: "undetermined", states: 2 });
    const open = c.machine("open", {
      state: State, command: c.string(), initial: [0],
      update: state => ({ state }),
    });
    expect(c.checkMachine(open)).toMatchObject({ status: "undetermined" });
  });

  it("validates commands, resulting states, and emitted command loops", () => {
    expect(() => c.runMachine(example(), 0, "unknown" as never)).toThrow("Command:");
    const looping = c.machine("loop", {
      state: State, command: Command, initial: [0],
      update: (state, command) => ({ state, commands: [command] }),
    });
    expect(() => c.runMachine(looping, 0, "go", { maxCommands: 2 })).toThrow("exceeded 2 commands");
    expect(c.checkMachine(looping, { maxCommands: 2 })).toMatchObject({ status: "undetermined" });
  });
});
