import { domainOf } from "./domain.js";
import { deepEqual } from "./equal.js";
import { MachineFailure, MachineLimitError, isMachine, positiveLimit, runMachine } from "./machine.js";
import type { Machine, MachineStep } from "./machine.js";
import type { AnySchema } from "./schema.js";
import { checks, pairable, refusedBy } from "./world.js";
import type { Invariant, Transition } from "./world.js";

export interface MachineSpecification<State, Command> {
  readonly kind: "machine-specification";
  readonly name: string;
  readonly machine: Machine<State, Command>;
  readonly invariants: readonly Invariant[];
  readonly transitions: readonly Transition[];
}

export function specifyMachine<State, Command>(machine: Machine<State, Command>, properties: {
  readonly invariants?: readonly Invariant[];
  readonly transitions?: readonly Transition[];
} = {}): MachineSpecification<State, Command> {
  for (const transition of properties.transitions ?? []) {
    if (transition.each) pairable(machine.name, machine.state as AnySchema, transition);
  }
  return { kind: "machine-specification", name: machine.name, machine,
    invariants: properties.invariants ?? [], transitions: properties.transitions ?? [] };
}

export function isMachineSpecification(value: unknown): value is MachineSpecification<unknown, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<MachineSpecification<unknown, unknown>>;
  return candidate.kind === "machine-specification" && isMachine(candidate.machine) &&
    Array.isArray(candidate.invariants) && Array.isArray(candidate.transitions);
}

export interface MachineTrace<State, Command> {
  readonly start: State;
  readonly commands: readonly Command[];
  readonly steps: readonly MachineStep<State, Command>[];
  readonly reason: string;
}

export interface MachineReport<State, Command> {
  readonly status: "held" | "broken" | "undetermined";
  readonly states: number;
  readonly transitions: number;
  readonly reason?: string;
  readonly counterexample?: MachineTrace<State, Command>;
}

function violation<State, Command>(specification: MachineSpecification<State, Command>, steps: readonly MachineStep<State, Command>[]): string | undefined {
  for (const step of steps) {
    const broken = specification.invariants.find(invariant => !checks(invariant.holds, step.after));
    if (broken) return `Invariant ${broken.name} failed`;
    for (const transition of specification.transitions) {
      const reason = refusedBy(transition, specification.name, step.before, step.after);
      if (reason !== undefined) return reason;
    }
  }
  return undefined;
}

// Breadth-first search gives the shortest command sequence to a failure.
export function checkMachine<State, Command>(specification: MachineSpecification<State, Command>, options: {
  readonly maxStates?: number;
  readonly maxCommands?: number;
  readonly domainLimit?: number;
} = {}): MachineReport<State, Command> {
  const maxStates = positiveLimit(options.maxStates, 10000, "maxStates");
  const domainLimit = positiveLimit(options.domainLimit, 10000, "domainLimit");
  const commands = domainOf(specification.machine.command as AnySchema, domainLimit);
  const seen: State[] = [];
  const queue: { state: State; start: State; commands: Command[]; steps: MachineStep<State, Command>[] }[] = [];
  let incomplete: string | undefined;
  for (const start of specification.machine.initial) {
    const broken = specification.invariants.find(invariant => !checks(invariant.holds, start));
    if (broken) return { status: "broken", states: 0, transitions: 0,
      counterexample: { start, commands: [], steps: [], reason: `Initial state violates ${broken.name}` } };
    if (seen.some(state => deepEqual(state, start))) continue;
    if (seen.length === maxStates) {
      incomplete ??= `Reached maxStates (${maxStates}) before exploring every initial state`;
      continue;
    }
    seen.push(start);
    queue.push({ state: start, start, commands: [], steps: [] });
  }
  let transitions = 0;
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index]!;
    for (const command of commands.values as Command[]) {
      transitions++;
      let steps: readonly MachineStep<State, Command>[];
      let next: State | undefined;
      let failure: unknown;
      try {
        const result = runMachine(specification.machine, path.state, command,
          options.maxCommands === undefined ? {} : { maxCommands: options.maxCommands });
        steps = result.steps;
        next = result.state;
      } catch (error) {
        steps = error instanceof MachineFailure ? error.steps : [];
        failure = error;
      }
      const broken = violation(specification, steps);
      if (broken || (failure && !(failure instanceof MachineLimitError))) return {
        status: "broken", states: seen.length, transitions,
        counterexample: { start: path.start, commands: [...path.commands, command], steps: [...path.steps, ...steps],
          reason: broken ?? (failure instanceof Error ? failure.message : String(failure)) },
      };
      if (failure instanceof MachineLimitError) {
        incomplete ??= failure.message;
        continue;
      }
      if (next === undefined) continue;
      if (seen.some(state => deepEqual(state, next))) continue;
      if (seen.length === maxStates) {
        incomplete ??= `Reached maxStates (${maxStates}) before exploring every reachable state`;
        continue;
      }
      seen.push(next);
      queue.push({ state: next, start: path.start, commands: [...path.commands, command], steps: [...path.steps, ...steps] });
    }
  }
  if (!commands.exhaustive) incomplete ??= `Command schema could not be exhaustively enumerated within domainLimit (${domainLimit})`;
  return incomplete === undefined
    ? { status: "held", states: seen.length, transitions }
    : { status: "undetermined", states: seen.length, transitions, reason: incomplete };
}
