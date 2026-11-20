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
});
