import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { interleavingsToTla } from "../src/tla.js";

const Stock = c.object({ stock: c.int().min(0).max(1), a: c.boolean(), b: c.boolean() });
type Shop = c.Infer<typeof Stock>;
const Buy = c.variants("type", { buy: c.object({ customer: c.enum(["a", "b"] as const) }) });
const start: Shop = { stock: 1, a: false, b: false };

// Reads the stock, then writes the stock and the buyer's own flag from what it read.
function shop(options: { readonly ifUnchanged?: boolean; readonly writes?: readonly string[] } = {}) {
  return c.machine("shop", {
    state: Stock, command: Buy, initial: [start],
    update: ((state: c.TermOf<Shop>, command: c.TermOf<c.Infer<typeof Buy>>) => ({
      effects: c.choose<readonly c.Effect<Shop>[]>(state.stock.$gte(1), [
        c.effect<Shop>("take", {
          stock: state.stock.$minus(1),
          a: c.choose<boolean>((command as never as c.TermOf<{ customer: string }>).customer.$eq("a"), true, state.a),
          b: c.choose<boolean>((command as never as c.TermOf<{ customer: string }>).customer.$eq("b"), true, state.b),
        }, options),
      ], []),
    })) as never,
  });
}

const once = c.invariant<Shop>("the last unit is sold once", state => state.a.$eq(false).$or(state.b.$eq(false)));
const both = [{ type: "buy" as const, customer: "a" as const }, { type: "buy" as const, customer: "b" as const }];

describe("effects that write only what they change", () => {
  it("lets an effect guard its write on nothing having been written since the command read the state", () => {
    const result = c.runMachine(shop({ ifUnchanged: true }), start, { type: "buy", customer: "a" });
    expect(result.state).toStrictEqual({ stock: 0, a: true, b: false });
  });
});

describe("two copies of a command interleaving on one shared state", () => {
  it("finds the lost update of a write that is not guarded, with the order of the steps", () => {
    const report = c.checkInterleavings(c.specifyMachine(shop(), { invariants: [once] }), { copies: both });
    expect(report).toMatchObject({ status: "broken", counterexample: { reason: "Invariant the last unit is sold once failed" } });
    const steps = report.counterexample!.steps;
    expect(steps.map(step => step.action)).toStrictEqual(["read", "read", "write", "write"]);
    expect(steps.slice(0, 2).map(step => step.copy).sort()).toStrictEqual([0, 1]);
    expect(steps.slice(2).map(step => step.effect)).toStrictEqual(["take", "take"]);
  });

  it("holds when the write is guarded, and one of the copies ends refused", () => {
    const report = c.checkInterleavings(c.specifyMachine(shop({ ifUnchanged: true }), { invariants: [once] }), { copies: both });
    expect(report.status).toBe("held");
    expect(report.terminals.map(item => item.statuses.join("/"))).toContain("finished/refused");
    expect(report.terminals.map(item => item.statuses.join("/"))).toContain("refused/finished");
    expect([...new Set(report.terminals.map(item => `${item.state.stock}/${item.state.a}/${item.state.b}`))].sort()).toStrictEqual(["0/false/true", "0/true/false"]);
  });

  it("writes the fields it names instead of the ones that changed", () => {
    const report = c.checkInterleavings(c.specifyMachine(shop({ writes: ["stock"] }), { invariants: [once] }), { copies: both });
    expect(report.status).toBe("held");
    expect(report.terminals.every(item => item.state.a === false && item.state.b === false)).toBe(true);
  });

  it("reads and writes in one step for a command that declares a state instead of effects", () => {
    const Counter = c.object({ count: c.int().min(0).max(2) });
    const counting = c.machine("counting", {
      state: Counter, command: c.enum(["add"] as const), initial: [{ count: 0 }],
      update: state => ({ state: { count: state.count.$plus(1) } }),
    });
    const report = c.checkInterleavings(c.specifyMachine(counting), { copies: ["add", "add"] });
    expect(report.status).toBe("held");
    expect(report.terminals.map(item => item.state.count)).toStrictEqual([2]);
  });

  it("starts the next command of a copy with a new read after its effects and the commands they emit", () => {
    const Tally = c.object({ n: c.int().min(0).max(2), done: c.int().min(0).max(2) });
    type Tallied = c.Infer<typeof Tally>;
    const tallying = c.machine("tallying", {
      state: Tally, command: c.enum(["bump", "after"] as const), initial: [{ n: 0, done: 0 }],
      update: ((state: c.TermOf<Tallied>, command: c.TermOf<"bump" | "after">) => c.choose(command.$eq("bump"),
        { effects: [c.effect<Tallied>("count", { n: state.n.$plus(1), done: state.done })], commands: ["after"] } as never,
        { state: { n: state.n, done: state.done.$plus(1) } } as never)) as never,
    });
    const report = c.checkInterleavings(c.specifyMachine(tallying), { copies: ["bump", "bump"] });
    expect(report.status).toBe("held");
    expect(report.terminals.every(item => item.statuses.join("/") === "finished/finished")).toBe(true);
    expect(report.terminals.every(item => item.state.done === 2)).toBe(true);
    expect(report.terminals.map(item => item.state.n).sort()).toStrictEqual([1, 2]);
  });

  it("stays undetermined past the number of copies it is allowed", () => {
    const report = c.checkInterleavings(c.specifyMachine(shop(), { invariants: [once] }), { copies: [...both, ...both.slice(0, 1)] });
    expect(report).toMatchObject({ status: "undetermined", reason: "3 copies exceed maxCopies (2)" });
    expect(c.checkInterleavings(c.specifyMachine(shop({ ifUnchanged: true }), {}), { copies: [...both, ...both.slice(0, 1)], maxCopies: 3 }).status).toBe("held");
  });

  it("stays undetermined when it reaches maxStates before it has seen every interleaving", () => {
    expect(c.checkInterleavings(c.specifyMachine(shop({ ifUnchanged: true })), { copies: both, maxStates: 3 }))
      .toMatchObject({ status: "undetermined" });
  });
});

