// A single executable expression describes both production transitions and
// the graph checked by exhaustive exploration. No second model can drift from
// the code that runs. Completeness requires a finite command domain.
import { SpecificationError } from "./behavior.js";
import { EvaluationLimit } from "./exact.js";
import { deepEqual } from "./equal.js";
import { childrenOf, interpret, machineBuilder, nodeOf } from "./model.js";
import type { MachineBuilder, MachineTemplate } from "./model.js";
import { machineRootTerm } from "./rule.js";
import { isTerm, termData } from "./rule.js";
import type { MachineTermOf } from "./rule.js";
import type { AnySchema, Infer, MachineCompatibleSchema, Schema } from "./schema.js";

export type MachineCommand<State, Command> = MachineTemplate<{
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

type CompatibleMachineDefinition<StateSchema extends AnySchema, CommandSchema extends AnySchema> =
  MachineCompatibleSchema<StateSchema> extends never ? { readonly ERROR_state_schema_has_no_exact_TLA_representation: never }
  : MachineCompatibleSchema<CommandSchema> extends never ? { readonly ERROR_command_schema_has_no_exact_TLA_representation: never }
  : unknown;

export function machine<StateSchema extends AnySchema, CommandSchema extends AnySchema>(name: string, definition: {
  readonly state: StateSchema;
  readonly command: CommandSchema;
  readonly initial: readonly Infer<StateSchema>[];
  readonly update: (state: MachineTermOf<Infer<StateSchema>>, command: MachineTermOf<Infer<CommandSchema>>,
    builder: MachineBuilder) => MachineCommand<Infer<StateSchema>, Infer<CommandSchema>>;
} & CompatibleMachineDefinition<StateSchema, CommandSchema>): Machine<Infer<StateSchema>, Infer<CommandSchema>> {
  if (Object.hasOwn(definition, "invariants") || Object.hasOwn(definition, "transitions")) {
    throw new SpecificationError(`Machine ${name} verification properties belong in a separate specifyMachine declaration`);
  }
  assertMachineSchema(name, "state", definition.state as AnySchema);
  assertMachineSchema(name, "command", definition.command as AnySchema);
  if (definition.initial.length === 0) throw new SpecificationError(`Machine ${name} starts from no state`);
  const initial = definition.initial.map((value, index) => parse(definition.state, value, `Initial state ${index + 1}`));
  const update = definition.update(machineRootTerm<Infer<StateSchema>>("state"),
    machineRootTerm<Infer<CommandSchema>>("command"), machineBuilder);
  if (!update || (!nodeOf(update) && !Object.hasOwn(update, "state"))) throw new SpecificationError(`Machine ${name} must return a state`);
  assertMachineExpression(name, update, definition.state as AnySchema, definition.command as AnySchema);
  return { kind: "machine", name, state: definition.state as Schema<Infer<StateSchema>>,
    command: definition.command as Schema<Infer<CommandSchema>>, initial: initial as Infer<StateSchema>[], update };
}

function assertMachineSchema(name: string, role: "state" | "command", schema: AnySchema, visited = new Set<AnySchema>()): void {
  if (visited.has(schema)) return;
  visited.add(schema);
  if (!["integer", "int64", "boolean", "string", "enum", "literal", "object", "variants", "array"].includes(schema.kind)) {
    throw new SpecificationError(`Machine ${name} ${role} schema ${schema.kind} has no exact TLA+ representation`);
  }
  if (schema.kind === "literal" && (schema as AnySchema & { readonly value: unknown }).value === null) {
    throw new SpecificationError(`Machine ${name} ${role} schema uses null, which has no TLA+ value representation`);
  }
  if (schema.kind === "object") {
    const shape = (schema as AnySchema & { readonly shape: Readonly<Record<string, AnySchema>> }).shape;
    if (Object.keys(shape).length === 0) throw new SpecificationError(`Machine ${name} ${role} schema contains an empty record`);
    for (const [field, child] of Object.entries(shape)) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) throw new SpecificationError(`Machine ${name} ${role} field ${field} is not a TLA+ identifier`);
      assertMachineSchema(name, role, child, visited);
    }
  }
  if (schema.kind === "variants") {
    const sum = schema as AnySchema & { readonly discriminant: string; readonly variants: Readonly<Record<string, { readonly shape: Readonly<Record<string, AnySchema>> }>> };
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(sum.discriminant)) throw new SpecificationError(`Machine ${name} ${role} discriminant ${sum.discriminant} is not a TLA+ identifier`);
    for (const variant of Object.values(sum.variants)) for (const [field, child] of Object.entries(variant.shape)) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) throw new SpecificationError(`Machine ${name} ${role} field ${field} is not a TLA+ identifier`);
      assertMachineSchema(name, role, child, visited);
    }
  }
  if (schema.kind === "array") assertMachineSchema(name, role,
    (schema as AnySchema & { readonly element: AnySchema }).element, visited);
}

