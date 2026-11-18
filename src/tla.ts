import { check as checkTla, formatValue, prove as proveTla } from "tla-ts";
import { SpecificationError } from "./behavior.js";
import { domainOf, integralBounds } from "./domain.js";
import { nodeOf } from "./model.js";
import type { Machine } from "./machine.js";
import { schemaAtPath } from "./schema.js";
import type { AnySchema, AnyVariantsSchema, ArraySchema, EnumSchema, LiteralSchema, ObjectSchema, ObjectShape } from "./schema.js";
import { isTerm, termData } from "./rule.js";
import type { Rule, TermData } from "./rule.js";

export interface TlaModule {
  readonly name: string;
  readonly source: string;
  readonly config: string;
  readonly states: number;
  readonly commands: number;
}

type Names = ReadonlyMap<string, string>;

// Compiles the executable expression itself. No sampled transition table is
// substituted for it: tla-ts evaluates Step and the invariant independently.
export function toTla<State, Command>(machine: Machine<State, Command>, options: {
  readonly domainLimit?: number;
  readonly maxCommands?: number;
} = {}): TlaModule {
  const limit = options.domainLimit ?? 10000;
  const maxCommands = options.maxCommands ?? 1000;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new SpecificationError("domainLimit must be a positive safe integer");
  if (!Number.isSafeInteger(maxCommands) || maxCommands < 1) throw new SpecificationError("maxCommands must be a positive safe integer");
  const states = domainOf(machine.state as never, limit);
  const commands = domainOf(machine.command as never, limit);
  if (!states.exhaustive || !commands.exhaustive) {
    throw new SpecificationError("TLA+ translation requires finite, exhaustively enumerated state and command schemas");
  }
  if (commands.values.length === 0) throw new SpecificationError("TLA+ translation requires at least one command");
  const compiler = new Compiler();
  const name = `Chisel${machine.name.replace(/[^A-Za-z0-9]+/g, " ").split(" ").filter(Boolean).map(part => part[0]!.toUpperCase() + part.slice(1)).join("") || "Machine"}`;
  const step = compiler.value(machine.update, new Map([["state", "s"], ["command", "c"]]), true);
  const properties = machine.invariants.map((invariant, index) => ({
    name: `Inv${index}`,
    formula: compiler.condition(invariant.holds, new Map(), "state"),
  }));
  const transitions = machine.transitions.map((transition, index) => ({ name: `Transition${index}`,
    formula: transition.each
      ? compiler.paired(transition.holds, transition.each, schemaAtPath(machine.state as never, transition.each.path)?.kind)
      : compiler.condition(transition.holds, new Map([["before", "previous"], ["after", "state"]]), "state") }));
  const stateSet = set(states.values.map(value => compiler.value(value, new Map())));
  const commandSet = set(commands.values.map(value => compiler.value(value, new Map())));
  const initial = set(machine.initial.map(value => compiler.value(value, new Map())));
  const source = [
    `---- MODULE ${name} ----`,
    "EXTENDS Naturals, Integers, Sequences",
    "VARIABLES state, pending, previous, depth",
    `MaxCommands == ${maxCommands}`,
    `StateDomain == ${stateSet}`,
    `CommandDomain == ${commandSet}`,
    `Step(s, c) == ${step}`,
    `Init == /\\ state \\in ${initial} /\\ pending = <<>> /\\ previous = state /\\ depth = 0`,
    "Next == \\/ (\\E c \\in CommandDomain: /\\ pending = <<>> /\\ state' = Step(state, c).state /\\ pending' = Step(state, c).commands /\\ previous' = state /\\ depth' = 1)",
    "        \\/ (/\\ Len(pending) > 0 /\\ state' = Step(state, Head(pending)).state /\\ pending' = Tail(pending) \\o Step(state, Head(pending)).commands /\\ previous' = state /\\ depth' = depth + 1)",
    "TypeOK == /\\ state \\in StateDomain /\\ \\A i \\in 1..Len(pending): pending[i] \\in CommandDomain",
    "Budget == depth <= MaxCommands",
    ...properties.map(item => `${item.name} == ${item.formula}`),
    ...transitions.map(item => `${item.name} == previous = state \\/ (${item.formula})`),
    "====",
  ].join("\n");
  const config = `INIT Init NEXT Next INVARIANT TypeOK INVARIANT Budget ${properties.map(item => `INVARIANT ${item.name}`).join(" ")} ${transitions.map(item => `INVARIANT ${item.name}`).join(" ")} CHECK_DEADLOCK FALSE`;
  return { name, source, config, states: states.values.length, commands: commands.values.length };
}