describe("copies interleaving on one shared state, in TLA+", () => {
  it("finds the lost update of an unguarded write and holds for a guarded one", async () => {
    const unguarded = c.specifyMachine(shop(), { invariants: [once] });
    const guarded = c.specifyMachine(shop({ ifUnchanged: true }), { invariants: [once] });
    expect(await c.checkInterleavingsTla(unguarded, { copies: both })).toMatchObject({ status: "broken", reason: "the last unit is sold once" });
    expect((await c.checkInterleavingsTla(guarded, { copies: both })).status).toBe("held");
  });

  it("agrees with the native checker on the fields a write names", async () => {
    const specification = c.specifyMachine(shop({ writes: ["stock"] }), { invariants: [once] });
    expect(c.checkInterleavings(specification, { copies: both }).status).toBe("held");
    expect((await c.checkInterleavingsTla(specification, { copies: both })).status).toBe("held");
  });

  it("stays undetermined for a command that emits commands, which the translation does not follow", async () => {
    const Tally = c.object({ n: c.int().min(0).max(2) });
    const emitting = c.machine("emitting", {
      state: Tally, command: c.enum(["go", "more"] as const), initial: [{ n: 0 }],
      update: ((_state: c.TermOf<c.Infer<typeof Tally>>, command: c.TermOf<"go" | "more">) => c.choose(command.$eq("go"),
        { effects: [c.effect<c.Infer<typeof Tally>>("count", { n: 1 })], commands: ["more"] } as never,
        { state: { n: 2 } } as never)) as never,
    });
    expect((await c.checkInterleavingsTla(c.specifyMachine(emitting), { copies: ["go", "go"] })).status).toBe("undetermined");
  });
});

