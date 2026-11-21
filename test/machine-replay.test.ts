import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const Status = c.enum(["created", "paid", "shipped"] as const);
const State = c.object({ status: Status, charged: c.boolean() });
const Command = c.variants("type", { pay: c.object({}), ship: c.object({}) });
type Order = c.Infer<typeof State>;
type OrderCommand = c.Infer<typeof Command>;

const pay: OrderCommand = { type: "pay" };
const ship: OrderCommand = { type: "ship" };
const created: Order = { status: "created", charged: false };

// paying charges the card and then marks the order paid, so a failure in between leaves a charged order that is still created
const orders = c.machine("order flow", {
  state: State, command: Command, initial: [created],
  update: (state, command) => c.matchValue<typeof Command, never>(Command, command, {
    pay: () => ({
      effects: [
        c.effect("charge", { status: state.status, charged: true }),
        c.effect("markPaid", { status: c.choose<Order["status"]>(state.status.$eq("created"), "paid", state.status), charged: true }),
      ],
    }),
    ship: () => ({ state: { status: c.choose<Order["status"]>(state.status.$eq("paid"), "shipped", state.status), charged: state.charged } }),
  } as never),
});

const flow = c.specifyMachine(orders, {
  requires: { pay: state => state.status.$eq("created"), ship: state => state.status.$eq("paid") },
});

// The production code: a service over a store, with the store's failures and the process dying injected by the test
class OrderService {
  status: Order["status"];
  charged: boolean;
  completed = 0;
  failing: string | undefined;
  diesAfter: number | undefined;
  constructor(state: Order, private readonly rules: { readonly shipsBeforePayment?: boolean; readonly paysAnyOrder?: boolean } = {}) {
    this.status = state.status;
    this.charged = state.charged;
  }
  private write(name: string, apply: () => void) {
    if (this.failing === name) throw new Error(`${name} failed`);
    apply();
    this.completed++;
    this.dieIfDue();
  }
  private dieIfDue() { if (this.diesAfter === this.completed) throw new Error("process died"); }
  async pay() {
    if (this.status !== "created" && !this.rules.paysAnyOrder) throw new Error("order is not awaiting payment");
    this.dieIfDue();
    this.write("charge", () => { this.charged = true; });
    this.write("markPaid", () => { if (this.status === "created" || this.rules.paysAnyOrder) this.status = "paid"; });
  }
  async ship() {
    if (this.status !== "paid" && !this.rules.shipsBeforePayment) throw new Error("order is not paid");
    this.status = "shipped";
  }
  snapshot(): Order { return { status: this.status, charged: this.charged }; }
}

function subjectOf(rules: ConstructorParameters<typeof OrderService>[1] = {}) {
  const log: { resets: Order[]; sequences: OrderCommand[][]; runs: { command: OrderCommand; faults: readonly c.ReplayFault<OrderCommand>[] }[] } = { resets: [], sequences: [], runs: [] };
  let service = new OrderService(created, rules);
  const subject: c.MachineSubject<Order, OrderCommand> = {
    reset: state => { log.resets.push(state); log.sequences.push([]); service = new OrderService(state, rules); },
    run: async (command, faults) => {
      log.runs.push({ command, faults }); log.sequences.at(-1)!.push(command);
      service.failing = undefined;
      service.diesAfter = undefined;
      service.completed = 0;
      for (const fault of faults) {
        if (fault.kind === "fails") service.failing = fault.effect;
        else service.diesAfter = fault.after;
      }
      await (command.type === "pay" ? service.pay() : service.ship());
    },
    read: () => service.snapshot(),
  };
  return { subject, log };
}

