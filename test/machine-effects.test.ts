import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const Label = c.enum(["none", "in-progress", "checkpoint"] as const);
const State = c.object({ label: Label, migrated: c.boolean() });
const Command = c.variants("type", { deploy: c.object({}), resolve: c.object({}) });
type Deploy = c.Infer<typeof State>;

function deployMachine(options: { readonly rollback?: boolean } = {}) {
  return c.machine("deploy", {
    state: State, command: Command, initial: [{ label: "none", migrated: false }],
    update: (state, command) => c.matchValue<typeof Command, never>(Command, command, {
      deploy: () => ({
        effects: [
          c.effect("writeLabel", { label: "in-progress" as const, migrated: state.migrated }),
          c.effect("runScript", { label: "in-progress" as const, migrated: true },
            options.rollback ? { failure: state } : {}),
          c.effect("writeLabel", { label: "checkpoint" as const, migrated: true }),
        ],
      }),
      resolve: () => ({ state: { label: "none" as const, migrated: state.migrated } }),
    } as never),
  });
}

const succeeded = (name: string) => ({ name, outcome: "succeeded" });
const failed = (name: string) => ({ name, outcome: "failed" });

describe("machine effects", () => {
  it("ends in the state of the last effect when every effect succeeds", () => {
    const result = c.runMachine(deployMachine(), { label: "none", migrated: false }, { type: "deploy" });
    expect(result.state).toStrictEqual({ label: "checkpoint", migrated: true });
    expect(result.steps[0]).toMatchObject({
      before: { label: "none", migrated: false }, after: { label: "checkpoint", migrated: true },
      performed: [succeeded("writeLabel"), succeeded("runScript"), succeeded("writeLabel")],
    });
  });

  it("keeps the earlier writes and stops at the effect that failed", () => {
    const result = c.runMachine(deployMachine(), { label: "none", migrated: false }, { type: "deploy" },
      { fails: effect => effect.name === "runScript" });
    expect(result.state).toStrictEqual({ label: "in-progress", migrated: false });
    expect(result.steps[0]!.performed).toStrictEqual([succeeded("writeLabel"), failed("runScript")]);
  });

  it("leaves the state its failure expression names", () => {
    const result = c.runMachine(deployMachine({ rollback: true }), { label: "none", migrated: false }, { type: "deploy" },
      { fails: effect => effect.name === "runScript" });
    expect(result.state).toStrictEqual({ label: "none", migrated: false });
  });

  it("drops the commands a failed command would have emitted", () => {
    const declaration = c.machine("emit", {
      state: c.object({ n: c.int().min(0).max(2) }), command: c.enum(["go", "next"] as const), initial: [{ n: 0 }],
      update: (state, command) => ({
        effects: c.choose<readonly c.Effect<{ n: number }>[]>(command.$eq("go"), [c.effect<{ n: number }>("write", { n: 1 })], []),
        commands: c.choose(command.$eq("go"), ["next" as const], [] as const),
      }),
    });
    expect(c.runMachine(declaration, { n: 0 }, "go").steps.map(step => step.command)).toStrictEqual(["go", "next"]);
    expect(c.runMachine(declaration, { n: 0 }, "go", { fails: () => true }).steps.map(step => step.command)).toStrictEqual(["go"]);
  });

  it("checks every state a failed effect can leave", () => {
    const stable = c.invariant<Deploy>("no half-finished deploy", state => state.label.$ne("in-progress"));
    expect(c.checkMachine(c.specifyMachine(deployMachine(), { invariants: [stable] }))).toMatchObject({
      status: "broken",
      counterexample: {
        commands: [{ type: "deploy" }],
        steps: [{ performed: [succeeded("writeLabel"), failed("runScript")] }],
        reason: "Invariant no half-finished deploy failed after runScript failed",
      },
    });
    const finished = c.invariant<Deploy>("checkpoint means migrated", state => state.label.$ne("checkpoint").$or(state.migrated.$eq(true)));
    expect(c.checkMachine(c.specifyMachine(deployMachine(), { invariants: [finished] }))).toMatchObject({ status: "held" });
  });

  it("reaches the states failures leave and explores every command from them", () => {
    const report = c.checkMachine(c.specifyMachine(deployMachine()));
    expect(report).toMatchObject({ status: "held", states: 5 });
  });

  it("does not take a failure at the first effect as a precondition that held but changed nothing", () => {
    const guarded = c.machine("guarded deploy", {
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
    const requires = { deploy: (state: c.TermOf<Deploy>) => state.label.$eq("none"), resolve: (state: c.TermOf<Deploy>) => state.label.$ne("none") };
    expect(c.checkMachine(c.specifyMachine(guarded, { requires }))).toMatchObject({ status: "held" });
    const wrong = { ...requires, deploy: (state: c.TermOf<Deploy>) => state.label.$ne("none") };
    expect(c.checkMachine(c.specifyMachine(guarded, { requires: wrong }))).toMatchObject({ status: "broken" });
  });

  it("refuses an effect that names nothing", () => {
    const declaration = c.machine("nameless", {
      state: c.int().min(0).max(1), command: c.boolean(), initial: [0],
      update: () => ({ effects: [{ state: 1 }] }),
    } as never);
    expect(() => c.runMachine(declaration, 0, true)).toThrow("An effect must name itself");
  });
});
