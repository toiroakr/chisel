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

// An effect names a write to something outside the machine and the state the machine is
// in once it has succeeded. A failure leaves the state as it was before the effect (the
// writes before it stay), unless `failure` names another state.
export interface Effect<State> {
  readonly kind: "effect";
  readonly name: string;
  readonly state: State;
  readonly failure?: State;
}

export function effect<State>(name: string, state: Template<NoInfer<State>>, options: { readonly failure?: Template<NoInfer<State>> } = {}): Template<Effect<State>> {
  return { kind: "effect", name, state, ...(Object.hasOwn(options, "failure") ? { failure: options.failure } : {}) } as Template<Effect<State>>;
}

export type MachineCommand<State, Command> = Template<{
  // The state after the command, or, with `effects`, the state after the last of them.
  readonly state: State;
  // Each emitted command runs through this same transition function, in order.
  readonly commands?: readonly Command[];
} | {
  readonly effects: readonly Effect<State>[];
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
  if (!update || (!nodeOf(update) && !Object.hasOwn(update, "state") && !Object.hasOwn(update, "effects"))) throw new SpecificationError(`Machine ${name} must return a state`);
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

export interface PerformedEffect {
  readonly name: string;
  readonly outcome: "succeeded" | "failed";
}

export interface MachineStep<State, Command> {
  readonly command: Command;
  readonly before: State;
  readonly after: State;
  // Present when the command declared effects: the ones it ran, the last one failed if the command stopped.
  readonly performed?: readonly PerformedEffect[];
  // Present when the process died in the command, after this many of its effects.
  readonly died?: { readonly after: number };
}

export interface MachineExecution<State, Command> {
  readonly state: State;
  readonly steps: readonly MachineStep<State, Command>[];
}

export class MachineFailure<State, Command> extends SpecificationError {
  constructor(message: string, readonly steps: readonly MachineStep<State, Command>[]) { super(message); }
}

export class MachineLimitError<State = unknown, Command = unknown> extends SpecificationError {
  constructor(message: string, readonly steps: readonly MachineStep<State, Command>[] = []) { super(message); }
}

// Evaluates the same expression used by the verification tools. Emissions are internal
// commands, not I/O. The caller decides when and where to persist the result.
// `fails` says whether an effect fails and `dies` whether the process dies at a point of a
// command with effects (before the first, and after each); by default neither happens, since
// an effect is something the caller performs and this function only follows the machine.
export function runMachine<State, Command>(definition: Machine<State, Command>, state: NoInfer<State>, command: NoInfer<Command>,
  options: {
    readonly maxCommands?: number;
    readonly fails?: (effect: { readonly name: string; readonly index: number; readonly command: Command }) => boolean;
    readonly dies?: (point: { readonly completed: number; readonly command: Command }) => boolean;
  } = {}): MachineExecution<State, Command> {
  const maxCommands = positiveLimit(options.maxCommands, 1000, "maxCommands");
  let current = parse(definition.state, state, "Current state");
  const pending: unknown[] = [command];
  const steps: MachineStep<State, Command>[] = [];
  while (pending.length > 0) {
    if (steps.length === maxCommands) throw new MachineLimitError(`Machine ${definition.name} exceeded ${maxCommands} commands`, [...steps]);
    try {
      const input = parse(definition.command, pending.shift(), "Command");
      const output = interpret(definition.update, { state: current, command: input }) as { state?: unknown; effects?: unknown; commands?: unknown };
      if (output === null || typeof output !== "object" || (!Object.hasOwn(output, "state") && !Object.hasOwn(output, "effects"))) {
        throw new SpecificationError("A machine transition must return a state");
      }
      let next: State;
      let performed: PerformedEffect[] | undefined;
      let stopped = false;
      let died: { after: number } | undefined;
      if (Object.hasOwn(output, "effects")) {
        if (!Array.isArray(output.effects)) throw new SpecificationError("Effects must be an array");
        next = current;
        performed = [];
        const declaredEffects = output.effects as unknown[];
        for (const [index, item] of declaredEffects.entries()) {
          if (options.dies?.({ completed: index, command: input })) { died = { after: index }; stopped = true; break; }
          const declared = item as { name?: unknown; state?: unknown; failure?: unknown } | null;
          if (declared === null || typeof declared !== "object" || typeof declared.name !== "string") throw new SpecificationError("An effect must name itself");
          if (options.fails?.({ name: declared.name, index, command: input })) {
            performed.push({ name: declared.name, outcome: "failed" });
            if (Object.hasOwn(declared, "failure")) next = parse(definition.state, declared.failure, `Effect ${declared.name} failure state`);
            stopped = true;
            break;
          }
          next = parse(definition.state, declared.state, `Effect ${declared.name} state`);
          performed.push({ name: declared.name, outcome: "succeeded" });
        }
        if (!stopped && options.dies?.({ completed: declaredEffects.length, command: input })) { died = { after: declaredEffects.length }; stopped = true; }
      } else next = parse(definition.state, output.state, `Command ${steps.length + 1} next state`);
      steps.push({ command: input, before: current, after: next, ...(performed === undefined ? {} : { performed }), ...(died === undefined ? {} : { died }) });
      const emitted = output.commands === undefined || stopped ? [] : output.commands;
      if (!Array.isArray(emitted)) throw new SpecificationError("Emitted commands must be an array");
      const validated = emitted.map((value: unknown) => parse(definition.command, value, "Emitted command"));
      current = next;
      pending.push(...validated);
    } catch (error) {
      if (error instanceof EvaluationLimit) throw new MachineLimitError(error.message, [...steps]);
      throw new MachineFailure<State, Command>(error instanceof Error ? error.message : String(error), steps);
    }
  }
  return { state: current, steps };
}

export interface MachineOutcome<State, Command> {
  readonly result?: MachineExecution<State, Command>;
  readonly error?: unknown;
}

// Every way a command can end when each effect it runs may succeed or fail, found by
// replaying the run with each choice taken the other way once.
export function runMachineOutcomes<State, Command>(definition: Machine<State, Command>, state: NoInfer<State>, command: NoInfer<Command>,
  options: { readonly maxCommands?: number; readonly maxOutcomes?: number; readonly crashes?: boolean } = {}): MachineOutcome<State, Command>[] {
  const maxOutcomes = positiveLimit(options.maxOutcomes, 1000, "maxOutcomes");
  const outcomes: MachineOutcome<State, Command>[] = [];
  const tapes: boolean[][] = [[]];
  for (let next = 0; next < tapes.length; next++) {
    const tape = tapes[next]!;
    if (outcomes.length === maxOutcomes) {
      outcomes.push({ error: new MachineLimitError(`Machine ${definition.name} exceeded ${maxOutcomes} outcomes for one command`) });
      break;
    }
    const decided = tape;
    let evaluated = 0;
    const choose = () => {
      const choice = evaluated++;
      if (choice < decided.length) return decided[choice]!;
      tapes.push([...decided, ...Array.from({ length: choice - decided.length }, () => false), true]);
      return false;
    };
    const { crashes, ...limits } = options;
    try { outcomes.push({ result: runMachine(definition, state, command, { ...limits, fails: choose, ...(crashes ? { dies: choose } : {}) }) }); }
    catch (error) { outcomes.push({ error }); }
  }
  return outcomes;
}

export function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new SpecificationError(`${name} must be a positive safe integer`);
  return result;
}

