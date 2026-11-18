// A single executable expression describes both production transitions and
// the graph checked by exhaustive exploration. No second model can drift from
// the code that runs. Completeness requires a finite command domain.
import { SpecificationError } from "./behavior.js";
import { EvaluationLimit } from "./exact.js";
import { childrenOf, interpret, nodeOf } from "./model.js";
import type { Template } from "./model.js";
import { rootTerm } from "./rule.js";
import type { TermOf } from "./rule.js";
import type { Schema } from "./schema.js";

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
  readonly update: MachineCommand<State, Command>;
}

export function machine<State, Command>(name: string, definition: {
  readonly state: Schema<State>;
  readonly command: Schema<Command>;
  readonly initial: readonly State[];
  readonly update: (state: TermOf<State>, command: TermOf<Command>) => MachineCommand<State, Command>;
}): Machine<State, Command> {
  if (Object.hasOwn(definition, "invariants") || Object.hasOwn(definition, "transitions")) {
    throw new SpecificationError(`Machine ${name} verification properties belong in a separate specifyMachine declaration`);
  }
  if (definition.initial.length === 0) throw new SpecificationError(`Machine ${name} starts from no state`);
  const initial = definition.initial.map((value, index) => parse(definition.state, value, `Initial state ${index + 1}`));
  const update = definition.update(rootTerm<State>("state"), rootTerm<Command>("command"));
  if (!update || (!nodeOf(update) && !Object.hasOwn(update, "state"))) throw new SpecificationError(`Machine ${name} must return a state`);
  if (hasCall(update)) throw new SpecificationError(`Machine ${name} cannot call external dependencies in a transition`);
  return { kind: "machine", name, state: definition.state, command: definition.command, initial, update };
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

export class MachineFailure<State, Command> extends SpecificationError {
  constructor(message: string, readonly steps: readonly MachineStep<State, Command>[]) { super(message); }
}

export class MachineLimitError extends SpecificationError {}

// Evaluates the same expression used by the verification tools. Emissions are internal
// commands, not I/O. The caller decides when and where to persist the result.
export function runMachine<State, Command>(definition: Machine<State, Command>, state: NoInfer<State>, command: NoInfer<Command>,
  options: { readonly maxCommands?: number } = {}): MachineExecution<State, Command> {
  const maxCommands = positiveLimit(options.maxCommands, 1000, "maxCommands");
  let current = parse(definition.state, state, "Current state");
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
      current = next;
      pending.push(...validated);
    } catch (error) {
      if (error instanceof EvaluationLimit) throw new MachineLimitError(error.message);
      throw new MachineFailure<State, Command>(error instanceof Error ? error.message : String(error), steps);
    }
  }
  return { state: current, steps };
}

export function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new SpecificationError(`${name} must be a positive safe integer`);
  return result;
}

