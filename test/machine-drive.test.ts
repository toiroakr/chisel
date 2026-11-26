import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const Step = c.enum(["start", "created", "labelled", "failed"] as const);
const State = c.object({ step: Step, name: c.string() });
const Command = c.variants("type", {
  create: c.object({ name: c.string() }),
  label: c.object({}),
  observed: c.object({ name: c.string() }),
});

const deploy = c.machine("deploy", {
  state: State, command: Command, initial: [{ step: "start", name: "" }],
  update: (state, command) => c.matchValue<typeof Command, never>(Command, command, {
    create: (create: c.TermOf<{ type: "create"; name: string }>) => ({
      effects: [c.effect("createType", { step: "created" as const, name: create.name },
        { failure: { step: "failed" as const, name: create.name } })],
      commands: [{ type: "label" as const }],
    }),
    label: () => ({ effects: [c.effect("writeLabel", { step: "labelled" as const, name: state.name })] }),
    observed: (observed: c.TermOf<{ type: "observed"; name: string }>) => ({ state: { step: state.step, name: observed.name } }),
  } as never),
});

describe("driveMachine", () => {
  it("performs each effect with the states around it, in the order runMachine follows", async () => {
    const performed: unknown[] = [];
    const result = await c.driveMachine(deploy, { step: "start", name: "" }, { type: "create", name: "User" }, {
      perform: async effect => { performed.push([effect.name, effect.before, effect.after]); },
    });
    expect(performed).toStrictEqual([
      ["createType", { step: "start", name: "" }, { step: "created", name: "User" }],
      ["writeLabel", { step: "created", name: "User" }, { step: "labelled", name: "User" }],
    ]);
    expect(result.state).toStrictEqual({ step: "labelled", name: "User" });
    expect(result.failures).toStrictEqual([]);
    expect(result.steps).toStrictEqual(c.runMachine(deploy, { step: "start", name: "" }, { type: "create", name: "User" }).steps);
  });

  it("ends the command in its failure state and drops what it emits when perform rejects", async () => {
    const error = new Error("unavailable");
    const result = await c.driveMachine(deploy, { step: "start", name: "" }, { type: "create", name: "User" }, {
      perform: effect => { if (effect.name === "createType") throw error; },
    });
    expect(result.state).toStrictEqual({ step: "failed", name: "User" });
    expect(result.failures).toStrictEqual([{ name: "createType", index: 0, command: { type: "create", name: "User" }, error }]);
    expect(result.steps).toStrictEqual(c.runMachine(deploy, { step: "start", name: "" }, { type: "create", name: "User" },
      { fails: effect => effect.name === "createType" }).steps);
  });

  it("runs a command an effect observed after the commands the transition emitted", async () => {
    const result = await c.driveMachine(deploy, { step: "start", name: "" }, { type: "create", name: "User" }, {
      perform: effect => effect.name === "createType" ? { commands: [{ type: "observed" as const, name: "Renamed" }] } : undefined,
    });
    expect(result.steps.map(step => step.command)).toStrictEqual([
      { type: "create", name: "User" }, { type: "label" }, { type: "observed", name: "Renamed" },
    ]);
    expect(result.state).toStrictEqual({ step: "labelled", name: "Renamed" });
  });

  it("refuses an observed command the command schema refuses", async () => {
    await expect(c.driveMachine(deploy, { step: "start", name: "" }, { type: "create", name: "User" }, {
      perform: () => ({ commands: [{ type: "unknown" } as never] }),
    })).rejects.toThrow(c.SpecificationError);
  });
});
