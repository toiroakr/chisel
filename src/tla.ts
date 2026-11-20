import { check as checkTla, formatValue, prove as proveTla } from "tla-ts";
import { SpecificationError } from "./behavior.js";
import { domainOf, integralBounds } from "./domain.js";
import { deepEqual } from "./equal.js";
import { childrenOf, nodeOf } from "./model.js";
import type { MachineSpecification } from "./machine-check.js";
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
// What one command can do when each of its effects may fail: the state it ends in and the
// commands it emits, for the run in which every effect succeeds and for the failure of each.
// The outcomes of a command with effects: every effect succeeds, the failure of each effect, and with
// `crashes` the process dying before the first effect and after each one.
function outcomesDefinition(crashes: boolean): string[] {
  return [
    "Outcomes(s, c) == LET r == Step(s, c) IN",
    "  IF \"effects\" \\in DOMAIN r THEN",
    "    {[state |-> IF Len(r.effects) = 0 THEN s ELSE r.effects[Len(r.effects)].state, commands |-> r.commands, stopped |-> FALSE, died |-> FALSE]}",
    "    \\cup {[state |-> IF r.effects[i].hasFailure THEN r.effects[i].failure ELSE (IF i = 1 THEN s ELSE r.effects[i - 1].state), commands |-> <<>>, stopped |-> TRUE, died |-> FALSE] : i \\in 1..Len(r.effects)}",
    ...(crashes ? ["    \\cup {[state |-> IF i = 0 THEN s ELSE r.effects[i].state, commands |-> <<>>, stopped |-> TRUE, died |-> TRUE] : i \\in IF Len(r.effects) = 0 THEN {} ELSE 0..Len(r.effects)}"] : []),
    "  ELSE {[state |-> r.state, commands |-> r.commands, stopped |-> FALSE, died |-> FALSE]}",
  ];
}