describe("replaying a machine against the production code", () => {
  it("passes when the service agrees with the machine after every command in every state", async () => {
    const { subject, log } = subjectOf();
    const report = await c.replayMachine(flow, subject, { faults: false });
    expect(report).toMatchObject({ status: "passed", states: 3, replayed: 6 });
    expect(log.resets).toHaveLength(6);
  });

  it("replays every command after the shortest way to each state, including the ones that only come back to a state already seen", async () => {
    const { subject, log } = subjectOf();
    await c.replayMachine(flow, subject, { faults: false });
    expect(log.sequences).toStrictEqual([
      [pay], [ship],
      [pay, pay], [pay, ship],
      [pay, ship, pay], [pay, ship, ship],
    ]);
  });

  it("reports the shortest sequence after which the service and the machine disagree, with both states", async () => {
    const { subject } = subjectOf({ shipsBeforePayment: true });
    expect(await c.replayMachine(flow, subject, { faults: false })).toMatchObject({
      status: "failed", replayed: 2,
      failure: {
        start: created,
        steps: [{ command: ship, expected: created, actual: { status: "shipped", charged: false } }],
        reason: 'After ship the machine reaches {"status":"created","charged":false} but the subject reads {"status":"shipped","charged":false}',
      },
    });
  });

  it("finds a disagreement that only shows when a command is replayed from a state where the machine leaves it as it is", async () => {
    const { subject } = subjectOf({ paysAnyOrder: true });
    expect(await c.replayMachine(flow, subject, { faults: false })).toMatchObject({
      status: "failed",
      failure: { steps: [{ command: pay }, { command: ship }, { command: pay, expected: { status: "shipped", charged: true }, actual: { status: "paid", charged: true } }] },
    });
  });

  it("accepts a service that refuses a command with a throw or with no change where the precondition is false", async () => {
    const throwing = subjectOf().subject;
    expect((await c.replayMachine(flow, throwing, { faults: false })).status).toBe("passed");
    const quiet: c.MachineSubject<Order, OrderCommand> = { ...throwing, run: async (command, faults) => { try { await throwing.run(command, faults); } catch { /* refused without a throw */ } } };
    expect((await c.replayMachine(flow, quiet, { faults: false })).status).toBe("passed");
  });

  it("fails when the service throws although the precondition of the command holds", async () => {
    const { subject } = subjectOf();
    const broken: c.MachineSubject<Order, OrderCommand> = { ...subject, run: async command => { if (command.type === "pay") throw new Error("store unavailable"); } };
    expect(await c.replayMachine(flow, broken, { faults: false })).toMatchObject({
      status: "failed",
      failure: { steps: [{ command: pay, threw: "store unavailable" }], reason: 'pay threw "store unavailable" although the machine runs it' },
    });
  });

  it("fails when the state read back is not a state of the machine", async () => {
    const { subject } = subjectOf();
    const odd: c.MachineSubject<Order, OrderCommand> = { ...subject, read: () => ({ status: "lost", charged: false }) as never };
    const report = await c.replayMachine(flow, odd, { faults: false });
    expect(report.status).toBe("failed");
    expect(report.failure?.reason).toContain("After pay the subject reads a state the machine does not allow");
  });

  it("tells the service which effect to fail, and replays the state a failed effect leaves behind", async () => {
    const { subject, log } = subjectOf();
    const report = await c.replayMachine(flow, subject);
    expect(report).toMatchObject({ status: "passed", states: 4 });
    expect(log.runs.map(run => run.faults).filter(faults => faults.length > 0)).toContainEqual([{ kind: "fails", effect: "markPaid", index: 1, command: pay }]);
    expect(log.resets).toContainEqual(created);
  });

  it("replays only the runs where every effect succeeds when asked not to inject faults", async () => {
    const { subject, log } = subjectOf();
    expect(await c.replayMachine(flow, subject, { faults: false })).toMatchObject({ states: 3 });
    expect(log.runs.every(run => run.faults.length === 0)).toBe(true);
  });

  it("finds the drift a failed effect exposes", async () => {
    const { subject } = subjectOf();
    const lenient: c.MachineSubject<Order, OrderCommand> = { ...subject, run: async (command, faults) => {
      try { await subject.run(command, faults); } catch (error) { if (faults.length === 0) throw error; }
    }, read: () => ({ status: "paid", charged: true }) };
    expect(await c.replayMachine(flow, lenient)).toMatchObject({ status: "failed" });
  });

  it("tells the service when the process dies, after how many effects, and replays the state it leaves", async () => {
    const { subject, log } = subjectOf();
    const crashing = c.specifyMachine(orders, {
      requires: { pay: state => state.status.$eq("created"), ship: state => state.status.$eq("paid") }, crashes: true,
    });
    expect(await c.replayMachine(crashing, subject)).toMatchObject({ status: "passed" });
    expect(log.runs.flatMap(run => run.faults)).toContainEqual({ kind: "dies", after: 1, command: pay });
  });

  it("accepts a machine in place of its specification", async () => {
    const { subject } = subjectOf();
    const quiet: c.MachineSubject<Order, OrderCommand> = { ...subject, run: async (command, faults) => { try { await subject.run(command, faults); } catch { /* no precondition says it must throw */ } } };
    expect((await c.replayMachine(orders, quiet, { faults: false })).status).toBe("passed");
  });

  it("is undetermined when the replays exceed the limit", async () => {
    const { subject } = subjectOf();
    expect(await c.replayMachine(flow, subject, { maxReplays: 2 })).toMatchObject({
      status: "undetermined", replayed: 2, reason: "Reached maxReplays (2) before replaying every sequence",
    });
  });

  it("is undetermined when the exploration reaches its own limit", async () => {
    const { subject } = subjectOf();
    expect(await c.replayMachine(flow, subject, { maxStates: 1, faults: false })).toMatchObject({
      status: "undetermined", reason: "Reached maxStates (1) before exploring every reachable state",
    });
  });

  it("leaves a throw from reset or read to the caller, since the harness and not the service is broken", async () => {
    const { subject } = subjectOf();
    await expect(c.replayMachine(flow, { ...subject, reset: () => { throw new Error("fake store unavailable"); } })).rejects.toThrow("fake store unavailable");
    await expect(c.replayMachine(flow, { ...subject, read: () => { throw new Error("cannot read"); } })).rejects.toThrow("cannot read");
  });

  it("refuses a subject without reset, run or read", async () => {
    const { subject } = subjectOf();
    for (const name of ["reset", "run", "read"] as const) {
      await expect(c.replayMachine(flow, { ...subject, [name]: undefined } as never)).rejects.toThrow(`The subject has no ${name} function`);
    }
  });

  it("refuses a limit that is not a positive safe integer and a faults option that is not a boolean", async () => {
    const { subject } = subjectOf();
    for (const name of ["maxReplays", "maxStates", "maxCommands", "maxOutcomes", "domainLimit"] as const) {
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        await expect(c.replayMachine(flow, subject, { [name]: bad })).rejects.toThrow(`${name} must be a positive safe integer`);
      }
    }
    await expect(c.replayMachine(flow, subject, { faults: "no" as never })).rejects.toThrow("faults must be a boolean");
  });
});
