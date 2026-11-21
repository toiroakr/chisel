// Runs of one machine that share a single state. Each run reads the state when it starts a
// command and then performs that command's effects one step at a time, and every order in which
// the steps of the runs can interleave is explored.
import { SpecificationError } from "./behavior.js";
import { deepEqual } from "./equal.js";
import { EvaluationLimit } from "./exact.js";
import { evaluateCommand, positiveLimit } from "./machine.js";
import type { EvaluatedCommand } from "./machine.js";
import type { MachineSpecification } from "./machine-check.js";
import { checks, refusedBy } from "./world.js";

export interface InterleavingStep<State, Command> {
  readonly copy: number;
  // `read` takes a snapshot of the shared state, `write` performs an effect, `run` is a command that
  // declared a state instead of effects, and `refused` is a guarded write that found the state changed.
  readonly action: "read" | "run" | "write" | "refused";
  readonly command: Command;
  readonly effect?: string;
  readonly before: State;
  readonly after: State;
}

export interface InterleavingTrace<State, Command> {
  readonly start: State;
  readonly steps: readonly InterleavingStep<State, Command>[];
  readonly reason: string;
}

export interface InterleavingReport<State, Command> {
  readonly status: "held" | "broken" | "undetermined";
  readonly states: number;
  readonly reason?: string;
  readonly counterexample?: InterleavingTrace<State, Command>;
  // How each copy ended, with the shared state they left, for every interleaving that ran to the end.
  readonly terminals: readonly { readonly statuses: readonly ("finished" | "refused")[]; readonly state: State }[];
}

interface Active<State, Command> {
  readonly command: Command;
  readonly effects: NonNullable<EvaluatedCommand<State, Command>["effects"]>;
  readonly index: number;
  readonly seen: State;
  readonly readVersion: number;
  readonly commands: readonly Command[];
}

interface Copy<State, Command> {
  readonly queue: readonly Command[];
  readonly active?: Active<State, Command>;
  readonly status: "running" | "finished" | "refused";
  readonly started: number;
}

interface Joint<State, Command> {
  readonly state: State;
  readonly version: number;
  readonly copies: readonly Copy<State, Command>[];
}

interface Node<State, Command> {
  readonly joint: Joint<State, Command>;
  readonly start: State;
  readonly parent?: number;
  readonly step?: InterleavingStep<State, Command>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

// What an effect writes onto the state as it is now: the fields it changed from what its run last saw
// (a field it left out is removed).
function written<State>(seen: State, now: State, after: State, writes?: readonly string[]): { readonly state: State; readonly wrote: boolean } {
  if (isRecord(seen) && isRecord(now) && isRecord(after)) {
    const fields = writes ?? [...new Set([...Object.keys(seen), ...Object.keys(after)])].filter(key => !deepEqual(seen[key], after[key]));
    const next: Record<string, unknown> = { ...now };
    for (const key of fields) { if (Object.hasOwn(after, key)) next[key] = after[key]; else delete next[key]; }
    return { state: next as State, wrote: fields.length > 0 };
  }
  const wrote = writes !== undefined ? writes.length > 0 : !deepEqual(seen, after);
  return { state: wrote ? after : now, wrote };
}

const keyOf = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? `${item}n` : item) ?? "undefined";

