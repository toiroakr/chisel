import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { orderMachine } from "../examples/order-machine.js";

const State = c.object({ reserved: c.boolean(), charged: c.boolean() });
type Checkout = c.Infer<typeof State>;
const none: Checkout = { reserved: false, charged: false };

// Every effect rolls the whole command back when it fails, so only a death leaves a half-done checkout.
const checkout = c.machine("checkout", {
  state: State, command: c.enum(["checkout"] as const), initial: [none],
  update: state => ({
    effects: [
      c.effect<Checkout>("reserve", { reserved: true, charged: state.charged }, { failure: state }),
      c.effect<Checkout>("charge", { reserved: true, charged: true }, { failure: state }),
    ],
  }),
});

const leak = c.invariant<Checkout>("a reservation is never left unpaid", state => state.reserved.$eq(false).$or(state.charged.$eq(true)));

describe("a process that dies between the effects of a command", () => {
  it("stops a run after the effects completed so far and emits nothing", () => {
    const result = c.runMachine(checkout, none, "checkout", { dies: point => point.completed === 1 });
    expect(result.state).toStrictEqual({ reserved: true, charged: false });
    expect(result.steps[0]).toMatchObject({ performed: [{ name: "reserve", outcome: "succeeded" }], died: { after: 1 } });
  });

  it("can die before the first effect and after the last one", () => {
    expect(c.runMachine(checkout, none, "checkout", { dies: point => point.completed === 0 }).state).toStrictEqual(none);
    const last = c.runMachine(checkout, none, "checkout", { dies: point => point.completed === 2 });
    expect(last.state).toStrictEqual({ reserved: true, charged: true });
    expect(last.steps[0]!.died).toStrictEqual({ after: 2 });
  });

  it("makes no death point of a command whose effects list is empty", () => {
    const idle = c.machine("idle", {
      state: c.object({ n: c.int().min(0).max(1) }), command: c.enum(["go"] as const), initial: [{ n: 0 }],
      update: () => ({ effects: [] }),
    });
    const asked: number[] = [];
    c.runMachine(idle, { n: 0 }, "go", { dies: point => { asked.push(point.completed); return false; } });
    expect(asked).toStrictEqual([]);
  });

  it("is not explored unless the specification asks for it", () => {
    expect(c.checkMachine(c.specifyMachine(checkout, { invariants: [leak] }))).toMatchObject({ status: "held" });
  });

  it("finds the state a death leaves, which a rollback on failure would have hidden", () => {
    expect(c.checkMachine(c.specifyMachine(checkout, { invariants: [leak], crashes: true }))).toMatchObject({
      status: "broken",
      counterexample: {
        commands: ["checkout"],
        steps: [{ died: { after: 1 }, after: { reserved: true, charged: false } }],
        reason: "Invariant a reservation is never left unpaid failed after checkout died after effect 1 (reserve)",
      },
    });
  });

  it("reaches the state left when the last effect is done but the emitted commands are lost", () => {
    const State = c.object({ charged: c.boolean(), notified: c.boolean() });
    type Paid = c.Infer<typeof State>;
    const paying = c.machine("paying", {
      state: State, command: c.enum(["pay", "notify"] as const), initial: [{ charged: false, notified: false }],
      update: ((state: c.TermOf<Paid>, command: c.TermOf<"pay" | "notify">) => c.choose(command.$eq("pay"),
        { effects: [c.effect<Paid>("charge", { charged: true, notified: state.notified })], commands: ["notify" as const] } as never,
        { state: { charged: state.charged, notified: true } } as never)) as never,
    });
    const rows = (crashes: boolean) => c.checkMachine(c.specifyMachine(paying, { columns: ["charged", "notified"], crashes }))
      .matrix?.rows.map(row => `${row.state.charged}/${row.state.notified}`).sort();
    expect(rows(false)).toStrictEqual(["false/false", "false/true", "true/true"]);
    expect(rows(true)).toStrictEqual(["false/false", "false/true", "true/false", "true/true"]);
  });

  it("does not hold a command that stopped before writing anything to its precondition", () => {
    const Command = c.variants("type", { checkout: c.object({}) });
    const guarded = c.machine("guarded checkout", {
      state: State, command: Command, initial: [none],
      update: state => ({
        effects: [
          c.effect<Checkout>("reserve", { reserved: true, charged: state.charged }, { failure: state }),
          c.effect<Checkout>("charge", { reserved: true, charged: true }, { failure: state }),
        ],
      }),
    });
    const specification = c.specifyMachine(guarded, { requires: { checkout: state => state.charged.$eq(false) }, crashes: true });
    expect(c.checkMachine(specification).status).toBe("held");
  });

  it("leaves a machine without effects as it was", () => {
    const plain = c.checkMachine(c.specifyMachine(orderMachine));
    expect(c.checkMachine(c.specifyMachine(orderMachine, { crashes: true }))).toStrictEqual(plain);
  });
});
