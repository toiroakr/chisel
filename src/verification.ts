export { specifyMachine, isMachineSpecification, checkMachine } from "./machine-check.js";
export type { MachineSpecification, MachineReport, MachineTrace } from "./machine-check.js";
export { invariant, transition } from "./world.js";
export { toTla, checkMachineTla, proveMachine } from "./tla.js";
export type { TlaModule, InductiveProof } from "./tla.js";