export function toTla<State, Command>(specification: MachineSpecification<State, Command>, options: {
  readonly domainLimit?: number;
  readonly maxCommands?: number;
} = {}): TlaModule {
  const machine = { ...specification.machine, invariants: specification.invariants, transitions: specification.transitions };
  const limit = options.domainLimit ?? 10000;
  const maxCommands = options.maxCommands ?? 1000;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new SpecificationError("domainLimit must be a positive safe integer");
  if (!Number.isSafeInteger(maxCommands) || maxCommands < 1) throw new SpecificationError("maxCommands must be a positive safe integer");
  if (hasOptional(machine.state as AnySchema)) throw new SpecificationError("TLA+ translation does not support optional state fields");
  const states = domainOf(machine.state as never, limit);
  const commands = domainOf(machine.command as never, limit);
  if (!states.exhaustive || !commands.exhaustive) {
    throw new SpecificationError("TLA+ translation requires finite, exhaustively enumerated state and command schemas");
  }
  if (commands.values.length === 0) throw new SpecificationError("TLA+ translation requires at least one command");
  const compiler = new Compiler(machine.state as AnySchema, machine.command as AnySchema);
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
  const discriminant = (machine.command as unknown as Partial<AnyVariantsSchema>).discriminant === undefined ? "" : identifier((machine.command as unknown as AnyVariantsSchema).discriminant);
  const effectful = hasEffect(machine.update);
  const preconditions = Object.entries(specification.requires).map(([tag, holds], index) => {
    const precondition = `(${compiler.condition(holds, new Map([["state", "previous"], ["command", "last"]]), "previous")})`;
    // A command that stopped (at a failed effect, or by the process dying) may have written nothing yet, so only the other direction holds of it.
    const agrees = effectful ? `IF stopped THEN (~${precondition} => previous = state) ELSE (${precondition} <=> previous # state)` : `${precondition} <=> previous # state`;
    return { name: `Req${index}`, formula: `IF depth = 0 THEN TRUE ELSE IF last.${discriminant} = ${JSON.stringify(tag)} THEN ${agrees} ELSE TRUE` };
  });
  const last = (command: string) => preconditions.length > 0 ? ` /\\ last' = ${command}` : "";
  const next = effectful ? [
    `Next == \\/ (\\E c \\in CommandDomain: \\E r \\in Outcomes(state, c): /\\ pending = <<>> /\\ state' = r.state /\\ pending' = r.commands /\\ previous' = state /\\ depth' = 1 /\\ stopped' = r.stopped${last("c")})`,
    `        \\/ (/\\ Len(pending) > 0 /\\ depth < MaxCommands /\\ \\E r \\in Outcomes(state, Head(pending)): /\\ state' = r.state /\\ pending' = (IF r.died THEN <<>> ELSE Tail(pending) \\o r.commands) /\\ previous' = state /\\ depth' = depth + 1 /\\ stopped' = r.stopped${last("Head(pending)")})`,
  ] : [
    `Next == \\/ (\\E c \\in CommandDomain: /\\ pending = <<>> /\\ state' = Step(state, c).state /\\ pending' = Step(state, c).commands /\\ previous' = state /\\ depth' = 1${last("c")})`,
    `        \\/ (/\\ Len(pending) > 0 /\\ depth < MaxCommands /\\ state' = Step(state, Head(pending)).state /\\ pending' = Tail(pending) \\o Step(state, Head(pending)).commands /\\ previous' = state /\\ depth' = depth + 1${last("Head(pending)")})`,
  ];
  const stateSet = set(states.values.map(value => compiler.value(value, new Map())));
  const commandSet = set(commands.values.map(value => compiler.value(value, new Map())));
  const initial = set(machine.initial.map(value => compiler.value(value, new Map())));
  const source = [
    `---- MODULE ${name} ----`,
    "EXTENDS Naturals, Integers, Sequences",
    `VARIABLES state, pending, previous, depth${effectful ? ", stopped" : ""}${preconditions.length > 0 ? ", last" : ""}`,
    `MaxCommands == ${maxCommands}`,
    `StateDomain == ${stateSet}`,
    `CommandDomain == ${commandSet}`,
    `Step(s, c) == ${step}`,
    ...(effectful ? outcomesDefinition(specification.crashes) : []),
    `Init == /\\ state \\in ${initial} /\\ pending = <<>> /\\ previous = state /\\ depth = 0${effectful ? " /\\ stopped = FALSE" : ""}${preconditions.length > 0 ? " /\\ last = <<>>" : ""}`,
    ...next,
    "TypeOK == /\\ state \\in StateDomain /\\ \\A i \\in 1..Len(pending): pending[i] \\in CommandDomain",
    "Budget == pending = <<>> \\/ depth < MaxCommands",
    ...properties.map(item => `${item.name} == ${item.formula}`),
    ...transitions.map(item => `${item.name} == previous = state \\/ (${item.formula})`),
    ...preconditions.map(item => `${item.name} == ${item.formula}`),
    "====",
  ].join("\n");
  const config = `INIT Init NEXT Next INVARIANT TypeOK ${properties.map(item => `INVARIANT ${item.name}`).join(" ")} ${transitions.map(item => `INVARIANT ${item.name}`).join(" ")} ${preconditions.map(item => `INVARIANT ${item.name}`).join(" ")} INVARIANT Budget CHECK_DEADLOCK FALSE`;
  return { name, source, config, states: states.values.length, commands: commands.values.length };
}

