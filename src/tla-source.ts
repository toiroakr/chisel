import { check, parseModule } from "tla-ts";

// This compiler deliberately accepts a small, explicit subset of TLA+. Both
// type declarations and executable code come from the same parsed expressions.
type Expr = { kind: string; [key: string]: any };
type Definition = { name: string; params: readonly { name: string }[]; body: Expr; kind: string };

export interface CompiledTlaSource {
  readonly code: string;
  readonly declarations: string;
  readonly specification: string;
  readonly config: string;
}

function unsupported(expression: Expr): never {
  const at = expression.location?.range?.start ?? expression.location;
  const guidance: Record<string, string> = {
    Choose: "use IF ... THEN ... ELSE ... for deterministic transitions",
    Case: "include an OTHER arm to make the transition total",
    Function: "use a record [field |-> value] for a fixed shape",
    SetComprehension: "use an enumerated set or a finite integer range",
    Quantifier: "put quantified properties in Invariant(s); the runtime Step must stay deterministic",
  };
  throw new SyntaxError(`Cannot generate runtime from TLA+ ${expression.kind}${at ? ` at ${at.line}:${at.column}` : ""}${guidance[expression.kind] ? `; ${guidance[expression.kind]}` : "; rewrite this expression using literals, records, tuples, IF, and supported arithmetic"}`);
}

function literal(expression: Expr): string {
  if (expression.kind === "Apply" && expression.operator === "-." && expression.args.length === 1) {
    const value = expression.args[0] as Expr;
    if (value.kind === "Number" && Number.isSafeInteger(-value.value)) return String(-value.value);
  }
  if (expression.kind === "String") return JSON.stringify(expression.value);
  if (expression.kind === "Number" && Number.isSafeInteger(expression.value)) return String(expression.value);
  if (expression.kind === "Identifier" && ["TRUE", "FALSE"].includes(expression.name)) return expression.name.toLowerCase();
  return unsupported(expression);
}

function constant(expression: Expr): { code: string; type: string } {
  if (expression.kind === "Record") {
    const fields = expression.fields.map((item: { name: string; value: Expr }) => ({ name: item.name, value: constant(item.value) }));
    if (new Set(fields.map((item: { name: string }) => item.name)).size !== fields.length) throw new SyntaxError("Duplicate record field");
    return { code: `({ ${fields.map((item: { name: string; value: { code: string } }) => `[${JSON.stringify(item.name)}]: ${item.value.code}`).join(", ")} })`,
      type: `{ ${fields.map((item: { name: string; value: { type: string } }) => `${JSON.stringify(item.name)}: ${item.value.type}`).join("; ")} }` };
  }
  if (expression.kind === "Tuple") {
    const entries = expression.elements.map((item: Expr) => constant(item));
    return { code: `[${entries.map((item: { code: string }) => item.code).join(", ")}]`, type: `readonly [${entries.map((item: { type: string }) => item.type).join(", ")}]` };
  }
  const code = literal(expression);
  return { code, type: code };
}

function domain(expression: Expr): { type: string; guard: (value: string) => string; values?: readonly string[] } {
  if (expression.kind === "SetEnumeration") {
    const members = expression.elements.map((item: Expr) => constant(item));
    const values = members.map((item: { code: string }) => item.code);
    if (!values.length) throw new SyntaxError("A domain must contain at least one value");
    return { type: members.map((item: { type: string }) => item.type).join(" | "), values,
      guard: value => `(${values.map((item: string) => `tlaEqual(${value}, ${item})`).join(" || ")})` };
  }
  if (expression.kind === "Apply" && expression.operator === "..") {
    const [min, max] = expression.args.map((item: Expr) => Number(literal(item)));
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) throw new SyntaxError("Invalid finite integer domain");
    return { type: max - min <= 64 ? Array.from({ length: max - min + 1 }, (_, index) => String(min + index)).join(" | ") : "number",
      guard: value => `(Number.isSafeInteger(${value}) && ${value} >= ${min} && ${value} <= ${max})` };
  }
  if (expression.kind === "RecordSet") {
    if (!expression.fields.length) throw new SyntaxError("StateDomain must have fields");
    const fields = expression.fields.map((field: { name: string; value: Expr }) => ({ name: field.name, domain: domain(field.value) }));
    const keys = fields.map(({ name }: { name: string }) => name);
    if (new Set(keys).size !== keys.length) throw new SyntaxError("Duplicate StateDomain field");
    return { type: `{ ${fields.map(({ name, domain: item }: { name: string; domain: ReturnType<typeof domain> }) => `${JSON.stringify(name)}: ${item.type}`).join("; ")} }`,
      guard: value => `(${value} !== null && typeof ${value} === "object" && !Array.isArray(${value}) && Object.keys(${value}).length === ${fields.length} && ${fields.map(({ name, domain: item }: { name: string; domain: ReturnType<typeof domain> }) => `Object.hasOwn(${value}, ${JSON.stringify(name)}) && ${item.guard(`${value}[${JSON.stringify(name)}]`)}`).join(" && ")})` };
  }
  return unsupported(expression);
}

