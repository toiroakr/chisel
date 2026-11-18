import { invariant, specifyMachine } from "../src/verification.js";
import { openMachine } from "./open-machine.js";

export const openSpecification = specifyMachine(openMachine, {
  invariants: [invariant<number>("nonnegative", state => state.$gte(0))],
});
