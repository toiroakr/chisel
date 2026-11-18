import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { orderMachine } from "../examples/order-machine.js";

describe("TLA+ translation of executable machines", () => {
  it("checks the same business reducer and invariant with tla-ts", async () => {
    const translation = c.toTla(orderMachine);
    expect(translation.source).toContain("Step(s, c) ==");
    expect(translation.source).toContain("pending' = Tail(pending) \\o");
    expect(await c.checkMachineTla(orderMachine)).toMatchObject({ status: "held" });
  });

  it("reports a violated invariant in TLA+", async () => {
    const state = c.int().min(0).max(2);
    const declaration = c.machine("counter", {
      state, command: c.enum(["advance"] as const), initial: [0],
      invariants: [c.invariant<number>("at most one", value => value.$lte(1))],
      update: value => ({ state: c.choose(value.$lt(2), value.$plus(1), value) }),
    });
    expect(await c.checkMachineTla(declaration)).toMatchObject({
      status: "broken", reason: "at most one", trace: [{ state: "0" }, { state: "1" }, { state: "2" }],
    });
  });

  it("checks a transition that pairs records by key", async () => {
    const Order = c.object({ id: c.enum(["a"] as const), phase: c.enum(["draft", "issued"] as const) });
    const State = c.object({ orders: c.array(Order).max(1) });
    const declaration = c.machine("reopen", {
      state: State, command: c.enum(["reopen"] as const),
      initial: [{ orders: [{ id: "a", phase: "issued" }] }],
      transitions: [c.transition<c.Infer<typeof Order>>("issued stays issued", { each: "orders", by: "id" },
        (before, after) => before.phase.$ne("issued").$or(after.phase.$eq("issued")))],
      update: () => ({ state: { orders: [{ id: "a" as const, phase: "draft" as const }] } }),
    });
    expect(c.checkMachine(declaration)).toMatchObject({ status: "broken" });
    expect(await c.checkMachineTla(declaration)).toMatchObject({ status: "broken" });
  });

  it("checks a mapped array and a quantified invariant", async () => {
    const Item = c.int().min(0).max(1);
    const State = c.array(Item).max(1);
    const declaration = c.machine("array", {
      state: State, command: c.boolean(), initial: [[1]],
      invariants: [c.invariant<readonly number[]>("all entries are bounded", values =>
        values.$all(value => value.$lte(1)))],
      update: state => ({ state: c.map(Item, Item, state, item => c.choose(item.$eq(1), 0, item)) }),
    });
    expect(c.checkMachine(declaration)).toMatchObject({ status: "held" });
    expect(await c.checkMachineTla(declaration)).toMatchObject({ status: "held" });
  });

  it("does not claim a proof for an open state space", async () => {
    const declaration = c.machine("open", { state: c.int(), command: c.boolean(), initial: [0], update: state => ({ state }) });
    expect(() => c.toTla(declaration)).toThrow("finite, exhaustively enumerated");
    expect(await c.checkMachineTla(declaration)).toMatchObject({ status: "undetermined" });
  });

  it("reports an indefinitely emitted command as undetermined", async () => {
    const declaration = c.machine("loop", { state: c.boolean(), command: c.boolean(), initial: [false],
      update: (state, command) => ({ state, commands: [command] }),
    });
    expect(await c.checkMachineTla(declaration, { maxCommands: 3 })).toMatchObject({ status: "undetermined" });
  });
});
