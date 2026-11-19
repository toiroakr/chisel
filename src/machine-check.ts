import { domainOf } from "./domain.js";
import { EvaluationLimit } from "./exact.js";
import { deepEqual } from "./equal.js";
import { MachineFailure, MachineLimitError, isMachine, positiveLimit, runMachine } from "./machine.js";
import type { Machine, MachineExecution, MachineStep } from "./machine.js";
import type { AnySchema } from "./schema.js";
import { checks, pairable, refusedBy } from "./world.js";
import type { Invariant, Transition } from "./world.js";
import { SpecificationError } from "./behavior.js";

export interface MachineSpecification<State, Command> {
  readonly kind: "machine-specification";
  readonly name: string;
  readonly machine: Machine<State, Command>;
  readonly invariants: readonly Invariant[];
  readonly transitions: readonly Transition[];
}

export function specifyMachine<State, Command>(machine: Machine<State, Command>, properties: {
  readonly name?: string;
  readonly invariants?: readonly Invariant[];
  readonly transitions?: readonly Transition[];
} = {}): MachineSpecification<State, Command> {
  const names = [...properties.invariants ?? [], ...properties.transitions ?? []].map(item => item.name);
  const repeated = names.find((item, index) => names.indexOf(item) !== index);
  if (repeated !== undefined) throw new SpecificationError(`Machine ${machine.name} names property ${repeated} more than once`);
  for (const transition of properties.transitions ?? []) {
    if (transition.each) pairable(machine.name, machine.state as AnySchema, transition);
  }
  return { kind: "machine-specification", name: properties.name ?? machine.name, machine,
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
  const maxCommands = positiveLimit(options.maxCommands, 1000, "maxCommands");
  const commands = domainOf(specification.machine.command as AnySchema, domainLimit);
  const seen = new Map<string, State[]>();
  let stateCount = 0;
  const queue: { state: State; start: State; parent?: number; command?: Command; steps: readonly MachineStep<State, Command>[] }[] = [];
  const keyOf = (state: State) => JSON.stringify(state, (_key, value) => typeof value === "bigint" ? `${value}n` : value) ?? "undefined";
  const contains = (state: State) => (seen.get(keyOf(state)) ?? []).some(other => deepEqual(other, state));
  const remember = (state: State) => {
    const key = keyOf(state);
    seen.set(key, [...seen.get(key) ?? [], state]);
    stateCount++;
  };
  const trace = (index: number, command: Command, steps: readonly MachineStep<State, Command>[]) => {
    const commands: Command[] = [command];
    const allSteps: MachineStep<State, Command>[][] = [[...steps]];
    for (let current: number | undefined = index; current !== undefined; current = queue[current]!.parent) {
      const item = queue[current]!;
      if (item.parent !== undefined) { commands.unshift(item.command!); allSteps.unshift([...item.steps]); }
    }
    return { commands, steps: allSteps.flat() };
  };
  let incomplete: string | undefined;
  for (const start of specification.machine.initial) {
    let broken: Invariant | undefined;
    try { broken = specification.invariants.find(invariant => !checks(invariant.holds, start)); }
    catch (error) {
      if (!(error instanceof EvaluationLimit)) throw error;
      incomplete ??= error.message;
      continue;
    }
    if (broken) return { status: "broken", states: 0, transitions: 0,
      counterexample: { start, commands: [], steps: [], reason: `Initial state violates ${broken.name}` } };
    if (contains(start)) continue;
    if (stateCount === maxStates) {
      incomplete ??= `Reached maxStates (${maxStates}) before exploring every initial state`;
      continue;
    }
    remember(start);
    queue.push({ state: start, start, steps: [] });
  }
  let transitions = 0;
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index]!;
    for (const command of commands.values as Command[]) {
      transitions++;
      let steps: readonly MachineStep<State, Command>[];
      let result: MachineExecution<State, Command> | undefined;
      let failure: unknown;
      try {
        result = runMachine(specification.machine, path.state, command, { maxCommands });
        steps = result.steps;
      } catch (error) {
        steps = error instanceof MachineFailure || error instanceof MachineLimitError ? error.steps as MachineStep<State, Command>[] : [];
        failure = error;
      }
      let broken: string | undefined;
      try { broken = violation(specification, steps); }
      catch (error) {
        if (!(error instanceof EvaluationLimit)) throw error;
        incomplete ??= error.message;
        continue;
      }
      if (broken || (failure && !(failure instanceof MachineLimitError))) return {
        status: "broken", states: stateCount, transitions,
        counterexample: { start: path.start, ...trace(index, command, steps),
          reason: broken ?? (failure instanceof Error ? failure.message : String(failure)) },
      };
      if (failure instanceof MachineLimitError) {
        incomplete ??= failure.message;
        continue;
      }
      if (result === undefined) continue;
      const next = result.state;
      if (contains(next)) continue;
      if (stateCount === maxStates) {
        incomplete ??= `Reached maxStates (${maxStates}) before exploring every reachable state`;
        continue;
      }
      remember(next);
      queue.push({ state: next, start: path.start, parent: index, command, steps });
    }
  }
  if (!commands.exhaustive) incomplete ??= `Command schema could not be exhaustively enumerated within domainLimit (${domainLimit})`;
  return incomplete === undefined
    ? { status: "held", states: stateCount, transitions }
    : { status: "undetermined", states: stateCount, transitions, reason: incomplete };
}
