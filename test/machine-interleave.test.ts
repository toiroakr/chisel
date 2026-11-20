import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

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
    expect(report.terminals.every(item => item.state.stock === 0 && item.state.a !== item.state.b)).toBe(true);
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