export async function checkMachineTla<State, Command>(machine: Machine<State, Command>, options: {
  readonly domainLimit?: number;
  readonly maxCommands?: number;
} = {}): Promise<{ readonly status: "held" | "broken" | "undetermined"; readonly states: number; readonly transitions: number;
  readonly reason?: string; readonly trace?: readonly { readonly action?: string; readonly state: string; readonly pending: string }[];
  readonly module?: TlaModule }> {
  let module: TlaModule;
  try { module = toTla(machine, options); }
  catch (error) {
    if (error instanceof SpecificationError) return { status: "undetermined", states: 0, transitions: 0, reason: error.message };
    throw error;
  }
  const result = await checkTla({ source: module.source, config: module.config });
  if (result.status === "success") return { status: "held", states: result.distinctStates, transitions: result.generatedStates, module };
  if (result.status === "invariant-violation" && result.violation?.name === "Budget") return {
    status: "undetermined", states: result.distinctStates, transitions: result.generatedStates,
    reason: `TLA+ exploration exceeded maxCommands (${options.maxCommands ?? 1000})`, module,
  };
  if (result.status === "invariant-violation") return { status: "broken", states: result.distinctStates,
    transitions: result.generatedStates,
    reason: /^Inv\d+$/.test(result.violation?.name ?? "")
      ? machine.invariants[Number(result.violation!.name.slice(3))]?.name ?? result.violation!.name
      : result.violation?.name ?? "An invariant was violated",
    ...(result.violation === undefined ? {} : { trace: result.violation.trace.map(step => ({
      ...(step.action === undefined ? {} : { action: step.action }),
      state: formatValue(step.state.state!), pending: formatValue(step.state.pending!),
    })) }), module };
  return { status: "undetermined", states: result.distinctStates, transitions: result.generatedStates,
    reason: `tla-ts could not complete the check: ${result.status}${result.failure ? `: ${result.failure.message}` : ""}`, module };
}

export interface InductiveProof {
  readonly status: "proved" | "undetermined";
  readonly obligations: readonly { readonly name: string; readonly status: "proved" | "undetermined"; readonly reason?: string }[];
  readonly source?: string;
  readonly reason?: string;
}