export async function checkMachineTla<State, Command>(machine: MachineSpecification<State, Command>, options: {
  readonly domainLimit?: number;
  readonly maxCommands?: number;
} = {}): Promise<{ readonly status: "held" | "broken" | "undetermined"; readonly states: number; readonly generatedStates: number;
  readonly reason?: string; readonly trace?: readonly { readonly action?: string; readonly state: string; readonly pending: string }[];
  readonly module?: TlaModule }> {
  let module: TlaModule;
  try { module = toTla(machine, options); }
  catch (error) {
    if (error instanceof SpecificationError) return { status: "undetermined", states: 0, generatedStates: 0, reason: error.message };
    throw error;
  }
  let result: Awaited<ReturnType<typeof checkTla>>;
  try { result = await checkTla({ source: module.source, config: module.config }); }
  catch (error) { return { status: "undetermined", states: 0, generatedStates: 0,
    reason: `tla-ts could not complete the check: ${error instanceof Error ? error.message : String(error)}`, module }; }
  if (result.status === "success") return { status: "held", states: result.distinctStates, generatedStates: result.generatedStates, module };
  if (result.status === "invariant-violation" && result.violation?.name === "Budget") return {
    status: "undetermined", states: result.distinctStates, generatedStates: result.generatedStates,
    reason: `TLA+ exploration exceeded maxCommands (${options.maxCommands ?? 1000})`, module,
  };
  const violated = result.violation?.name ?? "";
  if (result.status === "invariant-violation") return { status: "broken", states: result.distinctStates,
    generatedStates: result.generatedStates,
    reason: /^Inv\d+$/.test(violated)
      ? machine.invariants[Number(violated.slice(3))]?.name ?? violated
      : /^Req\d+$/.test(violated)
        ? `${Object.keys(machine.requires)[Number(violated.slice(3))]}: its precondition disagrees with whether it changes the state`
        : result.violation?.name ?? "An invariant was violated",
    ...(result.violation === undefined ? {} : { trace: result.violation.trace.map(step => ({
      ...(step.action === undefined ? {} : { action: step.action }),
      state: formatValue(step.state.state!), pending: formatValue(step.state.pending!),
    })) }), module };
  return { status: "undetermined", states: result.distinctStates, generatedStates: result.generatedStates,
    reason: `tla-ts could not complete the check: ${result.status}${result.failure ? `: ${result.failure.message}` : ""}`, module };
}

// Copies of the machine as processes sharing one state (see `checkInterleavings`). Only the
// native checker follows the commands a command emits, so a translation that meets one is undetermined.
export async function checkInterleavingsTla<State, Command>(specification: MachineSpecification<State, Command>, options: {
  readonly copies: readonly NoInfer<Command>[];
  readonly maxCopies?: number;
}): Promise<{ readonly status: "held" | "broken" | "undetermined"; readonly states: number; readonly reason?: string; readonly module?: TlaModule }> {
  const maxCopies = options.maxCopies ?? 2;
  if (options.copies.length > maxCopies) {
    return { status: "undetermined", states: 0, reason: `${options.copies.length} copies exceed maxCopies (${maxCopies})` };
  }
  let module: TlaModule;
  try { module = interleavingsToTla(specification, options); }
  catch (error) {
    if (error instanceof SpecificationError) return { status: "undetermined", states: 0, reason: error.message };
    throw error;
  }
  let result: Awaited<ReturnType<typeof checkTla>>;
  try { result = await checkTla({ source: module.source, config: module.config }); }
  catch (error) { return { status: "undetermined", states: 0, module,
    reason: `tla-ts could not complete the check: ${error instanceof Error ? error.message : String(error)}` }; }
  if (result.status === "success") return { status: "held", states: result.distinctStates, module };
  const violated = result.violation?.name ?? "";
  if (result.status === "invariant-violation" && violated === "NoEmission") return { status: "undetermined", states: result.distinctStates, module,
    reason: "TLA+ translation of interleavings does not follow the commands a command emits" };
  if (result.status === "invariant-violation") return { status: "broken", states: result.distinctStates, module,
    reason: /^Inv\d+$/.test(violated) ? specification.invariants[Number(violated.slice(3))]?.name ?? violated
      : /^Trans\d+$/.test(violated) ? `${specification.name} moved the state in a way ${specification.transitions[Number(violated.slice(5))]?.name} does not allow` : violated };
  return { status: "undetermined", states: result.distinctStates, module,
    reason: `tla-ts could not complete the check: ${result.status}${result.failure ? `: ${result.failure.message}` : ""}` };
}

