// A single executable expression describes both production transitions and
// the graph checked by exhaustive exploration. No second model can drift from
// the code that runs. Completeness requires a finite command domain.
import { SpecificationError } from "./behavior.js";
import { domainOf } from "./domain.js";
import { deepEqual } from "./equal.js";
import { EvaluationLimit } from "./exact.js";
import { childrenOf, interpret, nodeOf } from "./model.js";
import type { Template } from "./model.js";
import { rootTerm } from "./rule.js";
import type { TermOf } from "./rule.js";
import type { AnySchema, Schema } from "./schema.js";
import { checks, pairable, refusedBy } from "./world.js";
import type { Invariant, Transition } from "./world.js";

export type MachineCommand<State, Command> = Template<{
  readonly state: State;
  // Each emitted command runs through this same transition function, in order.
  readonly commands?: readonly Command[];
}>;

export interface Machine<State, Command> {
  readonly kind: "machine";
  readonly name: string;
  readonly state: Schema<State>;
  readonly command: Schema<Command>;
  readonly initial: readonly State[];
  readonly invariants: readonly Invariant[];
  readonly transitions: readonly Transition[];
  readonly update: MachineCommand<State, Command>;
}

export function machine<State, Command>(name: string, definition: {
  readonly state: Schema<State>;
  readonly command: Schema<Command>;
  readonly initial: readonly State[];
  readonly update: (state: TermOf<State>, command: TermOf<Command>) => MachineCommand<State, Command>;
  readonly invariants?: readonly Invariant[];
  readonly transitions?: readonly Transition[];
}): Machine<State, Command> {
  if (definition.initial.length === 0) throw new SpecificationError(`Machine ${name} starts from no state`);
  const initial = definition.initial.map((value, index) => parse(definition.state, value, `Initial state ${index + 1}`));
  const update = definition.update(rootTerm<State>("state"), rootTerm<Command>("command"));
  if (!update || (!nodeOf(update) && !Object.hasOwn(update, "state"))) throw new SpecificationError(`Machine ${name} must return a state`);
  if (hasCall(update)) throw new SpecificationError(`Machine ${name} cannot call external dependencies in a transition`);
  for (const transition of definition.transitions ?? []) {
    if (transition.each) pairable(name, definition.state as AnySchema, transition);
  }
  return { kind: "machine", name, state: definition.state, command: definition.command, initial, update,
    invariants: definition.invariants ?? [], transitions: definition.transitions ?? [] };
}

export function isMachine(value: unknown): value is Machine<unknown, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Machine<unknown, unknown>>;
  return candidate.kind === "machine" && typeof candidate.name === "string" &&
    typeof candidate.state?.parse === "function" && typeof candidate.command?.parse === "function" &&
    Array.isArray(candidate.initial) && candidate.update !== undefined;
}

function hasCall(value: unknown): boolean {
  if (nodeOf(value)?.kind === "call") return true;
  return childrenOf(value).some(hasCall);
}