export function checkInterleavings<State, Command>(specification: MachineSpecification<State, Command>, options: {
  // The command each copy runs, one copy per entry.
  readonly copies: readonly NoInfer<Command>[];
  // The shared states to start from; the machine's initial states by default.
  readonly starts?: readonly NoInfer<State>[];
  readonly maxStates?: number;
  readonly maxCopies?: number;
  readonly maxCommands?: number;
}): InterleavingReport<State, Command> {
  const maxStates = positiveLimit(options.maxStates, 10000, "maxStates");
  const maxCopies = positiveLimit(options.maxCopies, 2, "maxCopies");
  const maxCommands = positiveLimit(options.maxCommands, 1000, "maxCommands");
  const machine = specification.machine;
  if (options.copies.length === 0) throw new SpecificationError(`Machine ${machine.name} has no copy to run`);
  if (options.copies.length > maxCopies) {
    return { status: "undetermined", states: 0, reason: `${options.copies.length} copies exceed maxCopies (${maxCopies})`, terminals: [] };
  }
  if (options.starts?.length === 0) throw new SpecificationError(`Machine ${machine.name} has no state to start from`);
  const shape = (machine.state as { shape?: object }).shape;
  const fieldNames = shape === undefined ? undefined : Object.keys(shape);
  const commands = options.copies.map((command, index) => {
    const parsed = machine.command.parse(command);
    if (!parsed.success) throw new SpecificationError(`Copy ${index}: ${parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
    return parsed.value;
  });
  const parseState = (value: unknown): State => {
    const parsed = machine.state.parse(value);
    if (!parsed.success) throw new SpecificationError(`${parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
    return parsed.value;
  };

  const nodes: Node<State, Command>[] = [];
  const seen = new Set<string>();
  const terminals = new Map<string, { statuses: ("finished" | "refused")[]; state: State }>();
  let incomplete: string | undefined;

  const trace = (index: number, extra: InterleavingStep<State, Command> | undefined, reason: string): InterleavingTrace<State, Command> => {
    const steps: InterleavingStep<State, Command>[] = extra === undefined ? [] : [extra];
    for (let current: number | undefined = index; current !== undefined; current = nodes[current]!.parent) {
      const step = nodes[current]!.step;
      if (step !== undefined) steps.unshift(step);
    }
    return { start: nodes[index]!.start, steps, reason };
  };

  const violation = (before: State, after: State): string | undefined => {
    const broken = specification.invariants.find(invariant => !checks(invariant.holds, after));
    if (broken) return `Invariant ${broken.name} failed`;
    for (const transition of specification.transitions) {
      const reason = refusedBy(transition, specification.name, before, after);
      if (reason !== undefined) return reason;
    }
    return undefined;
  };

  const advance = (joint: Joint<State, Command>, index: number): { joint: Joint<State, Command>; step: InterleavingStep<State, Command>; wrote: boolean } => {
    const copy = joint.copies[index]!;
    const replace = (next: Copy<State, Command>, state: State, version: number): Joint<State, Command> =>
      ({ state, version, copies: joint.copies.map((item, position) => position === index ? next : item) });
    const ended = (queue: readonly Command[]): "running" | "finished" => queue.length === 0 ? "finished" : "running";
    const active = copy.active;
    if (active === undefined) {
      const command = copy.queue[0]!;
      const rest = copy.queue.slice(1);
      const evaluated = evaluateCommand(machine, joint.state, command);
      const started = copy.started + 1;
      if (evaluated.effects === undefined) {
        const next = written(joint.state, joint.state, evaluated.state as State);
        const queue = [...rest, ...evaluated.commands];
        return { joint: replace({ queue, status: ended(queue), started }, parseState(next.state), joint.version + (next.wrote ? 1 : 0)),
          step: { copy: index, action: "run", command, before: joint.state, after: next.state }, wrote: next.wrote };
      }
      for (const declared of evaluated.effects) {
        const unknown = fieldNames === undefined ? undefined : declared.writes?.find(key => !fieldNames.includes(key));
        if (unknown !== undefined) throw new SpecificationError(`Effect ${declared.name} writes ${unknown}, which the state does not have`);
      }
      if (evaluated.effects.length === 0) {
        const queue = [...rest, ...evaluated.commands];
        return { joint: replace({ queue, status: ended(queue), started }, joint.state, joint.version),
          step: { copy: index, action: "read", command, before: joint.state, after: joint.state }, wrote: false };
      }
      return { joint: replace({ queue: rest, status: "running", started,
        active: { command, effects: evaluated.effects, index: 0, seen: joint.state, readVersion: joint.version, commands: evaluated.commands } }, joint.state, joint.version),
        step: { copy: index, action: "read", command, before: joint.state, after: joint.state }, wrote: false };
    }
    const effect = active.effects[active.index]!;
    const label = active.command;
    if (effect.ifUnchanged && joint.version !== active.readVersion) {
      return { joint: replace({ queue: [], status: "refused", started: copy.started }, joint.state, joint.version),
        step: { copy: index, action: "refused", command: label, effect: effect.name, before: joint.state, after: joint.state }, wrote: false };
    }
    const next = written(active.seen, joint.state, effect.state, effect.writes);
    const last = active.index === active.effects.length - 1;
    const queue = last ? [...copy.queue, ...active.commands] : copy.queue;
    const nextCopy: Copy<State, Command> = last
      ? { queue, status: ended(queue), started: copy.started }
      : { queue, status: "running", started: copy.started, active: { ...active, index: active.index + 1, seen: effect.state } };
    return { joint: replace(nextCopy, parseState(next.state), joint.version + (next.wrote ? 1 : 0)),
      step: { copy: index, action: "write", command: label, effect: effect.name, before: joint.state, after: next.state }, wrote: next.wrote };
  };

  const enqueue = (joint: Joint<State, Command>, start: State, parent: number | undefined, step: InterleavingStep<State, Command> | undefined): number | undefined => {
    const key = keyOf(joint);
    if (seen.has(key)) return undefined;
    if (nodes.length === maxStates) {
      incomplete ??= `Reached maxStates (${maxStates}) before exploring every interleaving`;
      return undefined;
    }
    seen.add(key);
    nodes.push({ joint, start, ...(parent === undefined ? {} : { parent }), ...(step === undefined ? {} : { step }) });
    return nodes.length - 1;
  };

  for (const initial of options.starts ?? machine.initial) {
    const state = parseState(initial);
    let broken: string | undefined;
    try { broken = specification.invariants.find(invariant => !checks(invariant.holds, state))?.name; }
    catch (error) { if (!(error instanceof EvaluationLimit)) throw error; incomplete ??= error.message; continue; }
    if (broken !== undefined) return { status: "broken", states: 0, terminals: [],
      counterexample: { start: state, steps: [], reason: `Initial state violates ${broken}` } };
    enqueue({ state, version: 0, copies: commands.map(command => ({ queue: [command], status: "running" as const, started: 0 })) }, state, undefined, undefined);
  }

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    const running = node.joint.copies.flatMap((copy, position) => copy.status === "running" ? [position] : []);
    if (running.length === 0) {
      const statuses = node.joint.copies.map(copy => copy.status as "finished" | "refused");
      terminals.set(keyOf([statuses, node.joint.state]), { statuses, state: node.joint.state });
      continue;
    }
    for (const position of running) {
      if (node.joint.copies[position]!.started >= maxCommands && node.joint.copies[position]!.active === undefined) {
        incomplete ??= `Copy ${position} exceeded ${maxCommands} commands`;
        continue;
      }
      let result: ReturnType<typeof advance>;
      try { result = advance(node.joint, position); }
      catch (error) {
        if (error instanceof EvaluationLimit) { incomplete ??= error.message; continue; }
        if (!(error instanceof Error)) throw error;
        return { status: "broken", states: nodes.length, terminals: [...terminals.values()],
          counterexample: trace(index, undefined, error.message) };
      }
      if (result.wrote) {
        let reason: string | undefined;
        try { reason = violation(node.joint.state, result.joint.state); }
        catch (error) { if (!(error instanceof EvaluationLimit)) throw error; incomplete ??= error.message; continue; }
        if (reason !== undefined) return { status: "broken", states: nodes.length, terminals: [...terminals.values()],
          counterexample: trace(index, result.step, reason) };
      }
      enqueue(result.joint, node.start, index, result.step);
    }
  }
  const all = [...terminals.values()];
  return incomplete === undefined
    ? { status: "held", states: nodes.length, terminals: all }
    : { status: "undetermined", states: nodes.length, reason: incomplete, terminals: all };
}