function emit(expression: Expr, variables: ReadonlySet<string>): string {
  if (expression.kind === "String" || expression.kind === "Number") return literal(expression);
  if (expression.kind === "Identifier") {
    if (expression.name === "TRUE" || expression.name === "FALSE") return literal(expression);
    if (!variables.has(expression.name)) return unsupported(expression);
    return expression.name;
  }
  if (expression.kind === "FieldAccess") return `(${emit(expression.record, variables)}[${JSON.stringify(expression.field)}])`;
  if (expression.kind === "If") return `(${emit(expression.condition, variables)} ? ${emit(expression.consequent, variables)} : ${emit(expression.alternative, variables)})`;
  if (expression.kind === "Record") {
    const keys = expression.fields.map((field: { name: string }) => field.name);
    if (new Set(keys).size !== keys.length) throw new SyntaxError("Duplicate record field");
    return `({ ${expression.fields.map((field: { name: string; value: Expr }) => `[${JSON.stringify(field.name)}]: ${emit(field.value, variables)}`).join(", ")} })`;
  }
  if (expression.kind === "Tuple") return `[${expression.elements.map((item: Expr) => emit(item, variables)).join(", ")}]`;
  if (expression.kind === "Case") {
    if (!expression.other) return unsupported(expression);
    return expression.arms.reduceRight((otherwise: string, arm: { condition: Expr; body: Expr }) =>
      `(${emit(arm.condition, variables)} ? ${emit(arm.body, variables)} : ${otherwise})`, emit(expression.other, variables));
  }
  if (expression.kind === "Let") {
    const locals = new Set(variables);
    const lines: string[] = [];
    for (const item of expression.definitions as Definition[]) {
      if (item.kind !== "Operator" || item.params.length || !/^[a-zA-Z_$][\w$]*$/.test(item.name) || locals.has(item.name)) return unsupported(expression);
      lines.push(`const ${item.name} = ${emit(item.body, locals)};`);
      locals.add(item.name);
    }
    return `(() => { ${lines.join(" ")} return ${emit(expression.body, locals)}; })()`;
  }
  if (expression.kind === "Except") {
    let value = emit(expression.function, variables);
    for (const update of expression.updates as { path: readonly { kind: string; name?: string }[]; value: Expr }[]) {
      if (update.path.some(item => item.kind !== "Field")) return unsupported(expression);
      value = `tlaExcept(${value}, ${JSON.stringify(update.path.map(item => item.name))}, ${emit(update.value, variables)})`;
    }
    return value;
  }
  if (expression.kind === "And" || expression.kind === "Or") return `(${expression.operands.map((item: Expr) => emit(item, variables)).join(expression.kind === "And" ? " && " : " || ")})`;
  if (expression.kind === "Not") return `(!${emit(expression.operand, variables)})`;
  if (expression.kind === "Apply") {
    if (expression.operator === "-." && expression.args.length === 1) return `(-BigInt(${emit(expression.args[0], variables)}))`;
    if (expression.operator === "=" && expression.args.length === 2) return `tlaEqual(${emit(expression.args[0], variables)}, ${emit(expression.args[1], variables)})`;
    if (expression.operator === "#" && expression.args.length === 2) return `(!tlaEqual(${emit(expression.args[0], variables)}, ${emit(expression.args[1], variables)}))`;
    if (["+", "-", "*"].includes(expression.operator) && expression.args.length === 2) {
      return `(BigInt(${emit(expression.args[0], variables)}) ${expression.operator} BigInt(${emit(expression.args[1], variables)}))`;
    }
    if (expression.operator === "\\in" && expression.args.length === 2) {
      const member = emit(expression.args[0], variables);
      const set = expression.args[1] as Expr;
      if (set.kind === "SetEnumeration") return `(${set.elements.map((item: Expr) => `tlaEqual(${member}, ${emit(item, variables)})`).join(" || ") || "false"})`;
      if (set.kind === "Apply" && set.operator === "..") return `tlaInRange(${member}, ${literal(set.args[0])}, ${literal(set.args[1])})`;
    }
    if (expression.operator === "Append" && expression.args.length === 2) return `([...${emit(expression.args[0], variables)}, ${emit(expression.args[1], variables)}])`;
    if (expression.operator === "Len" && expression.args.length === 1) return `(${emit(expression.args[0], variables)}.length)`;
    const operators: Record<string, string> = { "<": "<", "<=": "<=", ">": ">", ">=": ">=" };
    const operator = operators[expression.operator];
    if (operator && expression.args.length === 2) return `(${emit(expression.args[0], variables)} ${operator} ${emit(expression.args[1], variables)})`;
    if (expression.operator === "~" && expression.args.length === 1) return `(!${emit(expression.args[0], variables)})`;
  }
  return unsupported(expression);
}

