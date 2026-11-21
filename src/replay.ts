// Replays the runs of a machine against code that implements the same behaviour, to find where the two drift apart.
import { SpecificationError } from "./behavior.js";
import { domainOf } from "./domain.js";
import { deepEqual } from "./equal.js";
import { EvaluationLimit } from "./exact.js";
import { isMachine, positiveLimit, runMachine, runMachineOutcomes } from "./machine.js";
import type { Machine, MachineOutcome, MachineStep } from "./machine.js";
import { isMachineSpecification, specifyMachine } from "./machine-check.js";
import type { MachineSpecification } from "./machine-check.js";
import { tagOf } from "./schema.js";
import type { AnySchema } from "./schema.js";
import { checks, copyOf } from "./world.js";

// What the machine did to a command that the code is asked to do the same to: an effect that failed
// (`index` is its place in the command's effects) or the process dying after `after` effects. `step`
// is the place of `command` among the commands the run executed (0 is the one replayed, the rest are
// the ones it emitted), which tells apart the occurrences of a command emitted more than once.
export type ReplayFault<Command> =
  | { readonly kind: "fails"; readonly effect: string; readonly index: number; readonly command: Command; readonly step: number }
  | { readonly kind: "dies"; readonly after: number; readonly command: Command; readonly step: number };

export interface MachineSubject<State, Command> {
  // Puts the code, with its external parts faked, in `state`: every sequence is replayed from a start of the machine.
  readonly reset: (state: State) => void | Promise<void>;
  // Applies one command, injecting the faults listed. It may throw.
  readonly run: (command: Command, faults: readonly ReplayFault<Command>[]) => void | Promise<void>;
  // The state the code is in, read back after every command.
  readonly read: () => State | Promise<State>;
}

export interface ReplayStep<State, Command> {
  readonly command: Command;
  readonly faults: readonly ReplayFault<Command>[];
  readonly expected: State;
  // Absent when what the code answered is no state of the machine.
  readonly actual?: State;
  readonly threw?: string;
}

export interface MachineReplayReport<State, Command> {
  readonly status: "passed" | "failed" | "undetermined";
  // How many sequences were replayed, each from a reset.
  readonly replayed: number;
  readonly states: number;
  readonly reason?: string;
  // The first sequence after which the code and the machine disagree: its last step is where.
  readonly failure?: { readonly start: State; readonly steps: readonly ReplayStep<State, Command>[]; readonly reason: string };
}

interface Node<State, Command> {
  readonly state: State;
  readonly start: State;
  readonly parent?: number;
  readonly command?: Command;
  readonly faults: readonly ReplayFault<Command>[];
  readonly mayThrow: boolean;
}

const show = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? `${item}n` : item) ?? "undefined";

// A key that does not depend on the order fields were written in, since two states `deepEqual` takes as one may differ in it.
const bucketOf = (value: unknown) => JSON.stringify(value, (_key, item) => {
  if (typeof item === "bigint") return `${item}n`;
  return item !== null && typeof item === "object" && !Array.isArray(item) && Object.getPrototypeOf(item) === Object.prototype
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : item;
}) ?? "undefined";

function faultsOf<State, Command>(steps: readonly MachineStep<State, Command>[]): ReplayFault<Command>[] {
  return steps.flatMap((step, position) => [
    ...(step.performed ?? []).flatMap((item, index) => item.outcome === "failed" ? [{ kind: "fails" as const, effect: item.name, index, command: step.command, step: position }] : []),
    ...(step.died === undefined ? [] : [{ kind: "dies" as const, after: step.died.after, command: step.command, step: position }]),
  ]);
}

