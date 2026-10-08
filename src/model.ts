import { isPromiseLike, snapshotValue } from "./data.js";
import type { Decimal } from "decimal.js";
import { Rational, isRational, fractionOf, decimalOf, EvaluationLimit } from "./exact.js";
import type { AnyBehavior, Execution, RulesDecision, Branch } from "./behavior.js";
import type { Rule, Term, TermOf, ComparisonObserver } from "./rule.js";
import { DEPS, depsTerm, holds, isDecimal, isTerm, positionData, readOperand, selfTerm, termData, rootTerm, positionTerm, withLocal } from "./rule.js";
import type { Schema, AnyVariantsSchema, Infer, Tags, VariantOf } from "./schema.js";
import type { Step } from "./ways.js";
import { outcomesOf } from "./ways.js";
import type { Temporal as TemporalTypes } from "temporal-spec";
import type { CalendarUnit, ClockUnit, Overflow } from "./temporal.js";
import { countBetween, moveTemporal } from "./temporal.js";

const EXPRESSION = Symbol.for("chisel.expression");
export interface Expression<T> {
  readonly [EXPRESSION]: Node;
  readonly output?: T;
}
export type Template<T> = Term<T> | Expression<T> | (T extends readonly (infer E)[]
  ? readonly Template<E>[]
  : T extends object ? { readonly [K in keyof T]: Template<T[K]> } : T);
export type Node =
  | { readonly kind: "bind"; readonly name: string; readonly schema: Schema<unknown>; readonly value: unknown; readonly body: unknown }
  | { readonly kind: "map"; readonly name: string; readonly element: Schema<unknown>; readonly output: Schema<unknown>; readonly values: unknown; readonly body: unknown }
  | { readonly kind: "fold"; readonly name: string; readonly accumulator: string; readonly element: Schema<unknown>; readonly output: Schema<unknown>; readonly values: unknown; readonly initial: unknown; readonly body: unknown }
  | { readonly kind: "call"; readonly dependency: Term<unknown>; readonly input: unknown }
  | { readonly kind: "choose"; readonly condition: Rule; readonly yes: unknown; readonly no: unknown }
  | { readonly kind: "construct"; readonly schema: Schema<unknown>; readonly value: unknown }
  | { readonly kind: "operation"; readonly operator: "add" | "subtract" | "multiply" | "divide" | "quotient" | "concat"; readonly left: unknown; readonly right: unknown }
  | { readonly kind: "temporal"; readonly operator: "plus" | "minus" | "between"; readonly left: unknown; readonly right: unknown; readonly unit: string; readonly overflow: Overflow };