export function interleavingsToTla<State, Command>(specification: MachineSpecification<State, Command>, options: {
  readonly copies: readonly NoInfer<Command>[];
}): TlaModule {
  const machine = specification.machine;
  if (machine.state.kind !== "object") throw new SpecificationError("TLA+ translation of interleavings needs a state that is an object");
  if (hasOptional(machine.state as AnySchema)) throw new SpecificationError("TLA+ translation does not support optional state fields");
  if (options.copies.length === 0) throw new SpecificationError(`Machine ${machine.name} has no copy to run`);
  const compiler = new Compiler(machine.state as AnySchema, machine.command as AnySchema);
  const step = compiler.value(machine.update, new Map([["state", "s"], ["command", "c"]]), true);
  const name = `ChiselInterleave${machine.name.replace(/[^A-Za-z0-9]+/g, " ").split(" ").filter(Boolean).map(part => part[0]!.toUpperCase() + part.slice(1)).join("") || "Machine"}`;
  const copies = options.copies.length;
  const initial = set(machine.initial.map(value => compiler.value(value, new Map())));
  const properties = specification.invariants.map((invariant, index) => ({ name: `Inv${index}`, formula: compiler.condition(invariant.holds, new Map(), "state") }));
  const transitions = specification.transitions.map((transition, index) => ({ name: `Trans${index}`,
    formula: compiler.condition(transition.holds, new Map([["before", "previous"], ["after", "state"]]), "state") }));
  const variables = ["state", "previous", "version", "status", "pc", "snap", "plan", "readVersion", "unsupported"];
  const keep = (...changed: string[]) => `UNCHANGED <<${variables.filter(item => !changed.includes(item)).join(", ")}>>`;
  const set1 = (variable: string, value: string) => `${variable}' = [${variable} EXCEPT ![p] = ${value}]`;
  const source = [
    `---- MODULE ${name} ----`,
    "EXTENDS Naturals, Integers, Sequences",
    `VARIABLES ${variables.join(", ")}`,
    `Copies == <<${options.copies.map(command => compiler.value(command, new Map())).join(", ")}>>`,
    `Step(s, c) == ${step}`,
    `Init == /\\ state \\in ${initial} /\\ previous = state /\\ version = 0 /\\ unsupported = FALSE`,
    `        /\\ status = [p \\in 1..${copies} |-> "idle"] /\\ pc = [p \\in 1..${copies} |-> 0]`,
    `        /\\ snap = [p \\in 1..${copies} |-> state] /\\ plan = [p \\in 1..${copies} |-> <<>>] /\\ readVersion = [p \\in 1..${copies} |-> 0]`,
    "Seen(p) == IF pc[p] = 0 THEN snap[p] ELSE plan[p][pc[p]].state",
    "Changed(p, e, k) == IF e.hasWrites THEN (\\E i \\in 1..Len(e.writes): e.writes[i] = k) ELSE e.state[k] # Seen(p)[k]",
    "Patched(p, e) == [k \\in DOMAIN state |-> IF Changed(p, e, k) THEN e.state[k] ELSE state[k]]",
    "Wrote(p, e) == \\E k \\in DOMAIN state: Changed(p, e, k)",
    "Begin(p) == /\\ status[p] = \"idle\"",
    "            /\\ LET r == Step(state, Copies[p]) IN",
    "               /\\ unsupported' = (unsupported \\/ r.commands # <<>>)",
    "               /\\ IF \"effects\" \\in DOMAIN r THEN",
    `                    (IF Len(r.effects) = 0 THEN (/\\ ${set1("status", '"finished"')} /\\ ${keep("status", "unsupported")})`,
    `                     ELSE (/\\ ${set1("status", '"running"')} /\\ ${set1("snap", "state")} /\\ ${set1("plan", "r.effects")} /\\ ${set1("pc", "0")} /\\ ${set1("readVersion", "version")} /\\ ${keep("status", "snap", "plan", "pc", "readVersion", "unsupported")}))`,
    `                  ELSE (/\\ previous' = state /\\ state' = r.state /\\ version' = IF r.state # state THEN version + 1 ELSE version /\\ ${set1("status", '"finished"')} /\\ ${keep("previous", "state", "version", "status", "unsupported")})`,
    "Run(p) == /\\ status[p] = \"running\"",
    "          /\\ LET e == plan[p][pc[p] + 1] IN",
    `             IF e.ifUnchanged /\\ version # readVersion[p] THEN (/\\ ${set1("status", '"refused"')} /\\ ${keep("status")})`,
    `             ELSE (/\\ previous' = state /\\ state' = Patched(p, e) /\\ version' = IF Wrote(p, e) THEN version + 1 ELSE version`,
    `                   /\\ ${set1("pc", "pc[p] + 1")} /\\ status' = IF pc[p] + 1 = Len(plan[p]) THEN [status EXCEPT ![p] = "finished"] ELSE status`,
    `                   /\\ ${keep("previous", "state", "version", "pc", "status")})`,
    `Next == \\E p \\in 1..${copies}: Begin(p) \\/ Run(p)`,
    "NoEmission == ~unsupported",
    ...properties.map(item => `${item.name} == ${item.formula}`),
    ...transitions.map(item => `${item.name} == previous = state \\/ (${item.formula})`),
    "====",
  ].join("\n");
  const config = `INIT Init NEXT Next INVARIANT NoEmission ${properties.map(item => `INVARIANT ${item.name}`).join(" ")} ${transitions.map(item => `INVARIANT ${item.name}`).join(" ")} CHECK_DEADLOCK FALSE`;
  return { name, source, config, states: 0, commands: options.copies.length };
}

