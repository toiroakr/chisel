import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { orderMachine } from "../examples/order-machine.js";

type Order = typeof orderMachine.initial[number];

const approvedOnly = (state: c.TermOf<Order>) => state.phase.$eq("approved");
const issuedWithRoom = (state: c.TermOf<Order>, command: c.TermOf<{ units: number }>) =>
  state.phase.$eq("issued").$and(state.received.$plus(command.units).$lte(state.ordered));

describe("machine preconditions", () => {
  it("holds when each command changes the state exactly when its precondition holds", () => {
    const specification = c.specifyMachine(orderMachine, {
      requires: { allocate: approvedOnly, receive: issuedWithRoom },
    });
    expect(c.checkMachine(specification)).toMatchObject({ status: "held" });
  });

  it("breaks with the shortest sequence when a command changes the state although its precondition is false", () => {
    const specification = c.specifyMachine(orderMachine, {
      requires: { allocate: state => state.phase.$eq("draft") },
    });
    expect(c.checkMachine(specification)).toMatchObject({
      status: "broken",
      counterexample: {
        commands: ["submit"].map(type => ({ type })),
        reason: "allocate changed the state although its precondition was false",
      },
    });
  });

  it("breaks when a command leaves the state unchanged although its precondition holds", () => {
    const specification = c.specifyMachine(orderMachine, {
      requires: { allocate: state => state.phase.$ne("issued") },
    });
    expect(c.checkMachine(specification)).toMatchObject({
      status: "broken",
      counterexample: {
        commands: [{ type: "allocate" }],
        reason: "allocate left the state unchanged although its precondition held",
      },
    });
  });

  it("refuses a precondition for a command the machine does not declare", () => {
    expect(() => c.specifyMachine(orderMachine, { requires: { cancel: approvedOnly } as never }))
      .toThrow("Machine order fulfillment declares no command cancel");
  });

  it("tabulates, per projected state and command, whether the state changes and whether the precondition holds", () => {
    const specification = c.specifyMachine(orderMachine, {
      requires: { allocate: approvedOnly, receive: issuedWithRoom },
      columns: ["phase"],
    });
    const report = c.checkMachine(specification);
    expect(report.matrix?.columns).toStrictEqual(["phase"]);
    const cell = (phase: string, command: object) => report.matrix?.rows
      .find(row => row.state.phase === phase)?.cells.find(item => JSON.stringify(item.command) === JSON.stringify(command));
    expect(report.matrix?.rows.map(row => row.state)).toStrictEqual([{ phase: "draft" }, { phase: "issued" }]);
    expect(cell("draft", { type: "submit" })).toMatchObject({ changes: "always" });
    expect(cell("issued", { type: "submit" })).toMatchObject({ changes: "never" });
    expect(cell("draft", { type: "allocate" })).toStrictEqual({ command: { type: "allocate" }, changes: "never", precondition: "never" });
    expect(cell("issued", { type: "receive", units: 1 })).toStrictEqual({
      command: { type: "receive", units: 1 }, changes: "sometimes", precondition: "sometimes",
    });
  });

  it("leaves the matrix out when no columns are given", () => {
    expect(c.checkMachine(c.specifyMachine(orderMachine)).matrix).toBeUndefined();
  });

  it("refuses a column the state does not declare", () => {
    expect(() => c.specifyMachine(orderMachine, { columns: ["status"] as never }))
      .toThrow("Machine order fulfillment has no state field status to use as a column");
  });
});