describe("what an effect and an interleaving declaration are checked for", () => {
  it("writes the removal of an optional field a copy made", () => {
    const Notes = c.object({ n: c.int().min(0).max(1), note: c.string().optional() });
    const notes = c.machine("notes", {
      state: Notes, command: c.enum(["clear"] as const), initial: [{ n: 0, note: "x" }],
      update: state => ({ effects: [c.effect<c.Infer<typeof Notes>>("drop", { n: state.n })] }),
    });
    const report = c.checkInterleavings(c.specifyMachine(notes), { copies: ["clear"] });
    expect(report.terminals.map(item => item.state)).toStrictEqual([{ n: 0 }]);
  });

  it("refuses a write that names a field the state does not have", () => {
    const report = c.checkInterleavings(c.specifyMachine(shop({ writes: ["nope"] })), { copies: both });
    expect(report).toMatchObject({ status: "broken", counterexample: { reason: expect.stringContaining("nope") } });
  });

  it("refuses an effect whose writes is not a list of names or whose ifUnchanged is not a boolean", () => {
    const wrong = (options: object) => c.checkInterleavings(c.specifyMachine(shop(options as never)), { copies: both });
    expect(wrong({ writes: "stock" })).toMatchObject({ status: "broken", counterexample: { reason: expect.stringContaining("writes") } });
    expect(wrong({ ifUnchanged: "yes" })).toMatchObject({ status: "broken", counterexample: { reason: expect.stringContaining("ifUnchanged") } });
  });

  it("refuses an empty list of copies or starts, and a copy the command schema refuses, where they are declared or run", () => {
    expect(() => c.specifyMachine(shop(), { interleavings: { copies: [] } })).toThrow("no copy to run");
    expect(() => c.specifyMachine(shop(), { interleavings: { copies: [{ type: "sell" } as never] } })).toThrow("Copy 0");
    expect(() => c.specifyMachine(shop(), { interleavings: { copies: both, starts: [] } })).toThrow("no state to start from");
    expect(() => c.checkInterleavings(c.specifyMachine(shop()), { copies: both, starts: [] })).toThrow("no state to start from");
  });

  it("starts from the states it is given", async () => {
    const empty: Shop = { stock: 0, a: false, b: false };
    const specification = c.specifyMachine(shop(), { invariants: [once] });
    expect(c.checkInterleavings(specification, { copies: both, starts: [empty] }).status).toBe("held");
    expect((await c.checkInterleavingsTla(specification, { copies: both, starts: [empty] })).status).toBe("held");
    expect((await c.checkInterleavingsTla(specification, { copies: both })).status).toBe("broken");
  });

  it("holds the state a write leaves to the state schema in TLA+ too", async () => {
    const Drain = c.object({ stock: c.int().min(0).max(1) });
    const draining = c.machine("draining", {
      state: Drain, command: c.enum(["take"] as const), initial: [{ stock: 0 }],
      update: state => ({ effects: [c.effect<c.Infer<typeof Drain>>("take", { stock: state.stock.$minus(1) })] }),
    });
    const specification = c.specifyMachine(draining);
    expect(c.checkInterleavings(specification, { copies: ["take", "take"] }).status).toBe("broken");
    expect((await c.checkInterleavingsTla(specification, { copies: ["take", "take"] })).status).toBe("broken");
  });

  it("is undetermined in TLA+ for a write that names a field the state does not have", async () => {
    const report = await c.checkInterleavingsTla(c.specifyMachine(shop({ writes: ["nope"] })), { copies: both });
    expect(report.status).toBe("undetermined");
  });

  it("refuses a maxCopies that is not a positive integer in TLA+ as it does natively", async () => {
    await expect(c.checkInterleavingsTla(c.specifyMachine(shop()), { copies: both, maxCopies: Number.NaN })).rejects.toThrow("maxCopies");
  });

  it("wraps the conditional values of the TLA+ actions so they cannot swallow what follows", () => {
    const { source } = interleavingsToTla(c.specifyMachine(shop()), { copies: both });
    expect(source).toContain("version' = (IF");
    expect(source).toContain("status' = (IF");
  });
});