export interface InductiveProof {
  readonly status: "proved" | "undetermined";
  readonly obligations: readonly { readonly name: string; readonly status: "proved" | "undetermined"; readonly reason?: string }[];
  readonly source?: string;
  readonly reason?: string;
}

// This is a universal inductive proof, not finite-state model checking. A
// theorem is reported proved only when tla-ts discharges its obligation.
export async function proveMachine<State, Command>(specification: MachineSpecification<State, Command>): Promise<InductiveProof> {
  const machine = { ...specification.machine, invariants: specification.invariants, transitions: specification.transitions };
  let source: string;
  const requiredTags = Object.keys(specification.requires);
  const names = ["initial", "state contract", "emitted commands", ...machine.invariants.map(item => item.name), ...machine.transitions.map(item => item.name),
    ...requiredTags.flatMap(tag => [`${tag} precondition allows the change`, `${tag} precondition forces the change`])];
  try {
    const compiler = new Compiler(machine.state as AnySchema, machine.command as AnySchema);
    if (hasOptional(machine.state as AnySchema)) throw new SpecificationError("Inductive proof does not support optional state fields");
    const step = compiler.value(machine.update, new Map([["state", "s"], ["command", "c"]]), true);
    const stateOK = compiler.schema(machine.state as AnySchema, "s");
    const commandOK = compiler.schema(machine.command as AnySchema, "c");
    const invariants = machine.invariants.map((item, index) => ({ name: `Inv${index}`,
      formula: compiler.condition(item.holds, new Map(), "s") }));
    const assumption = ["StateOK(s)", "CommandOK(c)", ...invariants.map(item => `${item.name}(s)`)].join(" /\\ ");
    const effectful = hasEffect(machine.update);
    const defs = ["Step", ...(effectful ? ["Outcomes"] : []), "StateOK", "CommandOK", ...invariants.map(item => item.name)].join(", ");
    const output = effectful ? "r" : "Step(s, c)";
    const over = (body: string) => `\\A s, c: (${assumption}) => ${effectful ? `\\A r \\in Outcomes(s, c): ${body}` : body}`;
    const transitions = machine.transitions.map(item => item.each
      ? compiler.paired(item.holds, item.each, schemaAtPath(machine.state as never, item.each.path)?.kind, "s", `${output}.state`)
      : compiler.condition(item.holds, new Map([["before", "s"], ["after", `${output}.state`]]), "s"));
    const formulae = [
      `\\A s: InitState(s) => (StateOK(s)${invariants.map(item => ` /\\ ${item.name}(s)`).join("")})`,
      over(`StateOK(${output}.state)`),
      over(`\\A i \\in 1..Len(${output}.commands): CommandOK(${output}.commands[i])`),
      ...invariants.map(item => over(`${item.name}(${output}.state)`)),
      ...transitions.map(formula => over(`(s = ${output}.state \\/ (${formula}))`)),
      ...requiredTags.flatMap(tag => {
        const pre = compiler.condition(specification.requires[tag], new Map([["state", "s"], ["command", "c"]]), "s");
        const isTag = `c.${identifier((machine.command as unknown as AnyVariantsSchema).discriminant)} = ${JSON.stringify(tag)}`;
        const unchanged = unchangedFormula(machine.state as AnySchema, "s", `${output}.state`);
        return [over(`(${isTag} => (${unchanged} \\/ (${pre})))`),
          over(`(${isTag} => (${effectful ? `${output}.stopped \\/ ` : ""}~(${pre}) \\/ ~(${unchanged})))`)];
      }),
    ];
    source = [
      "---- MODULE ChiselInduction ----",
      "EXTENDS Naturals, Integers, Sequences",
      `Step(s, c) == ${step}`,
      ...(effectful ? outcomesDefinition(specification.crashes) : []),
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
  try { result = await proveTla({ source, backend: "tla-ts" }); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "undetermined", obligations: names.map(name => ({ name, status: "undetermined", reason })), source, reason };
  }
  const theoremLines = source.split("\n").flatMap((line, index) => line.startsWith("THEOREM ") ? [index + 1] : []);
  const grouped = names.map(() => [] as typeof result.obligations);
  let unmatched = false;
  for (const obligation of result.obligations) {
    const line = Number(obligation.location.split(":")[0]);
    const index = theoremLines.indexOf(line);
    if (index < 0 || index >= grouped.length) unmatched = true;
    else grouped[index]!.push(obligation);
  }
  const obligations = grouped.map((items, index) => {
    const failed = items.find(item => item.status === "failed" || item.status === "unsupported");
    return { name: names[index]!,
      status: items.length > 0 && items.every(item => item.status === "proved" || item.status === "trivial") ? "proved" as const : "undetermined" as const,
      ...(failed && "reason" in failed ? { reason: failed.reason } : {}),
    };
  });
  return { status: !unmatched && theoremLines.length === names.length && result.missingProofCount === 0 && result.omittedProofCount === 0 && obligations.every(item => item.status === "proved") ? "proved" : "undetermined",
    obligations, source };
}

// Compared field by field: the prover cannot discharge a whole-record equality
// of a step's result, but it can the same claim about each field.
function unchangedFormula(schema: AnySchema, before: string, after: string): string {
  if (schema.kind !== "object") return `${before} = ${after}`;
  const fields = Object.entries((schema as ObjectSchema<ObjectShape>).shape);
  return `(${fields.map(([field, child]) => unchangedFormula(child, `${before}.${identifier(field)}`, `${after}.${identifier(field)}`)).join(" /\\ ") || "TRUE"})`;
}

function hasEffect(value: unknown): boolean {
  if (value !== null && typeof value === "object" && (value as { kind?: unknown }).kind === "effect") return true;
  return childrenOf(value).some(hasEffect);
}

function set(values: readonly string[]): string {
  return `{${values.join(", ")}}`;
}

function hasOptional(schema: AnySchema, visited = new Set<AnySchema>()): boolean {
  if (schema.kind === "optional") return true;
  if (visited.has(schema)) return false;
  visited.add(schema);
  if (schema.kind === "object") return Object.values((schema as ObjectSchema<ObjectShape>).shape).some(child => hasOptional(child, visited));
  if (schema.kind === "variants") return (Object.values((schema as AnyVariantsSchema).variants) as AnySchema[]).some(child => hasOptional(child, visited));
  if (schema.kind === "array") return hasOptional((schema as ArraySchema<unknown>).element, visited);
  return false;
}

class Compiler {
  private next = 0;
  constructor(private readonly stateSchema: AnySchema, private readonly commandSchema: AnySchema) {}

  value(value: unknown, names: Names, result = false): string {
    if (isTerm(value)) return this.term(termData(value), names);
    const node = nodeOf(value);
    if (node?.kind === "choose") return `(IF ${this.rule(node.condition, names, names.get("") ?? "s")} THEN ${this.value(node.yes, names, result)} ELSE ${this.value(node.no, names, result)})`;
    if (node?.kind === "bind") {
      const data = isTerm(node.value) ? termData(node.value) : undefined;
      const source = data?.kind === "position" && data.path.length === 1 ? data.path[0] : undefined;
      if ((source !== "state" || node.schema !== this.stateSchema) &&
          (source !== "command" || node.schema !== this.commandSchema)) {
        throw new SpecificationError("TLA+ translation cannot preserve bind schema validation");
      }
      const local = `local${this.next++}`;
      return `(LET ${local} == ${this.value(node.value, names)} IN ${this.value(node.body, new Map([...names, [node.name, local]]), result)})`;
    }
    if (node?.kind === "map") {
      const data = isTerm(node.values) ? termData(node.values) : undefined;
      if (data?.kind !== "position" || data.path.length !== 1 || data.path[0] !== "state" ||
          this.stateSchema.kind !== "array" || (this.stateSchema as ArraySchema<unknown>).element !== node.element ||
          node.element !== node.output || !this.safeMappedBody(node.body, node.element as AnySchema, node.name)) {
        throw new SpecificationError("TLA+ translation cannot preserve map element and output schema validation");
      }
      const sequence = this.value(node.values, names);
      const index = `index${this.next++}`;
      const body = this.value(node.body, new Map([...names, [node.name, `${sequence}[${index}]`]]));
      return `[${index} \\in 1..Len(${sequence}) |-> ${body}]`;
    }
    if (node?.kind === "construct") {
      if (isTerm(node.value) || nodeOf(node.value)) throw new SpecificationError("TLA+ translation cannot preserve dynamic constructor validation");
      const parsed = node.schema.parse(node.value);
      if (!parsed.success) throw new SpecificationError("TLA+ translation cannot preserve invalid constructor");
      return this.value(parsed.value, names, result);
    }
    if (node?.kind === "operation") throw new SpecificationError("TLA+ translation cannot preserve intermediate arithmetic validation");
    if (node) throw new SpecificationError(`TLA+ translation does not support ${node.kind}${"operator" in node ? ` ${node.operator}` : ""}`);
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "boolean") return String(value).toUpperCase();
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    if (Array.isArray(value)) return `<<${value.map(item => this.value(item, names)).join(", ")}>>`;
    if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      const fields = Object.entries(value);
      if ((value as { kind?: unknown }).kind === "effect") {
        const hasFailure = fields.some(([key]) => key === "failure");
        if (!hasFailure) fields.push(["failure", 0]);
        fields.push(["hasFailure", hasFailure]);
        if (!fields.some(([key]) => key === "ifUnchanged")) fields.push(["ifUnchanged", false]);
        const hasWrites = fields.some(([key]) => key === "writes");
        if (!hasWrites) fields.push(["writes", []]);
        fields.push(["hasWrites", hasWrites]);
      }
      if (result && !fields.some(([key]) => key === "commands")) fields.push(["commands", []]);
      if (!fields.length) throw new SpecificationError("TLA+ translation cannot represent an empty record");
      return `[${fields.map(([key, child]) => `${identifier(key)} |-> ${this.value(child, names)}`).join(", ")}]`;
    }
    throw new SpecificationError(`TLA+ translation cannot represent ${String(value)}`);
  }

  private safeMappedBody(value: unknown, schema: AnySchema, element: string): boolean {
    const node = nodeOf(value);
    if (node?.kind === "choose") return this.safeMappedBody(node.yes, schema, element) && this.safeMappedBody(node.no, schema, element);
    if (node) return false;
    if (isTerm(value)) {
      const data = termData(value);
      return data.kind === "position" && data.path.length === 1 && data.path[0] === element;
    }
    const parsed = schema.parse(value);
    return parsed.success && deepEqual(parsed.value, value);
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
