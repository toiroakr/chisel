import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { MachineFailure } from "../src/machine.js";

const Step = c.enum(["start", "reserved", "shipped", "failed"] as const);
const State = c.object({ step: Step, name: c.string() });
const Command = c.variants("type", {
  place: c.object({ name: c.string() }),
  ship: c.object({}),
  observed: c.object({ name: c.string() }),
});

const order = c.machine("order", {
  state: State, command: Command, initial: [{ step: "start", name: "" }],
  update: (state, command) => c.matchValue<typeof Command, never>(Command, command, {
    place: (place: c.TermOf<{ type: "place"; name: string }>) => ({
      effects: [c.effect("reserve", { step: "reserved" as const, name: place.name },
        { failure: { step: "failed" as const, name: place.name } })],
      commands: [{ type: "ship" as const }],
    }),
    ship: () => ({ effects: [c.effect("ship", { step: "shipped" as const, name: state.name })] }),
    observed: (observed: c.TermOf<{ type: "observed"; name: string }>) => ({ state: { step: state.step, name: observed.name } }),
  } as never),
});

describe("driveMachine", () => {
  it("performs each effect with the states around it, in the order runMachine follows", async () => {
    const performed: unknown[] = [];
    const result = await c.driveMachine(order, { step: "start", name: "" }, { type: "place", name: "A-100" }, {
      perform: async effect => { performed.push([effect.name, effect.before, effect.after]); },
    });
    expect(performed).toStrictEqual([
      ["reserve", { step: "start", name: "" }, { step: "reserved", name: "A-100" }],
      ["ship", { step: "reserved", name: "A-100" }, { step: "shipped", name: "A-100" }],
    ]);
    expect(result.state).toStrictEqual({ step: "shipped", name: "A-100" });
    expect(result.failures).toStrictEqual([]);
    expect(result.steps).toStrictEqual(c.runMachine(order, { step: "start", name: "" }, { type: "place", name: "A-100" }).steps);
  });

  it("ends the command in its failure state and drops what it emits when perform rejects", async () => {
    const error = new Error("unavailable");
    const result = await c.driveMachine(order, { step: "start", name: "" }, { type: "place", name: "A-100" }, {
      perform: effect => { if (effect.name === "reserve") throw error; },
    });
    expect(result.state).toStrictEqual({ step: "failed", name: "A-100" });
    expect(result.failures).toStrictEqual([{ name: "reserve", index: 0, command: { type: "place", name: "A-100" }, error }]);
    expect(result.steps).toStrictEqual(c.runMachine(order, { step: "start", name: "" }, { type: "place", name: "A-100" },
      { fails: effect => effect.name === "reserve" }).steps);
  });

  it("runs a command an effect observed after the commands the transition emitted", async () => {
    const result = await c.driveMachine(order, { step: "start", name: "" }, { type: "place", name: "A-100" }, {
      perform: effect => effect.name === "reserve" ? { commands: [{ type: "observed" as const, name: "B-200" }] } : undefined,
    });
    expect(result.steps.map(step => step.command)).toStrictEqual([
      { type: "place", name: "A-100" }, { type: "ship" }, { type: "observed", name: "B-200" },
    ]);
    expect(result.state).toStrictEqual({ step: "shipped", name: "B-200" });
  });

  it("refuses an observed command the command schema refuses", async () => {
    await expect(c.driveMachine(order, { step: "start", name: "" }, { type: "place", name: "A-100" }, {
      perform: () => ({ commands: [{ type: "unknown" } as never] }),
    })).rejects.toThrow(c.SpecificationError);
  });
  it("performs nothing when the transition declares a later effect or an emitted command the schemas refuse", async () => {
    const refused = (update: () => unknown) => c.machine("refused", { state: State, command: Command, initial: [{ step: "start", name: "" }], update: update as never });
    const performed: string[] = [];
    const perform = (effect: { name: string }) => { performed.push(effect.name); };
    const laterEffect = refused(() => ({ effects: [c.effect("charge", { step: "reserved", name: "" }), c.effect("bad", { step: "nowhere", name: "" })] }));
    await expect(c.driveMachine(laterEffect, { step: "start", name: "" }, { type: "ship" }, { perform })).rejects.toThrow(c.SpecificationError);
    const emitted = refused(() => ({ effects: [c.effect("charge", { step: "reserved", name: "" })], commands: [{ type: "unknown" }] }));
    await expect(c.driveMachine(emitted, { step: "start", name: "" }, { type: "ship" }, { perform })).rejects.toThrow(c.SpecificationError);
    expect(performed).toStrictEqual([]);
  });

  it("hands perform copies, so changing them reaches neither the machine's state nor its recorded steps", async () => {
    const result = await c.driveMachine(order, { step: "start", name: "" }, { type: "place", name: "A-100" }, {
      perform: effect => { effect.before.name = "TAMPERED"; effect.after.name = "TAMPERED"; },
    });
    expect(result.state).toStrictEqual({ step: "shipped", name: "A-100" });
    expect(result.steps.map(step => step.after.name)).toStrictEqual(["A-100", "A-100"]);
  });
  it("reports an exception from a fault-injection callback of runMachine as the machine's failure, with the steps already run", () => {
    const error = new Error("probe");
    const run = () => c.runMachine(order, { step: "start", name: "" }, { type: "place", name: "A-100" }, { fails: effect => { if (effect.name === "ship") throw error; return false; } });
    expect(run).toThrow(MachineFailure);
    expect(run).toThrow("probe");
    try { run(); } catch (thrown) { expect((thrown as MachineFailure<unknown, unknown>).steps.map(step => step.command)).toStrictEqual([{ type: "place", name: "A-100" }]); }
  });

  it("fails an effect whose perform rejects its promise as it does one that throws", async () => {
    const error = new Error("unavailable");
    const result = await c.driveMachine(order, { step: "start", name: "" }, { type: "place", name: "A-100" }, {
      perform: async effect => { if (effect.name === "reserve") throw error; },
    });
    expect(result.failures.map(failure => failure.error)).toStrictEqual([error]);
    expect(result.state).toStrictEqual({ step: "failed", name: "A-100" });
  });
});
