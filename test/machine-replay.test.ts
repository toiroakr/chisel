import { Decimal } from "decimal.js";
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
  constructor(state: Order, private readonly rules: { readonly shipsBeforePayment?: boolean; readonly paysAnyOrder?: boolean; readonly forgetsChargeOnFailure?: boolean } = {}) {
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
    try {
      this.write("charge", () => { this.charged = true; });
      this.write("markPaid", () => { if (this.status === "created" || this.rules.paysAnyOrder) this.status = "paid"; });
    } catch (error) {
      if (this.rules.forgetsChargeOnFailure) this.charged = false;
      throw error;
    }
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
    expect(log.runs.map(run => run.faults).filter(faults => faults.length > 0)).toContainEqual([{ kind: "fails", effect: "markPaid", index: 1, command: pay, step: 0 }]);
    expect(log.resets).toContainEqual(created);
  });

  it("replays only the runs where every effect succeeds when asked not to inject faults", async () => {
    const { subject, log } = subjectOf();
    expect(await c.replayMachine(flow, subject, { faults: false })).toMatchObject({ states: 3 });
    expect(log.runs.every(run => run.faults.length === 0)).toBe(true);
  });

  it("finds the drift a failed effect exposes", async () => {
    const { subject } = subjectOf({ forgetsChargeOnFailure: true });
    expect(await c.replayMachine(flow, subject)).toMatchObject({
      status: "failed",
      failure: { steps: [{
        command: pay, faults: [{ kind: "fails", effect: "markPaid" }],
        expected: { status: "created", charged: true }, actual: { status: "created", charged: false },
      }] },
    });
  });

  it("accepts a throw from a run in which a command the machine emitted has a false precondition", async () => {
    const Phase = c.enum(["draft", "approved", "issued"] as const);
    const Flow = c.object({ phase: Phase });
    type Phased = c.Infer<typeof Flow>;
    const Steps = c.variants("type", { submit: c.object({}), allocate: c.object({}) });
    const fulfilment = c.machine("fulfilment", {
      state: Flow, command: Steps, initial: [{ phase: "draft" as const }],
      update: (state, command) => c.matchValue<typeof Steps, never>(Steps, command, {
        submit: () => ({ state: { phase: c.choose<Phased["phase"]>(state.phase.$eq("draft"), "approved", state.phase) }, commands: [{ type: "allocate" as const }] }),
        allocate: () => ({ state: { phase: c.choose<Phased["phase"]>(state.phase.$eq("approved"), "issued", state.phase) } }),
      } as never),
    });
    const specification = c.specifyMachine(fulfilment, { requires: { allocate: state => state.phase.$eq("approved") } });
    let phase: Phased["phase"] = "draft";
    const subject: c.MachineSubject<Phased, c.Infer<typeof Steps>> = {
      reset: state => { phase = state.phase; },
      run: command => {
        if (command.type === "allocate") { if (phase === "approved") phase = "issued"; return; }
        if (phase === "issued") throw new Error("nothing left to allocate");
        if (phase === "draft") phase = "approved";
        phase = "issued";
      },
      read: () => ({ phase }),
    };
    expect(await c.replayMachine(specification, subject, { faults: false })).toMatchObject({ status: "passed" });
  });

  it("tells the service when the process dies, after how many effects, and replays the state it leaves", async () => {
    const { subject, log } = subjectOf();
    const crashing = c.specifyMachine(orders, {
      requires: { pay: state => state.status.$eq("created"), ship: state => state.status.$eq("paid") }, crashes: true,
    });
    expect(await c.replayMachine(crashing, subject)).toMatchObject({ status: "passed" });
    expect(log.runs.flatMap(run => run.faults)).toContainEqual({ kind: "dies", after: 1, command: pay, step: 0 });
  });

  it("tells apart the occurrences of an emitted command that fail, by the step each belongs to", async () => {
    const Count = c.object({ n: c.int().min(0).max(2) });
    const Steps = c.variants("type", { start: c.object({}), bump: c.object({}) });
    type Counted = c.Infer<typeof Count>;
    const counting = c.machine("counting", {
      state: Count, command: Steps, initial: [{ n: 0 }],
      update: (state, command) => c.matchValue<typeof Steps, never>(Steps, command, {
        start: () => ({ state: { n: state.n }, commands: [{ type: "bump" as const }, { type: "bump" as const }] }),
        bump: () => ({ effects: [c.effect<Counted>("write", { n: c.choose<number>(state.n.$lt(2), state.n.$plus(1), state.n) }, { failure: { n: 0 } })] }),
      } as never),
    });
    let current: Counted = { n: 0 };
    const seen: (readonly c.ReplayFault<c.Infer<typeof Steps>>[])[] = [];
    const subject: c.MachineSubject<Counted, c.Infer<typeof Steps>> = {
      reset: state => { current = state; },
      run: (command, faults) => {
        seen.push(faults);
        // only `bump` writes, and `start` is step 0, so its first emitted bump is step 1
        let step = command.type === "start" ? 1 : 0;
        current = c.runMachine(counting, current, command, { fails: () => { const here = step++; return faults.some(fault => fault.kind === "fails" && fault.step === here); } }).state;
      },
      read: () => current,
    };
    expect(await c.replayMachine(counting, subject)).toMatchObject({ status: "passed" });
    expect(seen.filter(faults => faults.length === 1).map(faults => faults[0]!.kind === "fails" ? faults[0]!.step : -1).sort()).toContain(1);
    expect(seen.some(faults => faults.some(fault => fault.kind === "fails" && fault.step === 2))).toBe(true);
  });

  it("gives reset a state of its own, so a subject that changes it in place cannot corrupt the starts of later replays", async () => {
    const { subject } = subjectOf();
    const inPlace: c.MachineSubject<Order, OrderCommand> = {
      ...subject,
      reset: async state => { await subject.reset(state); (state as { charged: boolean }).charged = true; },
    };
    expect(await c.replayMachine(flow, inPlace, { faults: false })).toMatchObject({ status: "passed", states: 3 });
  });

  it("gives reset its own copy of a decimal too, since its digits can be changed in place", async () => {
    const Balance = c.object({ amount: c.decimal(2) });
    const Touch = c.variants("type", { touch: c.object({}) });
    type Held = c.Infer<typeof Balance>;
    const balance = c.machine("balance", {
      state: Balance, command: Touch, initial: [{ amount: new Decimal("1.5") }],
      update: state => ({ state: { amount: state.amount } }),
    });
    let held: Held = { amount: new Decimal(0) };
    const subject: c.MachineSubject<Held, c.Infer<typeof Touch>> = {
      reset: state => { held = { amount: new Decimal(state.amount) }; (state.amount as unknown as { d: number[] }).d[0] = 7; },
      run: () => undefined,
      read: () => held,
    };
    expect(await c.replayMachine(balance, subject)).toMatchObject({ status: "passed", replayed: 1 });
  });

  it("does not enumerate failure outcomes when faults are off, so an outcomes limit of one is enough", async () => {
    const { subject } = subjectOf();
    expect(await c.replayMachine(flow, subject, { faults: false, maxOutcomes: 1 })).toMatchObject({ status: "passed" });
  });

  it("takes two states with the same fields in another order as one state", async () => {
    const Tags = c.object({ tags: c.record(c.int().min(0).max(2)) });
    const Reorder = c.variants("type", { reorder: c.object({}) });
    const tagged = c.machine("tagged", {
      state: Tags, command: Reorder, initial: [{ tags: { a: 1, b: 2 } }],
      update: () => ({ state: { tags: { b: 2, a: 1 } } }),
    });
    let current: c.Infer<typeof Tags> = { tags: {} };
    const subject: c.MachineSubject<c.Infer<typeof Tags>, c.Infer<typeof Reorder>> = { reset: state => { current = state; }, run: () => undefined, read: () => current };
    expect(await c.replayMachine(tagged, subject, { maxStates: 1 })).toMatchObject({ status: "passed", states: 1 });
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
