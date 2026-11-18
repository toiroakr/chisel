import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { orderMachine } from "../examples/order-machine.js";
import { orderSpecification } from "../examples/order-machine.spec.js";

const State = c.int().min(0).max(2);
const Command = c.enum(["go", "finish"] as const);

function example(invariant = c.invariant<number>("at most two", state => state.$lte(2))) {
  const declaration = c.machine("two steps", {
    state: State,
    command: Command,
    initial: [0],
    update: (state, command) => ({
      state: c.choose(state.$lt(2), state.$plus(1), state),
      commands: c.choose(command.$eq("go"), ["finish" as const], [] as const),
    }),
  });
  return c.specifyMachine(declaration, { invariants: [invariant] });
}

describe("executable state machine", () => {
  it("rejects verification properties embedded in the runtime declaration", () => {
    expect(() => c.machine("wrong", { state: State, command: Command, initial: [0],
      update: state => ({ state }), invariants: [] } as never)).toThrow("separate specifyMachine");
  });
  it("runs a business workflow and checks every reachable state", () => {
    const issued = c.runMachine(orderMachine, orderMachine.initial[0]!, { type: "submit" });
    expect(issued.state).toStrictEqual({ phase: "issued", ordered: 2, received: 0 });
    expect(issued.steps.map(step => step.command)).toStrictEqual([{ type: "submit" }, { type: "allocate" }]);
    expect(c.runMachine(orderMachine, issued.state, { type: "receive", units: 2 }).state).toStrictEqual({
      phase: "issued", ordered: 2, received: 2,
    });
    expect(c.checkMachine(orderSpecification)).toMatchObject({ status: "held" });
  });
  it("executes emitted commands through the same reducer", () => {
    const result = c.runMachine(example().machine, 0, "go");
    expect(result.state).toBe(2);
    expect(result.steps.map(step => [step.command, step.before, step.after])).toEqual([
      ["go", 0, 1], ["finish", 1, 2],
    ]);
  });

  it("can define distinct commands with exhaustive variant matching", () => {
    const Phase = c.enum(["draft", "approved", "issued"] as const);
    const Order = c.object({ phase: Phase, quantity: c.int().min(1).max(2) });
    const Action = c.variants("type", { approve: c.object({}), issue: c.object({}) });
    const workflow = c.machine("order", {
      state: Order, command: Action, initial: [{ phase: "draft", quantity: 1 }],
      update: (state, command) => c.matchValue(Action, command, {
        approve: () => ({
          state: { phase: c.choose<c.Infer<typeof Phase>>(state.phase.$eq("draft"), "approved", state.phase), quantity: state.quantity },
          commands: [{ type: "issue" as const }],
        }),
        issue: () => ({
          state: { phase: c.choose<c.Infer<typeof Phase>>(state.phase.$eq("approved"), "issued", state.phase), quantity: state.quantity },
          commands: [],
        }),
      }),
    });
    expect(c.runMachine(workflow, { phase: "draft", quantity: 1 }, { type: "approve" })).toMatchObject({
      state: { phase: "issued", quantity: 1 },
      steps: [{ command: { type: "approve" } }, { command: { type: "issue" } }],
    });
    expect(c.checkMachine(c.specifyMachine(workflow, { transitions: [c.transition<c.Infer<typeof Order>>("issued stays issued", (before, after) =>
      before.phase.$ne("issued").$or(after.phase.$eq("issued")))] }))).toMatchObject({ status: "held", states: 2, transitions: 4 });
  });

  it("checks every reachable state and both commands", () => {
    expect(c.checkMachine(example())).toEqual({ status: "held", states: 3, transitions: 6 });
  });

  it("returns the shortest command sequence to a broken invariant", () => {
    const declaration = example(c.invariant<number>("at most one", state => state.$lte(1)));
    expect(c.checkMachine(declaration)).toMatchObject({
      status: "broken", counterexample: { start: 0, commands: ["go"], reason: "Invariant at most one failed" },
    });
    expect(c.runMachine(declaration.machine, 0, "go").state).toBe(2);
  });

  it("checks properties of each individual transition", () => {
    const declaration = c.machine("counter", {
      state: State, command: c.enum(["up", "down"] as const), initial: [1],
      update: (state, command) => ({ state: c.choose(command.$eq("up"), state.$plus(1), state.$minus(1)) }),
    });
    expect(c.checkMachine(c.specifyMachine(declaration, { transitions: [c.transition<number>("never decreases", (before, after) => after.$gte(before))] }))).toMatchObject({
      status: "broken", counterexample: { start: 1, commands: ["down"], steps: [{ before: 1, after: 0 }] },
    });
  });

  it("reports bounds and open command domains as undetermined", () => {
    expect(c.checkMachine(example(), { maxStates: 2 })).toMatchObject({ status: "undetermined", states: 2 });
    const open = c.machine("open", {
      state: State, command: c.string(), initial: [0],
      update: state => ({ state }),
    });
    expect(c.checkMachine(c.specifyMachine(open))).toMatchObject({ status: "undetermined" });
  });

  it("validates commands, resulting states, and emitted command loops", () => {
    expect(() => c.runMachine(example().machine, 0, "unknown" as never)).toThrow("Command:");
    const looping = c.machine("loop", {
      state: State, command: Command, initial: [0],
      update: (state, command) => ({ state, commands: [command] }),
    });
    expect(() => c.runMachine(looping, 0, "go", { maxCommands: 2 })).toThrow("exceeded 2 commands");
    expect(c.checkMachine(c.specifyMachine(looping), { maxCommands: 2 })).toMatchObject({ status: "undetermined" });
  });

  it("keeps checking other commands when one exceeds the execution budget", () => {
    const Action = c.enum(["loop", "break"] as const);
    const declaration = c.machine("budget", {
      state: State, command: Action, initial: [0],
      update: (_state, command) => ({
        state: c.choose(command.$eq("break"), 1, 0),
        commands: c.choose(command.$eq("loop"), ["loop" as const], [] as const),
      }),
    });
    expect(c.checkMachine(c.specifyMachine(declaration, { invariants: [c.invariant<number>("stays zero", state => state.$eq(0))] }), { maxCommands: 2 })).toMatchObject({
      status: "broken", counterexample: { commands: ["break"], reason: "Invariant stays zero failed" },
    });
  });
});
