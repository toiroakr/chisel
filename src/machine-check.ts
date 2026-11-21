import { domainOf } from "./domain.js";
import { EvaluationLimit } from "./exact.js";
import { deepEqual } from "./equal.js";
import { MachineFailure, MachineLimitError, isMachine, positiveLimit, runMachineOutcomes } from "./machine.js";
import type { Machine, MachineExecution, MachineStep } from "./machine.js";
import { rootTerm } from "./rule.js";
import type { TermOf } from "./rule.js";
import { isVariantsSchema, tagOf } from "./schema.js";
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
  readonly requires: Readonly<Record<string, unknown>>;
  readonly columns: readonly string[];
  readonly crashes: boolean;
  readonly interleavings?: { readonly copies: readonly Command[]; readonly starts?: readonly State[]; readonly maxCopies?: number };
}

// The key every command carries as a literal: the tag that tells the commands apart.
type DiscriminantOf<Command> = { [Key in keyof Command]-?: Command[Key] extends string ? (string extends Command[Key] ? never : Key) : never }[keyof Command];
type CommandTags<Command> = Command[DiscriminantOf<Command>] & string;
type CommandCase<Command, Tag extends string, Key = DiscriminantOf<Command>> =
  Command extends unknown ? (Key extends keyof Command ? (Tag extends Command[Key] ? Command : never) : never) : never;

// A command's precondition: the states and commands in which it is meant to change the state.
export type Requires<State, Command> = {
  readonly [Tag in CommandTags<Command>]?: (state: TermOf<State>, command: TermOf<CommandCase<Command, Tag>>) => unknown;
};

