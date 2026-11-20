import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { orderSpecification } from "../examples/order-machine.spec.js";

describe("TLA+ translation of executable machines", () => {
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
      update: value => ({ state: c.choose(value.$lt(2), value.$plus(1), value) }),
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
      update: state => ({ state: c.map(Item, Item, state, item => c.choose(item.$eq(0), 1, item)) }),
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
      update: state => ({ state: c.choose(state.$lt(3), state.$plus(1), state),
        commands: c.choose(state.$lt(2), [true], [] as const) }),
    });
    expect(await c.checkMachineTla(c.specifyMachine(draining), { maxCommands: 3 })).toMatchObject({ status: "held" });
  });

  it("refuses optional field reads rather than accepting an invalid TLA expression", async () => {
    const State = c.object({ flag: c.boolean().optional() });
    const declaration = c.machine("optional", { state: State, command: c.boolean(), initial: [{}], update: state => ({ state }) });
    expect(await c.checkMachineTla(c.specifyMachine(declaration, {
      invariants: [c.invariant<c.Infer<typeof State>>("flag", state => state.flag.$eq(false))],
    }))).toMatchObject({ status: "undetermined", reason: "TLA+ translation does not support optional state fields" });
  });

  it("does not erase invalid local bind and constructor schemas", async () => {
    const state = c.int().min(0).max(1);
    const command = c.boolean();
    const bound = c.machine("invalid bind", { state, command, initial: [0],
      update: current => c.bind<number, { state: number }>(c.int().min(1), 0, () => ({ state: current })),
    });
    const constructed = c.machine("invalid construction", { state, command, initial: [0],
      update: () => ({ state: c.construct(c.int().min(1), 0) }),
    });
    expect(await c.checkMachineTla(c.specifyMachine(bound))).toMatchObject({ status: "undetermined" });
    expect(await c.checkMachineTla(c.specifyMachine(constructed))).toMatchObject({ status: "undetermined" });
    expect((await c.proveMachine(c.specifyMachine(bound))).status).toBe("undetermined");
    expect((await c.proveMachine(c.specifyMachine(constructed))).status).toBe("undetermined");
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
    const declaration = c.machine("bad map", { state: State, command: c.boolean(), initial: [[0]],
      update: state => ({ state: c.map(Item, Output, state, element => element) }),
    });
    expect(() => c.runMachine(declaration, [0], true)).toThrow("Invalid local construction");
    expect(await c.checkMachineTla(c.specifyMachine(declaration))).toMatchObject({ status: "undetermined" });
    expect((await c.proveMachine(c.specifyMachine(declaration))).status).toBe("undetermined");
  });

  it("checks command preconditions in TLA+ and names the one that disagrees with the state change", async () => {
    const wrong = c.specifyMachine(orderSpecification.machine, { requires: { allocate: state => state.phase.$ne("issued") } });
    expect(await c.checkMachineTla(wrong)).toMatchObject({
      status: "broken", reason: "allocate: its precondition disagrees with whether it changes the state",
    });
  });

  it("proves each command precondition as two obligations", async () => {
    const proof = await c.proveMachine(orderSpecification);
    const named = proof.obligations.filter(item => item.name.includes("precondition"));
    expect(named.map(item => item.name)).toStrictEqual([
      "allocate precondition allows the change", "allocate precondition forces the change",
      "receive precondition allows the change", "receive precondition forces the change",
    ]);
    expect(proof.status).toBe("proved");
    const wrong = await c.proveMachine(c.specifyMachine(orderSpecification.machine, { requires: { allocate: state => state.phase.$ne("issued") } }));
    expect(wrong.status).toBe("undetermined");
    expect(wrong.obligations.find(item => item.name === "allocate precondition forces the change")?.status).toBe("undetermined");
  }, 60000);

  it("adds the last-command variable only when a precondition is declared", () => {
    expect(c.toTla(c.specifyMachine(orderSpecification.machine)).source).not.toContain("last");
    expect(c.toTla(orderSpecification).source).toContain("last");
  });

  describe("effects", () => {
    const Label = c.enum(["none", "in-progress", "checkpoint"] as const);
    const State = c.object({ label: Label, migrated: c.boolean() });
    const Command = c.variants("type", { deploy: c.object({}), resolve: c.object({}) });
    type Deploy = c.Infer<typeof State>;
    const deploy = c.machine("tla deploy", {
      state: State, command: Command, initial: [{ label: "none", migrated: false }],
      update: (state, command) => c.matchValue<typeof Command, never>(Command, command, {
        deploy: () => ({
          effects: [
            c.effect<Deploy>("writeLabel", { label: "in-progress" as const, migrated: state.migrated }),
            c.effect<Deploy>("runScript", { label: "in-progress" as const, migrated: true }),
            c.effect<Deploy>("writeLabel", { label: "checkpoint" as const, migrated: true }),
          ],
        }),
        resolve: () => ({ state: { label: "none" as const, migrated: state.migrated } }),
      } as never),
    });
    const finished = c.invariant<Deploy>("checkpoint means migrated", state => state.label.$ne("checkpoint").$or(state.migrated.$eq(true)));
    const stable = c.invariant<Deploy>("no half-finished deploy", state => state.label.$ne("in-progress"));

    it("explores the failure of every effect", async () => {
      expect(await c.checkMachineTla(c.specifyMachine(deploy, { invariants: [finished] }))).toMatchObject({ status: "held" });
      expect(await c.checkMachineTla(c.specifyMachine(deploy, { invariants: [stable] }))).toMatchObject({
        status: "broken", reason: "no half-finished deploy",
      });
    });

    it("agrees with the native checker about preconditions after a failure", { timeout: 60000 }, async () => {
      const guarded = c.machine("tla guarded deploy", {
        state: State, command: Command, initial: [{ label: "none", migrated: false }],
        update: (state, command) => c.matchValue<typeof Command, never>(Command, command, {
          deploy: () => ({
            effects: c.choose<readonly c.Effect<Deploy>[]>(state.label.$eq("none"), [
              c.effect<Deploy>("writeLabel", { label: "in-progress" as const, migrated: state.migrated }),
              c.effect<Deploy>("writeLabel", { label: "checkpoint" as const, migrated: state.migrated }),
            ], []),
          }),
          resolve: () => ({ state: { label: "none" as const, migrated: state.migrated } }),
        } as never),
      });
      const right = c.specifyMachine(guarded, { requires: { deploy: state => state.label.$eq("none"), resolve: state => state.label.$ne("none") } });
      expect(c.checkMachine(right).status).toBe("held");
      expect((await c.checkMachineTla(right)).status).toBe("held");
      expect((await c.proveMachine(right)).status).toBe("proved");
      const wrong = c.specifyMachine(guarded, { requires: { deploy: state => state.label.$ne("none") } });
      expect(c.checkMachine(wrong).status).toBe("broken");
      expect((await c.checkMachineTla(wrong)).status).toBe("broken");
    });

    it("proves an invariant over every outcome of the effects", async () => {
      const proof = await c.proveMachine(c.specifyMachine(deploy, { invariants: [finished] }));
      expect(proof.status).toBe("proved");
      const broken = await c.proveMachine(c.specifyMachine(deploy, { invariants: [stable] }));
      expect(broken.status).toBe("undetermined");
      expect(broken.obligations.find(item => item.name === "no half-finished deploy")?.status).toBe("undetermined");
    }, 60000);
  });

  describe("a process dying between effects", () => {
    const State = c.object({ reserved: c.boolean(), charged: c.boolean() });
    type Checkout = c.Infer<typeof State>;
    const checkout = c.machine("tla checkout", {
      state: State, command: c.enum(["checkout"] as const), initial: [{ reserved: false, charged: false }],
      update: state => ({
        effects: [
          c.effect<Checkout>("reserve", { reserved: true, charged: state.charged }, { failure: state }),
          c.effect<Checkout>("charge", { reserved: true, charged: true }, { failure: state }),
        ],
      }),
    });
    const leak = c.invariant<Checkout>("a reservation is never left unpaid", state => state.reserved.$eq(false).$or(state.charged.$eq(true)));
    const paid = c.invariant<Checkout>("a charge implies a reservation", state => state.charged.$eq(false).$or(state.reserved.$eq(true)));

    it("finds what a death leaves only when the specification asks for it", async () => {
      expect((await c.checkMachineTla(c.specifyMachine(checkout, { invariants: [leak] }))).status).toBe("held");
      expect(await c.checkMachineTla(c.specifyMachine(checkout, { invariants: [leak], crashes: true }))).toMatchObject({
        status: "broken", reason: "a reservation is never left unpaid",
      });
    });

    it("makes no death point of a command whose effects list is empty", async () => {
      const Mixed = c.object({ n: c.int().min(0).max(1) });
      const mixed = c.machine("tla mixed", {
        state: Mixed, command: c.enum(["write", "skip"] as const), initial: [{ n: 0 }],
        update: (_state, command) => ({
          effects: c.choose<readonly c.Effect<c.Infer<typeof Mixed>>[]>(command.$eq("write"), [c.effect<c.Infer<typeof Mixed>>("write", { n: 1 })], []),
        }),
      });
      const specification = c.specifyMachine(mixed, { crashes: true });
      expect(c.toTla(specification).source).toContain("IF Len(r.effects) = 0 THEN {} ELSE 0..Len(r.effects)");
      expect((await c.checkMachineTla(specification)).status).toBe("held");
    });

    it("proves an invariant over the states a death leaves", { timeout: 60000 }, async () => {
      expect((await c.proveMachine(c.specifyMachine(checkout, { invariants: [paid], crashes: true }))).status).toBe("proved");
      expect((await c.proveMachine(c.specifyMachine(checkout, { invariants: [leak], crashes: true }))).status).toBe("undetermined");
    });
  });
});