// Every command is replayed after the shortest sequence to each state the machine reaches, so every
// transition the model was explored through is run against the code, and the first disagreement
// found is on a shortest sequence.
export async function replayMachine<State, Command>(target: Machine<State, Command> | MachineSpecification<State, Command>,
  subject: MachineSubject<NoInfer<State>, NoInfer<Command>>, options: {
    readonly faults?: boolean;
    readonly maxReplays?: number;
    readonly maxStates?: number;
    readonly maxCommands?: number;
    readonly maxOutcomes?: number;
    readonly domainLimit?: number;
  } = {}): Promise<MachineReplayReport<State, Command>> {
  if (!isMachine(target) && !isMachineSpecification(target)) throw new SpecificationError("replayMachine takes a machine or its specification");
  const specification = (isMachineSpecification(target) ? target : specifyMachine(target as Machine<State, Command>)) as MachineSpecification<State, Command>;
  const machine = specification.machine;
  for (const name of ["reset", "run", "read"] as const) {
    if (typeof subject[name] !== "function") throw new SpecificationError(`The subject has no ${name} function`);
  }
  if (options.faults !== undefined && typeof options.faults !== "boolean") throw new SpecificationError("faults must be a boolean");
  const injectFaults = options.faults ?? true;
  const maxReplays = positiveLimit(options.maxReplays, 10000, "maxReplays");
  const maxStates = positiveLimit(options.maxStates, 10000, "maxStates");
  const maxCommands = positiveLimit(options.maxCommands, 1000, "maxCommands");
  const maxOutcomes = positiveLimit(options.maxOutcomes, 1000, "maxOutcomes");
  const domainLimit = positiveLimit(options.domainLimit, 10000, "domainLimit");
  const commands = domainOf(machine.command as AnySchema, domainLimit);

  const nodes: Node<State, Command>[] = [];
  const known = new Map<string, State[]>();
  const contains = (state: State) => (known.get(bucketOf(state)) ?? []).some(other => deepEqual(other, state));
  const remember = (state: State) => known.set(bucketOf(state), [...known.get(bucketOf(state)) ?? [], state]);
  let incomplete: string | undefined;
  let replayed = 0;

  const labelOf = (command: Command) => tagOf(machine.command as never, command) ?? (typeof command === "string" ? command : show(command));
  const chainTo = (index: number | undefined, last?: Node<State, Command>): Node<State, Command>[] => {
    const chain: Node<State, Command>[] = last === undefined ? [] : [last];
    for (let current = index; current !== undefined; current = nodes[current]!.parent) {
      if (nodes[current]!.parent !== undefined) chain.unshift(nodes[current]!);
    }
    return chain;
  };

  const replay = async (start: State, chain: readonly Node<State, Command>[]): Promise<MachineReplayReport<State, Command>["failure"]> => {
    await subject.reset(copyOf(start));
    const steps: ReplayStep<State, Command>[] = [];
    const fail = (reason: string) => ({ start, steps, reason });
    const sequence = () => steps.map(step => labelOf(step.command)).join(", ");
    for (const item of chain) {
      let threw: string | undefined;
      try { await subject.run(item.command!, item.faults); }
      catch (error) { threw = error instanceof Error ? error.message : String(error); }
      const read = machine.state.parse(await subject.read());
      const step: ReplayStep<State, Command> = { command: item.command!, faults: item.faults, expected: item.state,
        ...(read.success ? { actual: read.value } : {}), ...(threw === undefined ? {} : { threw }) };
      steps.push(step);
      if (threw !== undefined && !item.mayThrow) return fail(`${labelOf(item.command!)} threw ${show(threw)} although the machine runs it`);
      if (!read.success) return fail(`After ${sequence()} the subject reads a state the machine does not allow: ${read.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
      if (!deepEqual(item.state, read.value)) return fail(`After ${sequence()} the machine reaches ${show(item.state)} but the subject reads ${show(read.value)}`);
    }
    return undefined;
  };

  const outcomesOf = (state: State, command: Command): MachineOutcome<State, Command>[] => {
    if (injectFaults) return runMachineOutcomes(machine, state, command, { maxCommands, maxOutcomes, crashes: specification.crashes });
    try { return [{ result: runMachine(machine, state, command, { maxCommands }) }]; }
    catch (error) { return [{ error }]; }
  };

  for (const start of machine.initial) {
    if (contains(start)) continue;
    if (nodes.length === maxStates) { incomplete ??= `Reached maxStates (${maxStates}) before exploring every initial state`; continue; }
    remember(start);
    nodes.push({ state: start, start, faults: [], mayThrow: false });
  }
  for (let index = 0; index < nodes.length; index++) {
    const path = nodes[index]!;
    for (const command of commands.values as Command[]) {
      for (const outcome of outcomesOf(path.state, command)) {
        if (outcome.result === undefined) {
          incomplete ??= outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          continue;
        }
        const faults = faultsOf(outcome.result.steps);
        if (faults.length > 0 && !injectFaults) continue;
        let refused: boolean;
        try {
          refused = outcome.result.steps.some(step => {
            const tag = tagOf(machine.command as never, step.command);
            const precondition = tag === undefined ? undefined : specification.requires[tag];
            return precondition !== undefined && !checks(precondition, { state: step.before, command: step.command });
          });
        } catch (error) {
          if (!(error instanceof EvaluationLimit)) throw error;
          incomplete ??= error.message;
          continue;
        }
        if (replayed === maxReplays) {
          return { status: "undetermined", replayed, states: nodes.length, reason: `Reached maxReplays (${maxReplays}) before replaying every sequence` };
        }
        replayed++;
        const next: Node<State, Command> = { state: outcome.result.state, start: path.start, parent: index, command, faults, mayThrow: faults.length > 0 || refused };
        const failure = await replay(path.start, chainTo(index, next));
        if (failure !== undefined) return { status: "failed", replayed, states: nodes.length, failure };
        if (contains(next.state)) continue;
        if (nodes.length === maxStates) { incomplete ??= `Reached maxStates (${maxStates}) before exploring every reachable state`; continue; }
        remember(next.state);
        nodes.push(next);
      }
    }
  }
  if (!commands.exhaustive) incomplete ??= `Command schema could not be exhaustively enumerated within domainLimit (${domainLimit})`;
  return incomplete === undefined
    ? { status: "passed", replayed, states: nodes.length }
    : { status: "undetermined", replayed, states: nodes.length, reason: incomplete };
}
