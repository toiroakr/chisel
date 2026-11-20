import { invariant, specifyMachine, transition } from "../src/verification.js";
import { orderMachine } from "./order-machine.js";

type Order = typeof orderMachine.initial[number];

export const orderSpecification = specifyMachine(orderMachine, {
  columns: ["phase"],
  requires: {
    allocate: order => order.phase.$eq("approved"),
    receive: (order, command) => order.phase.$eq("issued").$and(order.received.$plus(command.units).$lte(order.ordered)),
  },
  invariants: [invariant<Order>("cannot receive more than ordered", order => order.received.$lte(order.ordered))],
  transitions: [transition<Order>("issued orders stay issued", (before, after) =>
    before.phase.$ne("issued").$or(after.phase.$eq("issued")))],
});
