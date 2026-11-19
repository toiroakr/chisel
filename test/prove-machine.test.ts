import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

describe("universal inductive proofs", () => {
  it("proves a guarded increment and its upper bound inductively", async () => {
    const declaration = c.machine("bounded", {
      state: c.int().min(0).max(2), command: c.boolean(), initial: [0],
      update: (state, _command, machine) => ({ state: machine.choose(state.$lt(2), state.$plus(1), state) }),
    });
    expect(await c.proveMachine(c.specifyMachine(declaration, { invariants: [c.invariant<number>("bounded", state => state.$lte(2))] }))).toMatchObject({ status: "proved" });
  }, 15_000);

  it("proves an invariant over an open state space without enumerating it", async () => {
    const declaration = c.machine("preserve", {
      state: c.int(), command: c.int(), initial: [0],
      update: state => ({ state }),
    });
    const specification = c.specifyMachine(declaration, { invariants: [c.invariant<number>("nonnegative", state => state.$gte(0))] });
    expect(c.checkMachine(specification).status).toBe("undetermined");
    const proof = await c.proveMachine(specification);
    expect(proof.status).toBe("proved");
    expect(proof.obligations).toHaveLength(4);
  });

  it("does not claim a proof when an unbounded increment exceeds the state contract", async () => {
    const declaration = c.machine("increment", {
      state: c.int().min(0).max(2), command: c.boolean(), initial: [0],
      update: state => ({ state: state.$plus(1) }),
    });
    const proof = await c.proveMachine(c.specifyMachine(declaration, { invariants: [c.invariant<number>("nonnegative", state => state.$gte(0))] }));
    expect(proof.status).toBe("undetermined");
    expect(proof.obligations.find(item => item.name === "state contract")?.status).toBe("undetermined");
    expect(proof.obligations).toHaveLength(4);
    expect(proof.obligations.every(item => item.status === "undetermined")).toBe(true);
    expect(proof.reason).toBeTruthy();
  }, 15_000);
});
