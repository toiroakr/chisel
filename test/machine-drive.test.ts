import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

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
});