// This is a universal inductive proof, not finite-state model checking. A
// theorem is reported proved only when tla-ts discharges its obligation.
export async function proveMachine<State, Command>(machine: Machine<State, Command>): Promise<InductiveProof> {
  let source: string;
  const names = ["initial", "state contract", "emitted commands", ...machine.invariants.map(item => item.name), ...machine.transitions.map(item => item.name)];
  try {
    const compiler = new Compiler();
    const step = compiler.value(machine.update, new Map([["state", "s"], ["command", "c"]]), true);
    const stateOK = compiler.schema(machine.state as AnySchema, "s");
    const commandOK = compiler.schema(machine.command as AnySchema, "c");
    const invariants = machine.invariants.map((item, index) => ({ name: `Inv${index}`,
      formula: compiler.condition(item.holds, new Map(), "s") }));
    const assumption = ["StateOK(s)", "CommandOK(c)", ...invariants.map(item => `${item.name}(s)`)].join(" /\\ ");
    const defs = ["Step", "StateOK", "CommandOK", ...invariants.map(item => item.name)].join(", ");
    const output = "Step(s, c)";
    const transitions = machine.transitions.map(item => item.each
      ? compiler.paired(item.holds, item.each, schemaAtPath(machine.state as never, item.each.path)?.kind, "s", `${output}.state`)
      : compiler.condition(item.holds, new Map([["before", "s"], ["after", `${output}.state`]]), "s"));
    const formulae = [
      `\\A s: InitState(s) => (StateOK(s)${invariants.map(item => ` /\\ ${item.name}(s)`).join("")})`,
      `\\A s, c: (${assumption}) => StateOK(${output}.state)`,
      `\\A s, c: (${assumption}) => \\A i \\in 1..Len(${output}.commands): CommandOK(${output}.commands[i])`,
      ...invariants.map(item => `\\A s, c: (${assumption}) => ${item.name}(${output}.state)`),
      ...transitions.map(formula => `\\A s, c: (${assumption}) => (s = ${output}.state \\/ (${formula}))`),
    ];
    source = [
      "---- MODULE ChiselInduction ----",
      "EXTENDS Naturals, Integers, Sequences",
      `Step(s, c) == ${step}`,
      `StateOK(s) == ${stateOK}`,
      `CommandOK(c) == ${commandOK}`,
      `InitState(s) == s \\in ${set(machine.initial.map(value => compiler.value(value, new Map())))}`,
      ...invariants.map(item => `${item.name}(s) == ${item.formula}`),
      ...formulae.map((formula, index) => `THEOREM ${formula} PROOF BY DEF ${index === 0 ? `InitState, StateOK${invariants.map(item => `, ${item.name}`).join("")}` : defs}`),
      "====",
    ].join("\n");
  } catch (error) {
    if (error instanceof SpecificationError) return { status: "undetermined", obligations: [], reason: error.message };
    throw error;
  }
  let result: Awaited<ReturnType<typeof proveTla>>;
  try { result = await proveTla({ source }); }
  catch (error) { return { status: "undetermined", obligations: [], source,
    reason: error instanceof Error ? error.message : String(error) }; }
  const obligations = result.obligations.map((obligation, index) => ({ name: names[index] ?? `obligation ${index + 1}`,
    status: obligation.status === "proved" || obligation.status === "trivial" ? "proved" as const : "undetermined" as const,
    ...(obligation.status === "failed" || obligation.status === "unsupported" ? { reason: obligation.reason } : {}),
  }));
  return { status: obligations.length === names.length && result.missingProofCount === 0 && result.omittedProofCount === 0 && obligations.every(item => item.status === "proved") ? "proved" : "undetermined",
    obligations, source };
}

function set(values: readonly string[]): string {
  return `{${values.join(", ")}}`;
}

class Compiler {
  private next = 0;