export function compileTlaSource(source: string): CompiledTlaSource {
  const parsed = parseModule(source);
  if (parsed.variables.length || parsed.constants.length || parsed.instances.length || parsed.modules.length || parsed.assumptions.length || parsed.theorems.length || parsed.uses.length ||
      parsed.extends.some(item => !["Naturals", "Integers", "Sequences"].includes(item))) {
    throw new SyntaxError("TLA+ machine modules may only contain the supported operators and standard EXTENDS");
  }
  const definitions = parsed.definitions as Definition[];
  const names = definitions.map(item => item.name);
  if (new Set(names).size !== names.length || names.some(item => !["StateDomain", "CommandDomain", "InitialStates", "Step", "Invariant"].includes(item))) {
    throw new SyntaxError("TLA+ machine requires unique StateDomain, CommandDomain, InitialStates, Step, and optional Invariant operators");
  }
  const get = (name: string, arity: number) => {
    const definition = definitions.find(item => item.name === name);
    if (!definition || definition.kind !== "Operator" || definition.params.length !== arity) throw new SyntaxError(`${name} must be an operator with ${arity} parameters`);
    return definition;
  };
  const state = get("StateDomain", 0);
  const command = get("CommandDomain", 0);
  const initial = get("InitialStates", 0);
  const step = get("Step", 2);
  if (step.params[0]?.name === step.params[1]?.name || step.params.some(item => !/^[a-zA-Z_$][\w$]*$/.test(item.name))) throw new SyntaxError("Step parameter names must be distinct identifiers");
  const stateDomain = domain(state.body);
  const commandDomain = domain(command.body);
  if (!commandDomain.values) throw new SyntaxError("CommandDomain must be an enumerated set");
  if (initial.body.kind !== "SetEnumeration" || !initial.body.elements.length) throw new SyntaxError("InitialStates must be a nonempty set of records");
  const initialCode = initial.body.elements.map((item: Expr) => constant(item).code);
  const stepCode = emit(step.body, new Set(step.params.map(item => item.name)));
  if (step.body.kind !== "Record" || step.body.fields.length !== 2 ||
      !step.body.fields.some((field: { name: string }) => field.name === "state") ||
      !step.body.fields.some((field: { name: string }) => field.name === "commands")) {
    throw new SyntaxError("Step must return [state |-> ..., commands |-> <<...>>]");
  }
  const invariant = definitions.find(item => item.name === "Invariant");
  if (invariant && (invariant.params.length !== 1 || invariant.params[0]?.name !== "s")) throw new SyntaxError("Invariant must take one parameter named s");
  const moduleName = parsed.name;
  const code = `import { createTlaMachine, tlaEqual, tlaExcept, tlaInRange } from "@toiroakr/chisel";\nexport const machine = createTlaMachine({ name: ${JSON.stringify(moduleName)}, initial: [${initialCode.join(", ")}], commands: [${commandDomain.values.join(", ")}], acceptsState: value => ${stateDomain.guard("value")}, step: (${step.params.map(item => item.name).join(", ")}) => ${stepCode} });\nexport default machine;\n`;
  const declarations = `import type { TlaMachine } from "@toiroakr/chisel";\nexport type State = ${stateDomain.type};\nexport type Command = ${commandDomain.type};\nexport declare const machine: TlaMachine<State, Command>;\nexport default machine;\n`;
  const body = source.replace(/====\s*$/, "").trimEnd();
  const specification = `${body}\nVARIABLES state, pending, previous, depth\nMaxCommands == 1000\nInit == /\\ state \\in InitialStates /\\ pending = <<>> /\\ previous = state /\\ depth = 0\nNext == \\/ (\\E c \\in CommandDomain: /\\ pending = <<>> /\\ state' = Step(state, c).state /\\ pending' = Step(state, c).commands /\\ previous' = state /\\ depth' = 1)\n        \\/ (/\\ Len(pending) > 0 /\\ depth < MaxCommands /\\ state' = Step(state, Head(pending)).state /\\ pending' = Tail(pending) \\o Step(state, Head(pending)).commands /\\ previous' = state /\\ depth' = depth + 1)\nTypeOK == /\\ state \\in StateDomain /\\ \\A i \\in 1..Len(pending): pending[i] \\in CommandDomain\nBudget == pending = <<>> \\/ depth < MaxCommands\n${invariant ? "Safe == Invariant(state)\n" : ""}====`;
  const config = `INIT Init NEXT Next INVARIANT TypeOK INVARIANT Budget ${invariant ? "INVARIANT Safe " : ""}CHECK_DEADLOCK FALSE`;
  return { code, declarations, specification, config };
}

export async function checkTlaSource(source: string) {
  const compiled = compileTlaSource(source);
  return check({ source: compiled.specification, config: compiled.config });
}

export function mapTlaSource(source: string) {
  return { text: compileTlaSource(source).declarations, extension: ".ts", mappings: [] as number[][] };
}