function expression<T>(node: Node): Expression<T> {
  return Object.freeze({ [EXPRESSION]: Object.freeze(node) });
}
const LOCAL = "#local:";
let nextLocal = 0;
function localName(): string { return `${LOCAL}${nextLocal++}`; }
export function bind<Value, Result>(schema: Schema<Value>, value: Template<NoInfer<Value>>, build: (value: TermOf<Value>) => Template<Result>): Expression<Result> {
  const name = localName();
  return expression({ kind: "bind", name, schema: schema as Schema<unknown>, value, body: build(rootTerm<Value>(name)) });
}
export function matchValue<S extends AnyVariantsSchema, Result>(schema: S, value: Template<NoInfer<Infer<S>>>, cases: { readonly [Tag in Tags<S>]: (value: TermOf<VariantOf<S, Tag>>) => Template<Result> }): Expression<Result> {
  const tags = schema.variantTags as readonly Tags<S>[];
  if (tags.length === 0 || Object.keys(cases).length !== tags.length || tags.some(tag => !Object.hasOwn(cases, tag) || typeof cases[tag] !== "function")) throw new Error("matchValue requires exactly one body for every variant");
  const name = localName();
  const handlers = cases as unknown as Readonly<Record<string, (value: TermOf<unknown>) => unknown>>;
  const bodies = tags.map(tag => handlers[tag]!(rootTerm(name)));
  let body: unknown = bodies.at(-1);
  for (let index = tags.length - 2; index >= 0; index--) body = expression({ kind: "choose", condition: { kind: "compare", left: positionTerm([name, schema.discriminant], "value"), operator: "==", right: tags[index] }, yes: bodies[index], no: body });
  return expression({ kind: "bind", name, schema, value, body });
}
export function map<Element, Result>(element: Schema<Element>, output: Schema<Result>, values: Template<readonly NoInfer<Element>[]>, build: (value: TermOf<Element>) => Template<NoInfer<Result>>): Expression<readonly Result[]> {
  const name = localName();
  return expression({ kind: "map", name, element: element as Schema<unknown>, output: output as Schema<unknown>, values, body: build(rootTerm<Element>(name)) });
}
export function fold<Element, Accumulator>(element: Schema<Element>, output: Schema<Accumulator>, values: Template<readonly NoInfer<Element>[]>, initial: Template<NoInfer<Accumulator>>, build: (accumulator: TermOf<Accumulator>, value: TermOf<Element>) => Template<NoInfer<Accumulator>>): Expression<Accumulator> {
  const name = localName(), accumulator = localName();
  return expression({ kind: "fold", name, accumulator, element: element as Schema<unknown>, output: output as Schema<unknown>, values, initial, body: build(rootTerm<Accumulator>(accumulator), rootTerm<Element>(name)) });
}
export function hasScopedChoices(value: unknown): boolean {
  const node = nodeOf(value);
  if (node?.kind === "choose" && localRoots(node.condition).length > 0) return true;
  if ((node?.kind === "map" || node?.kind === "fold") && choicesOf(node.body).length > 0) return true;
  return childrenOf(value).some(hasScopedChoices);
}
export function localRoots(value: unknown): readonly string[] {
  if (isTerm(value)) {
    const data = termData(value);
    return (data.kind === "position" ? [data.path] : data.parts.map(part => part.path)).flatMap(path => path[0]?.startsWith(LOCAL) ? [path[0]] : []);
  }
  return childrenOf(value).flatMap(localRoots);
}
export function choose<T>(condition: Rule, yes: Template<T>, no: Template<NoInfer<T>>): Expression<T> {
  return expression({ kind: "choose", condition, yes, no });
}
export function construct<T>(schema: Schema<T>, value: Template<NoInfer<T extends object ? Pick<T, Extract<keyof T, string | number>> : T>>): Expression<T> {
  return expression({ kind: "construct", schema: schema as Schema<unknown>, value });
}
export function call<Input, Output>(dependency: Term<(input: Input) => Output>, input: Template<NoInfer<Input>>): Expression<Output> {
  dependencyName(dependency);
  return expression({ kind: "call", dependency, input });
}
export function dependencyName(dependency: Term<unknown>): string {
  const position = positionData(dependency);
  if (!position || position.measure !== "value" || position.path.length !== 2 || position.path[0] !== DEPS) throw new Error("call expects a declared function dependency");
  return position.path[1]!;
}
export function concat(left: Template<string>, right: Template<string>): Expression<string> {
  return expression({ kind: "operation", operator: "concat", left, right });
}
export function arithmetic<T extends number | bigint | Rational | Decimal>(operator: "add" | "subtract" | "multiply" | "divide", left: Template<T>, right: Template<NoInfer<T>>): Expression<T> {
  return expression({ kind: "operation", operator, left, right });
}
type PlainDate = TemporalTypes.PlainDate;
type PlainTime = TemporalTypes.PlainTime;
type PlainDateTime = TemporalTypes.PlainDateTime;
type Instant = TemporalTypes.Instant;
interface MoveOptions {
  // What a month or year added to a day the target month lacks does:
  // "constrain" (the default) moves to the month's last day, "reject" refuses.
  readonly overflow?: Overflow;
}
function temporal<T>(operator: "plus" | "minus" | "between", left: unknown, right: unknown, unit: string, options: MoveOptions = {}): Expression<T> {
  return expression({ kind: "temporal", operator, left, right, unit, overflow: options.overflow ?? "constrain" });
}
// A date, time, date-time or instant moved later by a whole number of one unit.
export function plus(value: Template<PlainDate>, amount: Template<number>, unit: CalendarUnit, options?: MoveOptions): Expression<PlainDate>;
export function plus(value: Template<PlainTime>, amount: Template<number>, unit: ClockUnit): Expression<PlainTime>;
export function plus(value: Template<PlainDateTime>, amount: Template<number>, unit: CalendarUnit | ClockUnit, options?: MoveOptions): Expression<PlainDateTime>;
export function plus(value: Template<Instant>, amount: Template<number>, unit: ClockUnit): Expression<Instant>;
export function plus(value: unknown, amount: Template<number>, unit: string, options?: MoveOptions): Expression<unknown> {
  return temporal("plus", value, amount, unit, options);
}
// A date, time, date-time or instant moved earlier by a whole number of one unit.
export function minus(value: Template<PlainDate>, amount: Template<number>, unit: CalendarUnit, options?: MoveOptions): Expression<PlainDate>;
export function minus(value: Template<PlainTime>, amount: Template<number>, unit: ClockUnit): Expression<PlainTime>;
export function minus(value: Template<PlainDateTime>, amount: Template<number>, unit: CalendarUnit | ClockUnit, options?: MoveOptions): Expression<PlainDateTime>;
export function minus(value: Template<Instant>, amount: Template<number>, unit: ClockUnit): Expression<Instant>;
export function minus(value: unknown, amount: Template<number>, unit: string, options?: MoveOptions): Expression<unknown> {
  return temporal("minus", value, amount, unit, options);
}
// The whole units from start to end, negative when end comes first; a part of
// a unit is dropped.
export function between(start: Template<PlainDate>, end: Template<PlainDate>, unit: CalendarUnit): Expression<number>;
export function between(start: Template<PlainTime>, end: Template<PlainTime>, unit: ClockUnit): Expression<number>;
export function between(start: Template<PlainDateTime>, end: Template<PlainDateTime>, unit: CalendarUnit | ClockUnit): Expression<number>;
export function between(start: Template<Instant>, end: Template<Instant>, unit: ClockUnit): Expression<number>;
export function between(start: unknown, end: unknown, unit: string): Expression<number> {
  return temporal("between", start, end, unit);
}
export function quotient(left: Template<number | bigint | Decimal | Rational>, right: Template<number | bigint | Decimal | Rational>): Expression<Rational> {
  return expression({ kind: "operation", operator: "quotient", left, right });
}
export function nodeOf(value: unknown): Node | undefined {
  return typeof value === "object" && value !== null && !isTerm(value)
    ? (value as Expression<unknown>)[EXPRESSION] : undefined;
}
export function childrenOf(value: unknown): readonly unknown[] {
  const node = nodeOf(value);
  if (node?.kind === "bind") return [node.value, node.body];
  if (node?.kind === "map") return [node.values, node.body];
  if (node?.kind === "fold") return [node.values, node.initial, node.body];
  if (node?.kind === "call") return [node.input];
  if (node?.kind === "choose") return [node.yes, node.no];
  if (node?.kind === "construct") return [node.value];
  if (node?.kind === "operation" || node?.kind === "temporal") return [node.left, node.right];
  if (isTerm(value) || atom(value)) return [];
  return Object.values(value as object);
}
export function modelDependencyIssue(template: unknown, definition: AnyBehavior, tags: readonly string[]): string | undefined {
  const inputOwnsRoot = Object.keys(definition.requires).length === 0 && tags.every(tag =>
    definition.input.discriminant === DEPS || Object.hasOwn(definition.input.variants[tag]!.shape, DEPS));
  const declared = new Set<string>();
  if (tags.some(tag => definition.input.discriminant.startsWith(LOCAL) || Object.keys(definition.input.variants[tag]!.shape).some(key => key.startsWith(LOCAL)))) return "Model input uses a reserved local name";
  function inspect(value: unknown, locals: ReadonlySet<string> = new Set()): string | undefined {
    if (isTerm(value) && localRoots(value).some(name => !locals.has(name))) return "Model local reference escapes its binding";
    if (isTerm(value) && !inputOwnsRoot) {
      const data = termData(value);
      const paths = data.kind === "position" ? [data.path] : data.parts.map(part => part.path);
      for (const path of paths) {
        if (path[0] !== DEPS) continue;
        const name = path[1];
        if (name === undefined || !Object.hasOwn(definition.requires, name) || definition.requires[name]?.takes !== "nothing") return `Model requires a declared value dependency ${name ?? "<root>"}`;
      }
    }
    const node = nodeOf(value);
    if (node?.kind === "call") {
      const name = dependencyName(node.dependency);
      if (!Object.hasOwn(definition.requires, name) || definition.requires[name]?.takes !== "input") return "call requires a declared function dependency";
    }
    if (node?.kind === "bind" || node?.kind === "map" || node?.kind === "fold") {
      const names = node.kind === "fold" ? [node.name, node.accumulator] : [node.name];
      if (names.some(name => declared.has(name))) return "Model binding cannot be reused; declare a separate binding for each evaluation";
      names.forEach(name => declared.add(name));
      const before = node.kind === "bind" ? [node.value] : node.kind === "map" ? [node.values] : [node.values, node.initial];
      for (const child of before) { const issue = inspect(child, locals); if (issue) return issue; }
      return inspect(node.body, new Set([...locals, ...names]));
    }
    if (node?.kind === "choose") {
      const issue = inspect(node.condition, locals);
      if (issue) return issue;
    }
    for (const child of childrenOf(value)) {
      const issue = inspect(child, locals);
      if (issue) return issue;
    }
    return undefined;
  }
  return inspect(template);
}
function atom(value: unknown): boolean {
  return value === null || typeof value !== "object" || isDecimal(value) ||
    Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value);
}
export function choicesOf(template: unknown): readonly Extract<Node, { kind: "choose" }>[] {
  const nodes: Extract<Node, { kind: "choose" }>[] = [];
  function visit(value: unknown) {
    const node = nodeOf(value);
    if (node?.kind === "choose" && !nodes.includes(node)) nodes.push(node);
    childrenOf(value).forEach(visit);
  }
  visit(template);
  return nodes;
}
function checkedTemplate(value: unknown, ancestors = new Set<unknown>(), remaining = { value: 10000 }): unknown {
  if (--remaining.value < 0) throw new Error("Model declaration exceeds 10000 nodes");
  if (typeof value === "function" || typeof value === "symbol") throw new Error("Model expressions cannot contain callbacks or symbols");
  if (isTerm(value)) return value;
  if (atom(value)) {
    if (isDecimal(value)) return snapshotValue(value);
    if (typeof value === "string") {
      if (!value.isWellFormed()) throw new Error("Model text must be well-formed Unicode");
      return value.normalize("NFC");
    }
    if (value && typeof value === "object" && !isDecimal(value) && !isRational(value) && !String(value.constructor?.name).startsWith("Plain") && value.constructor?.name !== "Instant") throw new Error("Unsupported model constant");
    return value;
  }
  if (ancestors.has(value)) throw new Error("Model expressions cannot contain cycles");
  const parents = new Set([...ancestors, value]);
  const check = (child: unknown) => checkedTemplate(child, parents, remaining);
  const node = nodeOf(value);
  if (node?.kind === "bind") return expression({ ...node, value: check(node.value), body: check(node.body) });
  if (node?.kind === "map") return expression({ ...node, values: check(node.values), body: check(node.body) });
  if (node?.kind === "fold") return expression({ ...node, values: check(node.values), initial: check(node.initial), body: check(node.body) });
  if (node?.kind === "call") return expression({ ...node, input: check(node.input) });
  if (node?.kind === "choose") return expression({ ...node, yes: check(node.yes), no: check(node.no) });
  if (node?.kind === "construct") return expression({ ...node, value: check(node.value) });
  if (node?.kind === "operation" || node?.kind === "temporal") return expression({ ...node, left: check(node.left), right: check(node.right) });
  return Object.freeze(Array.isArray(value) ? value.map(check) : Object.fromEntries(Object.entries(value as object).map(([key, child]) => [key, check(child)])));
}
export function model<Input, Result, Effect, Deps = unknown>(
  id: string,
  build: (input: TermOf<NoInfer<Input>>, deps: TermOf<NoInfer<Deps>>) => Template<Execution<NoInfer<Result>, NoInfer<Effect>>>,
): RulesDecision<Input, Result, Effect, Deps> {
  const template = checkedTemplate(build(selfTerm<NoInfer<Input>>(), depsTerm<NoInfer<Deps>>()));
  return Object.freeze({
    kind: "rules", id, expression: template,
    guards: choicesOf(template).map(node => ({ kind: "guard" as const, condition: node.condition, orElse: () => { throw new Error("Expression guards are interpreted"); } })),
    otherwise: () => { throw new Error("Expression models are interpreted"); },
  });
}
// Evaluates an expression model. A dependency call that answers a promise is
// awaited, and the evaluation then answers a promise too; one that answers a
// value continues at once, so a model whose dependencies answer values (or
// that calls none) is evaluated synchronously, as the analyses that trace it
// need. `read` is a generator that yields only a pending call.
export function interpret(template: unknown, scope: unknown, options: {
  readonly steps?: number;
  readonly invoke?: (name: string, input: unknown) => unknown;
  readonly observe?: ComparisonObserver;
  readonly distinguish?: (distinction: Branch, outcome: boolean | string) => void;
  readonly arm?: (index: number, outcome: boolean) => void;
} = {}): unknown {
  let remaining = options.steps ?? 100000;
  const choices = choicesOf(template);
  function parsed(schema: Schema<unknown>, value: unknown): unknown {
    const result = schema.parse(value);
    if (!result.success) throw new Error(`Invalid local construction: ${result.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
    return snapshotValue(result.value);
  }
  function* read(value: unknown, current: unknown = scope): Evaluation {
    if (--remaining < 0) throw new EvaluationLimit("Model evaluation step budget exceeded");
    if (isTerm(value)) return readOperand(value, current);
    const node = nodeOf(value);
    if (node?.kind === "bind") return yield* read(node.body, withLocal(current, node.name, parsed(node.schema, yield* read(node.value, current))));
    if (node?.kind === "map" || node?.kind === "fold") {
      const values = yield* read(node.values, current);
      if (!Array.isArray(values)) throw new Error("Iteration expects an array");
      let accumulator = node.kind === "fold" ? parsed(node.output, yield* read(node.initial, current)) : undefined;
      const result: unknown[] = [];
      for (const value of values) {
        const elementScope = withLocal(current, node.name, parsed(node.element, value));
        const iterationScope = node.kind === "fold" ? withLocal(elementScope, node.accumulator, accumulator) : elementScope;
        const next = parsed(node.output, yield* read(node.body, iterationScope));
        if (node.kind === "fold") accumulator = next; else result.push(next);
      }
      return node.kind === "fold" ? accumulator : result;
    }
    if (node?.kind === "call") {
      if (!options.invoke) throw new Error("Dependency calls require an execution environment");
      const answer = options.invoke(dependencyName(node.dependency), yield* read(node.input, current));
      return isPromiseLike(answer) ? yield answer : answer;
    }
    if (node?.kind === "choose") {
      const outcome = holds(node.condition, current, options.observe, options.distinguish);
      options.arm?.(choices.indexOf(node), outcome);
      return yield* read(outcome ? node.yes : node.no, current);
    }
    if (node?.kind === "construct") {
      const parsed = node.schema.parse(yield* read(node.value, current));
      if (!parsed.success) throw new Error(`Invalid construction: ${parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
      return parsed.value;
    }
    if (node?.kind === "temporal") {
      const left = yield* read(node.left, current), right = yield* read(node.right, current);
      return node.operator === "between" ? countBetween(left, right, node.unit) : moveTemporal(node.operator, left, right, node.unit, node.overflow);
    }
    if (node?.kind === "operation") {
      const left = yield* read(node.left, current), right = yield* read(node.right, current);
      if (node.operator === "concat") {
        if (typeof left !== "string" || typeof right !== "string") throw new Error("concat expects strings");
        return (left + right).normalize("NFC");
      }
      if (node.operator === "quotient") return fractionOf(left as number).dividedBy(fractionOf(right as number));
      if (isDecimal(left) && isDecimal(right)) {
        const a = fractionOf(left), b = fractionOf(right);
        return decimalOf(node.operator === "add" ? a.plus(b) : node.operator === "subtract" ? a.minus(b) : node.operator === "multiply" ? a.times(b) : a.dividedBy(b));
      }
      if (isRational(left) && isRational(right)) return node.operator === "add" ? left.plus(right) : node.operator === "subtract" ? left.minus(right) : node.operator === "multiply" ? left.times(right) : left.dividedBy(right);
      if (typeof left === "bigint" && typeof right === "bigint") {
        if (node.operator === "divide" && (right === 0n || left % right !== 0n)) throw new Error("Integer division must be exact and nonzero");
        return node.operator === "add" ? left + right : node.operator === "subtract" ? left - right : node.operator === "multiply" ? left * right : left / right;
      }
      if (typeof left !== "number" || typeof right !== "number") throw new Error("Arithmetic expects matching numeric types");
      if (node.operator === "divide" && right === 0) throw new Error("Division by zero");
      const result = node.operator === "add" ? left + right : node.operator === "subtract" ? left - right : node.operator === "multiply" ? left * right : left / right;
      if (!Number.isFinite(result) || Number.isInteger(result) && !Number.isSafeInteger(result)) throw new Error("Arithmetic result is outside the exact number range");
      return result;
    }
    if (atom(value)) return value;
    if (Array.isArray(value)) {
      const elements: unknown[] = [];
      for (const child of value) elements.push(yield* read(child, current));
      return elements;
    }
    const entries: [string, unknown][] = [];
    for (const [key, child] of Object.entries(value as object)) entries.push([key, yield* read(child, current)]);
    return Object.fromEntries(entries);
  }
  const evaluation = read(template);
  const first = evaluation.next();
  return first.done ? first.value : resume(evaluation, first.value);
}

// A generator over the expression being read: it yields a call's pending
// answer and is resumed with what the answer settles to.
type Evaluation = Generator<PromiseLike<unknown>, unknown, unknown>;

async function resume(evaluation: Evaluation, pending: PromiseLike<unknown>): Promise<unknown> {
  for (;;) {
    let settled: { readonly value: unknown } | { readonly error: unknown };
    try {
      settled = { value: await pending };
    } catch (error) {
      settled = { error };
    }
    const step = "error" in settled ? evaluation.throw(settled.error) : evaluation.next(settled.value);
    if (step.done) return step.value;
    pending = step.value;
  }
}
export interface ModelPath {
  readonly value: unknown;
  readonly steps: readonly Step[];
  readonly choices: readonly { readonly condition: Rule; readonly outcome: boolean }[];
}
export function* modelPaths(template: unknown): Generator<ModelPath> {
  const node = nodeOf(template);
  if (node?.kind === "choose") {
    for (const outcome of outcomesOf(node.condition)) for (const branch of modelPaths(outcome.result ? node.yes : node.no)) {
      yield { value: branch.value, steps: [...outcome.steps, ...branch.steps], choices: [{ condition: node.condition, outcome: outcome.result }, ...branch.choices] };
    }
    return;
  }
  const children = node?.kind === "map" ? [node.values] : node?.kind === "fold" ? [node.values, node.initial] : childrenOf(template);
  if (children.length === 0) { yield { value: template, steps: [], choices: [] }; return; }
  function* product(index: number, before: ModelPath & { values: unknown[] }): Generator<ModelPath & { values: unknown[] }> {
    if (index === children.length) { yield before; return; }
    for (const child of modelPaths(children[index])) yield* product(index + 1, { value: undefined, values: [...before.values, child.value], steps: [...before.steps, ...child.steps], choices: [...before.choices, ...child.choices] });
  }
  for (const path of product(0, { value: undefined, values: [], steps: [], choices: [] })) {
    const value = replaceChildren(template, path.values);
    yield { value, steps: path.steps, choices: path.choices };
  }
}

export function replaceChildren(template: unknown, values: readonly unknown[]): unknown {
  const node = nodeOf(template);
  if (node?.kind === "bind") return expression({ ...node, value: values[0], body: values[1] });
  if (node?.kind === "map") return expression({ ...node, values: values[0], body: values.length > 1 ? values[1] : node.body });
  if (node?.kind === "fold") return expression({ ...node, values: values[0], initial: values[1], body: values.length > 2 ? values[2] : node.body });
  if (node?.kind === "call") return expression({ ...node, input: values[0] });
  if (node?.kind === "construct") return expression({ ...node, value: values[0] });
  if (node?.kind === "operation" || node?.kind === "temporal") return expression({ ...node, left: values[0], right: values[1] });
  return Array.isArray(template) ? values : Object.fromEntries(Object.keys(template as object).map((key, index) => [key, values[index]]));
}
