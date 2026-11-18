import { invariant, specifyMachine, transition } from "../src/verification.js";
import { orderMachine } from "./order-machine.js";

type Order = typeof orderMachine.initial[number];

export const orderSpecification = specifyMachine(orderMachine, {
  invariants: [invariant<Order>("cannot receive more than ordered", order => order.received.$lte(order.ordered))],
  transitions: [transition<Order>("issued orders stay issued", (before, after) =>
    before.phase.$ne("issued").$or(after.phase.$eq("issued")))],
});
