import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { orderSpecification } from "../examples/order-machine.spec.js";

describe("TLA+ translation of executable machines", () => {
  it("represents null as a value distinct from empty objects", async () => {
    const State = c.object({ value: c.literal(null), empty: c.object({}) });
    const machine = c.machine("null", { state: State, command: c.boolean(), initial: [{ value: null, empty: {} }], update: state => ({ state }) });
    expect(await c.checkMachineTla(c.specifyMachine(machine))).toMatchObject({ status: "held" });
  });
  it("maps an array nested inside the state", async () => {
    const Item = c.boolean();
    const State = c.object({ items: c.array(Item).max(1) });
    const machine = c.machine("nested map", { state: State, command: c.boolean(), initial: [{ items: [false] }],
      update: (state, _command, m) => ({ state: { items: m.map(Item, state.items, item => m.choose(item.$eq(false), true, item)) } }) });
    const spec = c.specifyMachine(machine, { invariants: [c.invariant<c.Infer<typeof State>>("off", state => state.items.$all(item => item.$eq(false)))] });
    expect(c.checkMachine(spec)).toMatchObject({ status: "broken" });
    expect(await c.checkMachineTla(spec)).toMatchObject({ status: "broken" });
  });
  it("preserves field names that are not TLA+ identifiers", async () => {
    const State = c.object({ "foo-bar": c.boolean() });
    const machine = c.machine("field names", { state: State, command: c.boolean(), initial: [{ "foo-bar": false }],
      update: (_state, command) => ({ state: { "foo-bar": command } }) });
    const spec = c.specifyMachine(machine, { invariants: [c.invariant<c.Infer<typeof State>>("off", state => state["foo-bar"].$eq(false))] });
    expect(c.checkMachine(spec)).toMatchObject({ status: "broken" });
    expect(await c.checkMachineTla(spec)).toMatchObject({ status: "broken" });
  });
  it("represents empty objects without colliding with empty arrays", async () => {
    const machine = c.machine("empty", { state: c.object({}), command: c.boolean(), initial: [{}], update: state => ({ state }) });
    expect(await c.checkMachineTla(c.specifyMachine(machine))).toMatchObject({ status: "held" });
  });
  it("matches runtime and TLA+ for array length guards", async () => {
    const State = c.object({ items: c.array(c.boolean()).max(1), count: c.int().min(0).max(1) });
    const declaration = c.machine("length", { state: State, command: c.boolean(), initial: [{ items: [], count: 0 }],
      update: (state, _command, m) => ({ state: { items: state.items,
        count: m.choose(state.items.$length().$eq(0), 1, 0) } }),
    });
    const spec = c.specifyMachine(declaration, { invariants: [c.invariant<c.Infer<typeof State>>("zero", state => state.count.$eq(0))] });
    expect(c.checkMachine(spec)).toMatchObject({ status: "broken" });
    expect(await c.checkMachineTla(spec)).toMatchObject({ status: "broken" });
  });
  it("checks the same business reducer and invariant with tla-ts", async () => {
    const translation = c.toTla(orderSpecification);
    expect(translation.source).toContain("Step(s, c) ==");
    expect(translation.source).toContain("pending' = Tail(pending) \\o");
    expect(await c.checkMachineTla(orderSpecification)).toMatchObject({ status: "held" });
  });

  it("reports a violated invariant in TLA+", async () => {
    const state = c.int().min(0).max(2);
    const declaration = c.machine("counter", {
      state, command: c.enum(["advance"] as const), initial: [0],
      update: (value, _command, machine) => ({ state: machine.choose(value.$lt(2), value.$plus(1), value) }),
    });
    expect(await c.checkMachineTla(c.specifyMachine(declaration, { invariants: [c.invariant<number>("at most one", value => value.$lte(1))] }))).toMatchObject({
      status: "broken", reason: "at most one", trace: [{ state: "0" }, { state: "1" }, { state: "2" }],
    });
  });

  it("checks a transition that pairs records by key", async () => {
    const Order = c.object({ id: c.enum(["a"] as const), phase: c.enum(["draft", "issued"] as const) });
    const State = c.object({ orders: c.array(Order).max(1) });
    const declaration = c.machine("reopen", {
      state: State, command: c.enum(["reopen"] as const),
      initial: [{ orders: [{ id: "a", phase: "issued" }] }],
      update: () => ({ state: { orders: [{ id: "a" as const, phase: "draft" as const }] } }),
    });
    const specification = c.specifyMachine(declaration, { transitions: [c.transition<c.Infer<typeof Order>>("issued stays issued", { each: "orders", by: "id" },
      (before, after) => before.phase.$ne("issued").$or(after.phase.$eq("issued")))] });
    expect(c.checkMachine(specification)).toMatchObject({ status: "broken" });
    expect(await c.checkMachineTla(specification)).toMatchObject({ status: "broken" });
  });

  it("finds a violated quantified invariant after a mapped array step", async () => {
    const Item = c.int().min(0).max(1);
    const State = c.array(Item).max(1);
    const declaration = c.machine("array", {
      state: State, command: c.boolean(), initial: [[0]],
      update: (state, _command, machine) => ({ state: machine.map(Item, state, item => machine.choose(item.$eq(0), 1, item)) }),
    });
    const specification = c.specifyMachine(declaration, { invariants: [c.invariant<readonly number[]>("all entries stay zero", values =>
      values.$all(value => value.$eq(0)))] });
    expect(c.checkMachine(specification)).toMatchObject({ status: "broken" });
    expect(await c.checkMachineTla(specification)).toMatchObject({ status: "broken", reason: "all entries stay zero" });
  });

  it("does not claim a proof for an open state space", async () => {
    const declaration = c.machine("open", { state: c.int(), command: c.boolean(), initial: [0], update: state => ({ state }) });
    expect(() => c.toTla(c.specifyMachine(declaration))).toThrow("finite, exhaustively enumerated");
    expect(await c.checkMachineTla(c.specifyMachine(declaration))).toMatchObject({ status: "undetermined" });
  });

  it("reports an indefinitely emitted command as undetermined", async () => {
    const declaration = c.machine("loop", { state: c.boolean(), command: c.boolean(), initial: [false],
      update: (state, command) => ({ state, commands: [command] }),
    });
    expect(await c.checkMachineTla(c.specifyMachine(declaration), { maxCommands: 3 })).toMatchObject({
      status: "undetermined", reason: "TLA+ exploration exceeded maxCommands (3)",
    });
    const draining = c.machine("drains at limit", {
      state: c.int().min(0).max(3), command: c.boolean(), initial: [0],
      update: (state, _command, machine) => ({ state: machine.choose(state.$lt(3), state.$plus(1), state),
        commands: machine.choose(state.$lt(2), [true], [] as const) }),
    });
    expect(await c.checkMachineTla(c.specifyMachine(draining), { maxCommands: 3 })).toMatchObject({ status: "held" });
  });

  it("refuses optional state fields when the machine is declared", () => {
    const State = c.object({ flag: c.boolean().optional() });
    expect(() => c.machine("optional", { state: State, command: c.boolean(), initial: [{}],
      update: (state: c.TermOf<c.Infer<typeof State>>) => ({ state }) } as never))
      .toThrow("not yet supported by the TLA+ compiler");
  });

  it("does not erase invalid local bind and constructor schemas", async () => {
    const state = c.int().min(0).max(1);
    const command = c.boolean();
    expect(() => c.machine("invalid bind", { state, command, initial: [0],
      update: ((current: c.TermOf<number>) => c.bind<number, { state: number }>(c.int().min(1), 0, () => ({ state: current }))) as never,
    })).toThrow("can only match the complete state or command value");
    expect(() => c.machine("invalid construction", { state, command, initial: [0],
      update: (() => ({ state: c.construct(c.int().min(1), 0) })) as never,
    })).toThrow("cannot use construct");
  });

  it("binds nested invariant choices to the checked state", async () => {
    const declaration = c.machine("choice invariant", { state: c.boolean(), command: c.boolean(), initial: [false],
      update: state => ({ state }),
    });
    const specification = c.specifyMachine(declaration, {
      invariants: [c.invariant<boolean>("off", state => c.choose(state.$eq(false), true, false))],
    });
    expect(c.toTla(specification).source).toContain("Inv0 == (IF (state = FALSE)");
    expect(await c.checkMachineTla(specification)).toMatchObject({ status: "held" });
  });

  it("refuses a mapped output schema that the runtime would reject", async () => {
    const Item = c.int().min(0).max(1);
    const Output = c.int().min(1);
    const State = c.array(Item).max(1);
    expect(() => c.machine("bad map", { state: State, command: c.boolean(), initial: [[0]],
      update: ((state: c.TermOf<readonly number[]>) => ({ state: c.map(Item, Output, state, element => element) })) as never,
    })).toThrow("preserving its element schema");
  });
});