export function isMachine(value: unknown): value is Machine<unknown, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Machine<unknown, unknown>>;
  return candidate.kind === "machine" && typeof candidate.name === "string" &&
    typeof candidate.state?.parse === "function" && typeof candidate.command?.parse === "function" &&
    Array.isArray(candidate.initial) && candidate.update !== undefined;
}

function assertMachineExpression(name: string, value: unknown, state: AnySchema, command: AnySchema): void {
  const visit = (current: unknown): void => {
    const node = nodeOf(current);
    if (node?.kind === "choose") {
      visit(node.condition);
      childrenOf(current).forEach(visit);
      return;
    }
    if (node?.kind === "bind") {
      const data = isTerm(node.value) ? termData(node.value) : undefined;
      const source = data?.kind === "position" && data.path.length === 1 ? data.path[0] : undefined;
      if ((source !== "state" || node.schema !== state) && (source !== "command" || node.schema !== command)) {
        throw new SpecificationError(`Machine ${name} can only match the complete state or command value`);
      }
      childrenOf(current).forEach(visit);
      return;
    }
    if (node?.kind === "map") {
      const data = isTerm(node.values) ? termData(node.values) : undefined;
      if (data?.kind !== "position" || data.path.length !== 1 || data.path[0] !== "state" ||
          state.kind !== "array" || (state as Schema<unknown> & { readonly element: Schema<unknown> }).element !== node.element ||
          node.output !== node.element || !safeMappedBody(node.body, node.element, node.name)) {
        throw new SpecificationError(`Machine ${name} can only map its complete array state while preserving its element schema`);
      }
      childrenOf(current).forEach(visit);
      return;
    }
    if (node) throw new SpecificationError(`Machine ${name} cannot use ${node.kind} in an executable transition`);
    if (isTerm(current)) {
      const data = termData(current);
      const measures = data.kind === "position" ? [data.measure] : data.parts.map(part => part.measure);
      if (measures.some(measure => measure !== "value")) {
        throw new SpecificationError(`Machine ${name} cannot use transformed or measured terms in an executable transition`);
      }
      return;
    }
    if (current === null || typeof current !== "object") return;
    for (const child of Object.values(current)) visit(child);
  };
  visit(value);
}

function safeMappedBody(value: unknown, schema: Schema<unknown>, element: string): boolean {
  const node = nodeOf(value);
  if (node?.kind === "choose") return safeMappedBody(node.yes, schema, element) && safeMappedBody(node.no, schema, element);
  if (node) return false;
  if (isTerm(value)) {
    const data = termData(value);
    return data.kind === "position" && data.path.length === 1 && data.path[0] === element;
  }
  const parsed = schema.parse(value);
  return parsed.success && deepEqual(parsed.value, value);
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

export class MachineLimitError<State = unknown, Command = unknown> extends SpecificationError {
  constructor(message: string, readonly steps: readonly MachineStep<State, Command>[] = []) { super(message); }
}

// Evaluates the same expression used by the verification tools. Emissions are internal
// commands, not I/O. The caller decides when and where to persist the result.
export function runMachine<State, Command>(definition: Machine<State, Command>, state: NoInfer<State>, command: NoInfer<Command>,
  options: { readonly maxCommands?: number } = {}): MachineExecution<State, Command> {
  const maxCommands = positiveLimit(options.maxCommands, 1000, "maxCommands");
  let current = parse(definition.state, state, "Current state");
  const pending: unknown[] = [command];
  const steps: MachineStep<State, Command>[] = [];
  while (pending.length > 0) {
    if (steps.length === maxCommands) throw new MachineLimitError(`Machine ${definition.name} exceeded ${maxCommands} commands`, [...steps]);
    try {
      const input = parse(definition.command, pending.shift(), "Command");
      const output = interpret(definition.update, { state: current, command: input }) as { state: unknown; commands?: unknown };
      if (output === null || typeof output !== "object" || !Object.hasOwn(output, "state")) {
        throw new SpecificationError("A machine transition must return a state");
      }
      const next = parse(definition.state, output.state, `Command ${steps.length + 1} next state`);
      steps.push({ command: input, before: current, after: next });
      const emitted = output.commands === undefined ? [] : output.commands;
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

export function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new SpecificationError(`${name} must be a positive safe integer`);
  return result;
}