function parse<T>(schema: Schema<T>, value: unknown, context: string): T {
  const result = schema.parse(value);
  if (!result.success) throw new SpecificationError(`${context}: ${result.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
  return result.value;
}

export interface MachineStep<State, Command> {
  readonly command: Command;
  readonly before: State;
  readonly after: State;
}

export interface MachineExecution<State, Command> {
  readonly state: State;
  readonly steps: readonly MachineStep<State, Command>[];
}

class MachineFailure<State, Command> extends SpecificationError {
  constructor(message: string, readonly steps: readonly MachineStep<State, Command>[]) { super(message); }
}

class MachineLimitError extends SpecificationError {}

// Evaluates the same expression used by checkMachine. Emissions are internal
// commands, not I/O. The caller decides when and where to persist the result.
export function runMachine<State, Command>(definition: Machine<State, Command>, state: NoInfer<State>, command: NoInfer<Command>,
  options: { readonly maxCommands?: number } = {}): MachineExecution<State, Command> {
  const maxCommands = positiveLimit(options.maxCommands, 1000, "maxCommands");
  let current = parse(definition.state, state, "Current state");
  for (const invariant of definition.invariants) {
    if (!checks(invariant.holds, current)) throw new SpecificationError(`Current state violates ${invariant.name}`);
  }
  const pending: unknown[] = [command];
  const steps: MachineStep<State, Command>[] = [];
  while (pending.length > 0) {
    if (steps.length === maxCommands) throw new MachineLimitError(`Machine ${definition.name} exceeded ${maxCommands} commands`);
    try {
      const input = parse(definition.command, pending.shift(), "Command");
      const output = interpret(definition.update, { state: current, command: input }) as { state: unknown; commands?: unknown };
      if (output === null || typeof output !== "object" || !Object.hasOwn(output, "state")) {
        throw new SpecificationError("A machine transition must return a state");
      }
      const next = parse(definition.state, output.state, `Command ${steps.length + 1} next state`);
      const emitted = output.commands === undefined ? [] : output.commands;
      if (!Array.isArray(emitted)) throw new SpecificationError("Emitted commands must be an array");
      const validated = emitted.map((value: unknown) => parse(definition.command, value, "Emitted command"));
      steps.push({ command: input, before: current, after: next });
      for (const invariant of definition.invariants) {
        if (!checks(invariant.holds, next)) throw new SpecificationError(`Invariant ${invariant.name} failed`);
      }
      for (const transition of definition.transitions) {
        const reason = refusedBy(transition, definition.name, current, next);
        if (reason !== undefined) throw new SpecificationError(reason);
      }
      current = next;
      pending.push(...validated);
    } catch (error) {
      if (error instanceof EvaluationLimit) throw new MachineLimitError(error.message);
      throw new MachineFailure<State, Command>(error instanceof Error ? error.message : String(error), steps);
    }
  }
  return { state: current, steps };
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new SpecificationError(`${name} must be a positive safe integer`);
  return result;
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

// Breadth-first search gives the shortest command sequence to a failure.
// 'held' only means all reachable states and all commands were enumerated.
export function checkMachine<State, Command>(definition: Machine<State, Command>, options: {
  readonly maxStates?: number;
  readonly maxCommands?: number;
  readonly domainLimit?: number;
} = {}): MachineReport<State, Command> {
  const maxStates = positiveLimit(options.maxStates, 10000, "maxStates");
  const domainLimit = positiveLimit(options.domainLimit, 10000, "domainLimit");
  const commands = domainOf(definition.command as AnySchema, domainLimit);
  const seen: State[] = [];
  const queue: { state: State; start: State; commands: Command[]; steps: MachineStep<State, Command>[] }[] = [];
  let incomplete: string | undefined;
  for (const start of definition.initial) {
    const broken = definition.invariants.find(invariant => !checks(invariant.holds, start));
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
      try {
        const result = runMachine(definition, path.state, command,
          options.maxCommands === undefined ? {} : { maxCommands: options.maxCommands });
        if (seen.some(state => deepEqual(state, result.state))) continue;
        if (seen.length === maxStates) {
          incomplete ??= `Reached maxStates (${maxStates}) before exploring every reachable state`;
          continue;
        }
        seen.push(result.state);
        queue.push({ state: result.state, start: path.start, commands: [...path.commands, command], steps: [...path.steps, ...result.steps] });
      } catch (error) {
        if (error instanceof MachineLimitError) {
          incomplete ??= error.message;
          continue;
        }
        return { status: "broken", states: seen.length, transitions,
          counterexample: { start: path.start, commands: [...path.commands, command],
            steps: [...path.steps, ...(error instanceof MachineFailure ? error.steps : [])],
            reason: error instanceof Error ? error.message : String(error) } };
      }
    }
  }
  if (!commands.exhaustive) incomplete ??= `Command schema could not be exhaustively enumerated within domainLimit (${domainLimit})`;
  return incomplete === undefined
    ? { status: "held", states: seen.length, transitions }
    : { status: "undetermined", states: seen.length, transitions, reason: incomplete };
}