export function specifyMachine<State, Command>(machine: Machine<State, Command>, properties: {
  readonly name?: string;
  readonly invariants?: readonly Invariant[];
  readonly transitions?: readonly Transition[];
  readonly requires?: Requires<State, Command>;
  readonly columns?: readonly (keyof State & string)[];
  // Also explore the process dying before the first effect of a command and after each effect.
  readonly crashes?: boolean;
  // Also check copies of the machine running at once on one shared state (`checkInterleavings`),
  // one copy per command listed.
  readonly interleavings?: { readonly copies: readonly NoInfer<Command>[]; readonly starts?: readonly NoInfer<State>[]; readonly maxCopies?: number };
} = {}): MachineSpecification<State, Command> {
  const names = [...properties.invariants ?? [], ...properties.transitions ?? []].map(item => item.name);
  const repeated = names.find((item, index) => names.indexOf(item) !== index);
  if (repeated !== undefined) throw new SpecificationError(`Machine ${machine.name} names property ${repeated} more than once`);
  for (const transition of properties.transitions ?? []) {
    if (transition.each) pairable(machine.name, machine.state as AnySchema, transition);
  }
  const commandSchema = machine.command as AnySchema;
  const tags = isVariantsSchema(commandSchema) ? commandSchema.variantTags : [];
  const requires: Record<string, unknown> = {};
  for (const [tag, precondition] of Object.entries(properties.requires ?? {}) as [string, (state: unknown, command: unknown) => unknown][]) {
    if (!tags.includes(tag)) throw new SpecificationError(`Machine ${machine.name} declares no command ${tag}`);
    requires[tag] = precondition(rootTerm("state"), rootTerm("command"));
  }
  const stateSchema = machine.state as AnySchema;
  const fields = isVariantsSchema(stateSchema) ? [stateSchema.discriminant] : Object.keys((stateSchema as { shape?: object }).shape ?? {});
  for (const column of properties.columns ?? []) {
    if (!fields.includes(column)) throw new SpecificationError(`Machine ${machine.name} has no state field ${column} to use as a column`);
  }
  if (properties.interleavings !== undefined) {
    if (properties.interleavings.copies.length === 0) throw new SpecificationError(`Machine ${machine.name} has no copy to run`);
    if (properties.interleavings.starts?.length === 0) throw new SpecificationError(`Machine ${machine.name} has no state to start from`);
    properties.interleavings.starts?.forEach((start, index) => {
      const parsed = machine.state.parse(start);
      if (!parsed.success) throw new SpecificationError(`Start ${index}: ${parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
    });
    properties.interleavings.copies.forEach((command, index) => {
      const parsed = machine.command.parse(command);
      if (!parsed.success) throw new SpecificationError(`Copy ${index}: ${parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
    });
  }
  return { kind: "machine-specification", name: properties.name ?? machine.name, machine,
    invariants: properties.invariants ?? [], transitions: properties.transitions ?? [], requires, columns: properties.columns ?? [], crashes: properties.crashes ?? false,
    ...(properties.interleavings === undefined ? {} : { interleavings: properties.interleavings }) };
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

// "unknown" is a cell no command run reached, such as one cut off by a limit.
export type Occurrence = "always" | "sometimes" | "never" | "unknown";

// What each command does in the states that share the values of the columns.
export interface MachineMatrix<Command> {
  readonly columns: readonly string[];
  readonly rows: readonly {
    readonly state: Readonly<Record<string, unknown>>;
    readonly cells: readonly { readonly command: Command; readonly changes: Occurrence; readonly precondition?: Occurrence }[];
  }[];
}

export interface MachineReport<State, Command> {
  readonly status: "held" | "broken" | "undetermined";
  readonly states: number;
  readonly transitions: number;
  readonly reason?: string;
  readonly counterexample?: MachineTrace<State, Command>;
  readonly matrix?: MachineMatrix<Command>;
}

function violation<State, Command>(specification: MachineSpecification<State, Command>, steps: readonly MachineStep<State, Command>[]): string | undefined {
  for (const step of steps) {
    const failed = step.performed?.find(item => item.outcome === "failed");
    const stopped = failed !== undefined || step.died !== undefined;
    const tag = tagOf(specification.machine.command as never, step.command);
    const cause = failed !== undefined ? `${failed.name} failed` : step.died === undefined ? undefined
      : `${tag ?? (typeof step.command === "string" ? step.command : "the command")} died ${step.died.after === 0 ? "before its first effect" : `after effect ${step.died.after} (${step.performed![step.died.after - 1]!.name})`}`;
    const after = (reason: string) => cause === undefined ? reason : `${reason} after ${cause}`;
    const broken = specification.invariants.find(invariant => !checks(invariant.holds, step.after));
    if (broken) return after(`Invariant ${broken.name} failed`);
    for (const transition of specification.transitions) {
      const reason = refusedBy(transition, specification.name, step.before, step.after);
      if (reason !== undefined) return after(reason);
    }
    const precondition = tag === undefined ? undefined : specification.requires[tag];
    if (precondition !== undefined) {
      const held = checks(precondition, { state: step.before, command: step.command });
      const changed = !deepEqual(step.before, step.after);
      if (!held && changed) return after(`${tag} changed the state although its precondition was false`);
      // A command that stopped at a failed effect may have written nothing yet.
      if (held && !changed && !stopped) return `${tag} left the state unchanged although its precondition held`;
    }
  }
  return undefined;
}

// Breadth-first search gives the shortest command sequence to a failure.
export function checkMachine<State, Command>(specification: MachineSpecification<State, Command>, options: {
  readonly maxStates?: number;
  readonly maxCommands?: number;
  readonly maxOutcomes?: number;
  readonly domainLimit?: number;
} = {}): MachineReport<State, Command> {
  const maxStates = positiveLimit(options.maxStates, 10000, "maxStates");
  const domainLimit = positiveLimit(options.domainLimit, 10000, "domainLimit");
  const maxCommands = positiveLimit(options.maxCommands, 1000, "maxCommands");
  const maxOutcomes = positiveLimit(options.maxOutcomes, 1000, "maxOutcomes");
  const commands = domainOf(specification.machine.command as AnySchema, domainLimit);
  const commandList = commands.values as Command[];
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
  const tabulated = new Map<string, { state: Record<string, unknown>; cells: { changes: Set<boolean>; precondition: Set<boolean> }[] }>();
  const tabulate = (state: State, commandIndex: number, changed: boolean, precondition: boolean | undefined) => {
    const projected = Object.fromEntries(specification.columns.map(column => [column, (state as Record<string, unknown>)[column]]));
    const key = keyOf(projected as State);
    const row = tabulated.get(key) ?? { state: projected, cells: commandList.map(() => ({ changes: new Set<boolean>(), precondition: new Set<boolean>() })) };
    tabulated.set(key, row);
    row.cells[commandIndex]!.changes.add(changed);
    if (precondition !== undefined) row.cells[commandIndex]!.precondition.add(precondition);
  };
  const occurrence = (seen: Set<boolean>): Occurrence => seen.size === 2 ? "sometimes" : seen.has(true) ? "always" : seen.has(false) ? "never" : "unknown";
  const matrix = (): { matrix?: MachineMatrix<Command> } => specification.columns.length === 0 ? {} : { matrix: {
    columns: specification.columns,
    rows: [...tabulated.values()].map(row => ({ state: row.state, cells: row.cells.map((cell, index) => ({
      command: commandList[index]!, changes: occurrence(cell.changes),
      ...(cell.precondition.size === 0 ? {} : { precondition: occurrence(cell.precondition) }),
    })) })),
  } };
  let transitions = 0;
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index]!;
    for (const [commandIndex, command] of commandList.entries()) {
      for (const outcome of runMachineOutcomes(specification.machine, path.state, command, { maxCommands, maxOutcomes, crashes: specification.crashes })) {
        transitions++;
        const result = outcome.result;
        const failure = outcome.error;
        const steps: readonly MachineStep<State, Command>[] = result?.steps ??
          (failure instanceof MachineFailure || failure instanceof MachineLimitError ? failure.steps as MachineStep<State, Command>[] : []);
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
        if (specification.columns.length > 0) {
          const tag = tagOf(specification.machine.command as never, command);
          const precondition = tag === undefined ? undefined : specification.requires[tag];
          tabulate(path.state, commandIndex, !deepEqual(path.state, result.state),
            precondition === undefined ? undefined : checks(precondition, { state: path.state, command }));
        }
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
  }
  if (!commands.exhaustive) incomplete ??= `Command schema could not be exhaustively enumerated within domainLimit (${domainLimit})`;
  return incomplete === undefined
    ? { status: "held", states: stateCount, transitions, ...matrix() }
    : { status: "undetermined", states: stateCount, transitions, reason: incomplete, ...matrix() };
}