  value(value: unknown, names: Names, result = false): string {
    if (isTerm(value)) return this.term(termData(value), names);
    const node = nodeOf(value);
    if (node?.kind === "choose") return `(IF ${this.rule(node.condition, names)} THEN ${this.value(node.yes, names, result)} ELSE ${this.value(node.no, names, result)})`;
    if (node?.kind === "bind") {
      const local = `local${this.next++}`;
      return `(LET ${local} == ${this.value(node.value, names)} IN ${this.value(node.body, new Map([...names, [node.name, local]]), result)})`;
    }
    if (node?.kind === "map") {
      const sequence = this.value(node.values, names);
      const index = `index${this.next++}`;
      const body = this.value(node.body, new Map([...names, [node.name, `${sequence}[${index}]`]]));
      return `[${index} \\in 1..Len(${sequence}) |-> ${body}]`;
    }
    if (node?.kind === "construct") return this.value(node.value, names, result);
    if (node?.kind === "operation" && ["add", "subtract", "multiply"].includes(node.operator)) {
      const symbol = node.operator === "add" ? "+" : node.operator === "subtract" ? "-" : "*";
      return `(${this.value(node.left, names)} ${symbol} ${this.value(node.right, names)})`;
    }
    if (node) throw new SpecificationError(`TLA+ translation does not support ${node.kind}${"operator" in node ? ` ${node.operator}` : ""}`);
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "boolean") return String(value).toUpperCase();
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    if (Array.isArray(value)) return `<<${value.map(item => this.value(item, names)).join(", ")}>>`;
    if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      const fields = Object.entries(value);
      if (result && !fields.some(([key]) => key === "commands")) fields.push(["commands", []]);
      if (!fields.length) throw new SpecificationError("TLA+ translation cannot represent an empty record");
      return `[${fields.map(([key, child]) => `${identifier(key)} |-> ${this.value(child, names)}`).join(", ")}]`;
    }
    throw new SpecificationError(`TLA+ translation cannot represent ${String(value)}`);
  }

  condition(value: unknown, names: Names, self: string): string {
    if (value !== null && typeof value === "object" && "kind" in value &&
      ["compare", "all", "any", "and", "or", "not"].includes(String(value.kind))) return this.rule(value as Rule, names, self);
    return this.value(value, new Map([...names, ["", self]]));
  }

  paired(condition: unknown, each: { readonly path: readonly string[]; readonly by?: string }, kind: string | undefined,
    beforeRoot = "previous", afterRoot = "state"): string {
    const before = each.path.reduce((root, field) => `${root}.${identifier(field)}`, `(${beforeRoot})`);
    const after = each.path.reduce((root, field) => `${root}.${identifier(field)}`, `(${afterRoot})`);
    if (kind === "record") {
      const earlier = `${before}[key]`, later = `${after}[key]`;
      const rule = this.condition(condition, new Map([["before", earlier], ["after", later]]), later);
      return `(\\A key \\in (DOMAIN ${before} \\cap DOMAIN ${after}): ${earlier} = ${later} \\/ (${rule}))`;
    }
    if (kind !== "array" || each.by === undefined) throw new SpecificationError("TLA+ translation cannot pair this collection");
    const key = identifier(each.by);
    const bi = `${before}[i]`, aj = `${after}[j]`;
    const rule = this.condition(condition, new Map([["before", bi], ["after", aj]]), aj);
    const unique = (collection: string) => `(\\A x, y \\in 1..Len(${collection}): x = y \\/ ${collection}[x].${key} # ${collection}[y].${key})`;
    return `(${unique(before)} /\\ ${unique(after)} /\\ \\A i \\in 1..Len(${before}): \\A j \\in 1..Len(${after}): ${bi}.${key} # ${aj}.${key} \\/ ${bi} = ${aj} \\/ (${rule}))`;
  }

  schema(schema: AnySchema, value: string): string {
    let type: string;
    switch (schema.kind) {
      case "integer": type = `(${value} \\in Int /\\ ${value} >= ${Number.MIN_SAFE_INTEGER} /\\ ${value} <= ${Number.MAX_SAFE_INTEGER})`; break;
      case "int64": type = `(${value} \\in Int /\\ ${value} >= -9223372036854775808 /\\ ${value} <= 9223372036854775807)`; break;
      case "boolean": type = `${value} \\in BOOLEAN`; break;
      case "string": type = `${value} \\in STRING`; break;
      case "enum": type = `${value} \\in ${set((schema as EnumSchema<string>).values.map(item => this.value(item, new Map())))}`; break;
      case "literal": type = `${value} = ${this.value((schema as LiteralSchema<string | number | boolean | null>).value, new Map())}`; break;
      case "object": {
        const fields = Object.entries((schema as ObjectSchema<ObjectShape>).shape);
        type = `(DOMAIN ${value} = ${set(fields.map(([field]) => JSON.stringify(field)))} /\\ ${fields.map(([field, child]) => this.schema(child, `${value}.${identifier(field)}`)).join(" /\\ ") || "TRUE"})`;
        break;
      }
      case "variants": {
        const sum = schema as AnyVariantsSchema;
        type = `(${sum.variantTags.map(tag => {
          const fields = sum.variants[tag]!.shape as ObjectShape;
          return `(${value}.${identifier(sum.discriminant)} = ${JSON.stringify(tag)} /\\ DOMAIN ${value} = ${set([sum.discriminant, ...Object.keys(fields)].map(field => JSON.stringify(field)))}${Object.entries(fields).map(([field, child]) => ` /\\ ${this.schema(child, `${value}.${identifier(field)}`)}`).join("")})`;
        }).join(" \\/ ")})`;
        break;
      }
      case "array": {
        const child = (schema as ArraySchema<unknown>).element;
        const bounds = integralBounds(schema, "length");
        type = `(${value} \\in Seq(${this.carrier(child)}) /\\ Len(${value}) >= ${bounds.lower}${bounds.upper === undefined ? "" : ` /\\ Len(${value}) <= ${bounds.upper}`} /\\ \\A i \\in 1..Len(${value}): ${this.schema(child, `${value}[i]`)})`;
        break;
      }
      default: throw new SpecificationError(`Inductive proof does not support ${schema.kind} schema`);
    }
    const constraints = schema.invariants.map(rule => this.rule(rule, new Map(), value));
    return constraints.length ? `(${type} /\\ ${constraints.join(" /\\ ")})` : type;
  }

  private carrier(schema: AnySchema): string {
    if (schema.kind === "integer" || schema.kind === "int64") return "Int";
    if (schema.kind === "boolean") return "BOOLEAN";
    if (schema.kind === "string") return "STRING";
    if (schema.kind === "enum") return set((schema as EnumSchema<string>).values.map(item => this.value(item, new Map())));
    if (schema.kind === "literal") return set([this.value((schema as LiteralSchema<string | number | boolean | null>).value, new Map())]);
    throw new SpecificationError(`Inductive proof cannot quantify an array of ${schema.kind}`);
  }

  rule(rule: Rule, names: Names, self = "s"): string {
    if (rule.kind === "compare") {
      const operands = new Map([...names, ["", self]]);
      const operator = rule.operator === "==" ? "=" : rule.operator === "!=" ? "#" : rule.operator;
      return `(${this.value(rule.left, operands)} ${operator} ${this.value(rule.right, operands)})`;
    }
    if (rule.kind === "not") return `~(${this.rule(rule.rule, names, self)})`;
    if (rule.kind === "and" || rule.kind === "or") return `(${rule.rules.map(child => this.rule(child, names, self)).join(rule.kind === "and" ? " /\\ " : " \\/ ")})`;
    const variable = `element${this.next++}`;
    const bound = this.value(rule.of, new Map([...names, ["", self]]));
    const collection = `1..Len(${bound})`;
    const elements = new Map([...names, [rule.element, `${bound}[${variable}]`]]);
    return `(\\${rule.kind === "all" ? "A" : "E"} ${variable} \\in ${collection}: ${this.rule(rule.each, elements, self)})`;
  }

  term(data: TermData, names: Names): string {
    if (data.kind === "linear") {
      if (!Number.isSafeInteger(data.constant)) throw new SpecificationError("TLA+ translation requires integer arithmetic");
      const parts = data.parts.map(part => {
        if (!Number.isSafeInteger(part.coefficient)) throw new SpecificationError("TLA+ translation requires integer coefficients");
        const value = this.position(part.path, part.measure, names);
        return part.coefficient === 1 ? value : `(${part.coefficient} * ${value})`;
      });
      return `(${[...parts, String(data.constant)].join(" + ")})`;
    }
    return this.position(data.path, data.measure, names);
  }

  position(path: readonly string[], measure: string, names: Names): string {
    if (measure !== "value") throw new SpecificationError(`TLA+ translation does not support measure ${measure}`);
    const named = names.get(path[0] ?? "");
    const root = named ?? names.get("");
    if (root === undefined) throw new SpecificationError(`TLA+ translation cannot resolve term ${path.join(".")}`);
    return path.slice(named === undefined ? 0 : 1).reduce((current, part) => `${current}.${identifier(part)}`, root);
  }
}

function identifier(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw new SpecificationError(`TLA+ translation cannot represent field ${value}`);
  return value;
}
