import { isPromiseLike, snapshotValue } from "./data.js";
import type { Decimal } from "decimal.js";
import { Rational, isRational, fractionOf, decimalOf, EvaluationLimit } from "./exact.js";
import type { AnyBehavior, Execution, RulesDecision, Branch } from "./behavior.js";
import type { Replacement, Rule, Term, TermOf, ComparisonObserver } from "./rule.js";
import { DEPS, depsTerm, describeTerm, holds, rebaseRule, rebaseTerm, pathsRead as pathsReadOfRule, isDecimal, isTerm, linearCombination, positionData, readOperand, selfTerm, substitutedOperand, substitutedRule, termData, rootTerm, positionTerm, withLocal } from "./rule.js";
import { isVariantsSchema } from "./schema.js";
import type { Schema, AnyVariantsSchema, Infer, Tags, VariantOf } from "./schema.js";
import type { Step } from "./ways.js";
import { outcomesOf } from "./outcomes.js";
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
// A local's name says what it holds, for reports (localLabel): a dependency's
// answer `#local:call:<dependency>:<n>`, an element `#local:<n>@<collection>[]`,
// an accumulator `#local:<n>@accumulator`, any other `#local:<n>`.
function localName(value?: unknown, role?: "element" | "accumulator"): string {
  const node = nodeOf(value);
  if (node?.kind === "call") return `${LOCAL}call:${dependencyName(node.dependency)}:${nextLocal++}`;
  if (role === "accumulator") return `${LOCAL}${nextLocal++}@accumulator`;
  if (role === "element") {
    const position = isTerm(value) ? positionData(value) : undefined;
    const over = position?.measure === "value" && position.path.length > 0 && !position.path[0]!.startsWith("#") ? `$.${position.path.join(".")}[]` : "element";
    return `${LOCAL}${nextLocal++}@${over}`;
  }
  const described = node?.kind === "choose" ? "choose" : node === undefined ? undefined : describeOperand(value);
  return described === undefined || described === "…" ? `${LOCAL}${nextLocal++}` : `${LOCAL}${nextLocal++}@${described}`;
}

function describeOperand(value: unknown): string {
  if (isTerm(value)) {
    const position = positionData(value);
    if (position === undefined) return "…";
    if (position.path[0] === DEPS) return ["deps", ...position.path.slice(1)].join(".");
    return position.path.some(key => key.startsWith("#")) ? "…" : describeTerm(value);
  }
  const node = nodeOf(value);
  if (node?.kind === "call") return `${dependencyName(node.dependency)}()`;
  if (node?.kind === "operation" || node?.kind === "temporal") return `${node.operator}(${describeOperand(node.left)}, ${describeOperand(node.right)})`;
  if (node !== undefined) return "…";
  return typeof value === "string" ? JSON.stringify(value) : atom(value) ? String(value) : "…";
}
export function bind<Value, Result>(schema: Schema<Value>, value: NoInfer<Template<Value>>, build: (value: TermOf<Value>) => Template<Result>): Expression<Result> {
  const name = localName(value);
  return expression({ kind: "bind", name, schema: schema as Schema<unknown>, value, body: build(rootTerm<Value>(name)) });
}
export function matchValue<S extends AnyVariantsSchema, Result>(schema: S, value: NoInfer<Template<Infer<S>>>, cases: { readonly [Tag in Tags<S>]: (value: TermOf<VariantOf<S, Tag>>) => Template<Result> }): Expression<Result> {
  const tags = schema.variantTags as readonly Tags<S>[];
  if (tags.length === 0 || Object.keys(cases).length !== tags.length || tags.some(tag => !Object.hasOwn(cases, tag) || typeof cases[tag] !== "function")) throw new Error("matchValue requires exactly one body for every variant");
  const name = localName(value);
  const handlers = cases as unknown as Readonly<Record<string, (value: TermOf<unknown>) => unknown>>;
  const bodies = tags.map(tag => handlers[tag]!(rootTerm(name)));
  let body: unknown = bodies.at(-1);
  for (let index = tags.length - 2; index >= 0; index--) body = expression({ kind: "choose", condition: { kind: "compare", left: positionTerm([name, schema.discriminant], "value"), operator: "==", right: tags[index] }, yes: bodies[index], no: body });
  return expression({ kind: "bind", name, schema, value, body });
}
export function map<Element, Result>(element: Schema<Element>, output: Schema<Result>, values: Template<readonly NoInfer<Element>[]>, build: (value: TermOf<Element>) => NoInfer<Template<Result>>): Expression<readonly Result[]> {
  const name = localName(values, "element");
  return expression({ kind: "map", name, element: element as Schema<unknown>, output: output as Schema<unknown>, values, body: build(rootTerm<Element>(name)) });
}
export function fold<Element, Accumulator>(element: Schema<Element>, output: Schema<Accumulator>, values: Template<readonly NoInfer<Element>[]>, initial: NoInfer<Template<Accumulator>>, build: (accumulator: TermOf<Accumulator>, value: TermOf<Element>) => NoInfer<Template<Accumulator>>): Expression<Accumulator> {
  const name = localName(values, "element"), accumulator = localName(undefined, "accumulator");
  return expression({ kind: "fold", name, accumulator, element: element as Schema<unknown>, output: output as Schema<unknown>, values, initial, body: build(rootTerm<Accumulator>(accumulator), rootTerm<Element>(name)) });
}
export function isAnswer(local: string): boolean {
  return local.startsWith(`${LOCAL}call:`);
}

// Each dependency's answer a bind holds outside a map or a fold, by its local's
// name, with the schema it is bound under and the call it holds the answer of.
export function bindingsOf(template: unknown): readonly (readonly [string, Schema<unknown>])[] {
  return answersOf(template).map(({ name, schema }) => [name, schema] as const);
}

export function answersOf(template: unknown): readonly { readonly name: string; readonly schema: Schema<unknown>; readonly dependency: string; readonly input: unknown }[] {
  const node = nodeOf(template);
  const call = node?.kind === "bind" ? nodeOf(node.value) : undefined;
  const own = node?.kind === "bind" && call?.kind === "call" && isAnswer(node.name)
    ? [{ name: node.name, schema: node.schema, dependency: dependencyName(call.dependency), input: call.input }]
    : [];
  return [...own, ...childrenOf(template).flatMap(answersOf)];
}
export function localRoots(value: unknown): readonly string[] {
  if (isTerm(value)) {
    const data = termData(value);
    return (data.kind === "position" ? [data.path] : data.parts.map(part => part.path)).flatMap(path => path[0]?.startsWith(LOCAL) ? [path[0]] : []);
  }
  return childrenOf(value).flatMap(localRoots);
}
export function choose<Yes, No = Yes>(condition: Rule, yes: Template<Yes>, no: Template<No>): Expression<Yes | No> {
  return expression({ kind: "choose", condition, yes, no });
}
export function construct<T>(schema: Schema<T>, value: NoInfer<Template<T extends object ? Pick<T, Extract<keyof T, string | number>> : T>>): Expression<T> {
  return expression({ kind: "construct", schema: schema as Schema<unknown>, value });
}
export function call<Input, Output>(dependency: Term<(input: Input) => Output>, input: NoInfer<Template<Input>>): Expression<Output> {
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
export function arithmetic<T extends number | bigint | Rational | Decimal>(operator: "add" | "subtract" | "multiply" | "divide", left: Template<T>, right: NoInfer<Template<T>>): Expression<T> {
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
  const overflow = options.overflow ?? "constrain";
  // Refused here, as Temporal would refuse it on every run: the proof reads no overflow.
  if (overflow !== "constrain" && overflow !== "reject") throw new Error(`${operator} takes an overflow of "constrain" or "reject", not ${String(overflow)}`);
  return expression({ kind: "temporal", operator, left, right, unit, overflow });
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
  const inputOwnsRoot = Object.keys(definition.dependencies).length === 0 && tags.every(tag =>
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
        if (name === undefined || !Object.hasOwn(definition.dependencies, name) || definition.dependencies[name]?.takes !== "nothing") return `Model requires a declared value dependency ${name ?? "<root>"}`;
      }
    }
    const node = nodeOf(value);
    if (node?.kind === "call") {
      const name = dependencyName(node.dependency);
      if (!Object.hasOwn(definition.dependencies, name) || definition.dependencies[name]?.takes !== "input") return "call requires a declared function dependency";
    }
    if (node?.kind === "bind" || node?.kind === "map" || node?.kind === "fold") {
      const names = node.kind === "fold" ? [node.name, node.accumulator] : [node.name];
      if (names.some(name => declared.has(name))) return "Model binding cannot be reused; declare a separate binding for each evaluation";
      names.forEach(name => declared.add(name));
      const refused = node.kind === "bind" ? answerRefusedBy(node.value, node.schema, definition) : undefined;
      if (refused) return refused;
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
// A call whose answer is a sum bound under a sum sharing none of its cases: every answer fails to bind.
function answerRefusedBy(value: unknown, bound: Schema<unknown>, definition: AnyBehavior): string | undefined {
  const call = nodeOf(value);
  if (call?.kind !== "call") return undefined;
  const name = dependencyName(call.dependency);
  const output = Object.hasOwn(definition.dependencies, name) ? definition.dependencies[name]!.output : undefined;
  if (output === undefined || !isVariantsSchema(output) || !isVariantsSchema(bound) || output.discriminant !== bound.discriminant) return undefined;
  const declared = output.variantTags as readonly string[];
  return declared.some(tag => (bound.variantTags as readonly string[]).includes(tag)) ? undefined
    : `Model binds the answer of ${name} under a schema taking none of the cases it declares (${declared.join(", ")}), so every run fails`;
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
    guards: guardsOf(template) as RulesDecision<Input, Result, Effect, Deps>["guards"],
    otherwise: () => { throw new Error("Expression models are interpreted"); },
  });
}
// Evaluates an expression model. A dependency call that answers a promise is
// awaited, and the evaluation then answers a promise too; one that answers a
// value continues at once, so a model whose dependencies answer values (or
// that calls none) is evaluated synchronously, as the analyses that trace it
// need. `read` is a generator that yields only a pending call.
// A rewrite of one fold a run is put to (Souther's ADR-0126): the walk
// stopping after its first step, or every step handed the seed in place of
// what the step before it answered. It is set around a run, as Souther's
// per-thread selector is, rather than threaded through every caller: the runs
// it is set for are synchronous, so nothing else runs while it is set.
export type Walk = "after one step" | "from the seed";
let walkRewrite: { readonly node: unknown; readonly walk: Walk } | undefined;
let walkObserver: ((node: unknown, elements: number) => void) | undefined;
export function withWalk<T>(
  rewrite: { readonly node: unknown; readonly walk: Walk } | undefined,
  observer: ((node: unknown, elements: number) => void) | undefined,
  run: () => T,
): T {
  const [rewriteBefore, observerBefore] = [walkRewrite, walkObserver];
  walkRewrite = rewrite;
  walkObserver = observer;
  try {
    return run();
  } finally {
    walkRewrite = rewriteBefore;
    walkObserver = observerBefore;
  }
}

// The step a run stopped at — an operation past its type, a division by
// nought, a construction its schema refuses, a move past a temporal type's
// range — handed to the observer set around the run (Souther 0.5.0 says a stop
// of the step it is at, not of a comparison it was found on the way to).
export type StopStep = Extract<Node, { kind: "operation" | "temporal" | "construct" }>;
let stopObserver: ((step: StopStep, error: unknown) => void) | undefined;
export function withStops<T>(observer: (step: StopStep, error: unknown) => void, run: () => T): T {
  const before = stopObserver;
  stopObserver = observer;
  try {
    return run();
  } finally {
    stopObserver = before;
  }
}
function stopping<T>(step: StopStep, compute: () => T): T {
  if (stopObserver === undefined) return compute();
  try {
    return compute();
  } catch (error) {
    stopObserver(step, error);
    throw error;
  }
}

export function interpret(template: unknown, scope: unknown, options: {
  readonly steps?: number;
  readonly invoke?: (name: string, input: unknown) => unknown;
  readonly observe?: ComparisonObserver;
  readonly distinguish?: (distinction: Branch, outcome: boolean | string) => void;
  readonly arm?: (index: number, outcome: boolean) => void;
  // The steps one element of a map or a fold took through its body, which are
  // not steps of the way through the model around it.
  readonly iterate?: (iteration: Node, steps: readonly Step[]) => void;
  // A caller that cannot await abandons the evaluation at the first pending
  // call instead of resuming it, so no later call is made behind its back.
  readonly onPending?: (pending: PromiseLike<unknown>) => never;
} = {}): unknown {
  let remaining = options.steps ?? 100000;
  const choices = choicesOf(template);
  let distinguishing = options.distinguish;
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
      const seed = accumulator;
      const walk = node.kind === "fold" && walkRewrite?.node === node ? walkRewrite.walk : undefined;
      if (node.kind === "fold") walkObserver?.(node, values.length);
      const result: unknown[] = [];
      for (const [index, value] of values.entries()) {
        if (walk === "after one step" && index > 0) break;
        if (walk === "from the seed") accumulator = seed;
        const elementScope = withLocal(current, node.name, parsed(node.element, value));
        const iterationScope = node.kind === "fold" ? withLocal(elementScope, node.accumulator, accumulator) : elementScope;
        const around = distinguishing;
        const steps: Step[] = [];
        distinguishing = (distinction, outcome) => steps.push({ distinction, outcome });
        let answer: unknown;
        try {
          answer = yield* read(node.body, iterationScope);
        } finally {
          // An element whose body fails took the way it failed on.
          distinguishing = around;
          options.iterate?.(node, steps);
        }
        const next = parsed(node.output, answer);
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
      const outcome = holds(node.condition, current, options.observe, distinguishing);
      options.arm?.(choices.indexOf(node), outcome);
      return yield* read(outcome ? node.yes : node.no, current);
    }
    if (node?.kind === "construct") {
      const value = yield* read(node.value, current);
      return stopping(node, () => {
        const parsed = node.schema.parse(value);
        if (!parsed.success) throw new Error(`Invalid construction: ${parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
        return parsed.value;
      });
    }
    if (node?.kind === "temporal") {
      const left = yield* read(node.left, current), right = yield* read(node.right, current);
      return stopping(node, () => node.operator === "between" ? countBetween(left, right, node.unit) : moveTemporal(node.operator, left, right, node.unit, node.overflow));
    }
    if (node?.kind === "operation") {
      const left = yield* read(node.left, current), right = yield* read(node.right, current);
      return stopping(node, () => operate(node, left, right));
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
  if (first.done) return first.value;
  if (options.onPending !== undefined) {
    evaluation.return(undefined);
    return options.onPending(first.value);
  }
  return resume(evaluation, first.value);
}

function operate(node: Extract<Node, { kind: "operation" }>, left: unknown, right: unknown): unknown {
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

// What a model binds, read where the binding is read, so its choices are
// conditions on the input and measured like any guard:
// - a field of the input is the field itself; bound under another schema than
//   the field's, the binding is kept to parse the field with it;
// - a sum or difference of input numbers, a multiple of one by a whole number,
//   a constant, or an object of such values is read as that expression, unless
//   it is computed and the schema it is bound under has invariants of its own.
// A binding of anything else (a quotient, a concatenation, a temporal value,
// an iteration's answer) is left as it is and read as a value of its own.
export function inlineInputBindings(template: unknown, schemaAt: (path: readonly string[]) => Schema<unknown> | undefined): unknown {
  let inlined = false;
  type Alias = (rest: readonly string[]) => Replacement | undefined;
  // Integers and decimals are added exactly at run time as in an expression;
  // a number is added in floating point, so a sum of numbers is not read.
  const kindAt = (path: readonly string[]) => (schemaAt(path) as { readonly kind?: string } | undefined)?.kind;
  const aliasOf = (value: unknown): Alias | undefined => {
    if (isTerm(value)) {
      const data = termData(value);
      if (data.kind === "position") {
        return data.measure === "value" ? rest => ({ with: rest.length === 0 ? value : positionTerm([...data.path, ...rest], "value") }) : undefined;
      }
      return rest => (rest.length === 0 ? { with: value } : undefined);
    }
    const node = nodeOf(value);
    if (node === undefined) {
      if (atom(value)) return rest => (rest.length === 0 ? { with: value } : undefined);
      return rest => {
        const [key, ...more] = rest;
        if (key === undefined || !Object.hasOwn(value as object, key)) return undefined;
        return aliasOf((value as Record<string, unknown>)[key])?.(more);
      };
    }
    if (node.kind === "construct") return aliasOf(node.value);
    if (node.kind !== "operation" || !["add", "subtract", "multiply", "quotient"].includes(node.operator)) return undefined;
    const kindOf = (side: unknown): "integer" | "decimal" | "either" | undefined => {
      if (typeof side === "number") return Number.isSafeInteger(side) ? "either" : undefined;
      if (isDecimal(side)) return "decimal";
      if (!isTerm(side)) return undefined;
      const data = termData(side);
      const kinds = new Set((data.kind === "position" ? [data.path] : data.parts.map(part => part.path)).map(path => (path[0]!.startsWith(LOCAL) ? undefined : kindAt(path))));
      if (data.kind === "linear") kinds.add(isDecimal(data.constant) ? "decimal" : "integer");
      return kinds.size === 1 && (kinds.has("integer") || kinds.has("decimal")) ? [...kinds][0] as "integer" | "decimal" : undefined;
    };
    const left = aliasOf(node.left)?.([]), right = aliasOf(node.right)?.([]);
    if (left === undefined || right === undefined || left.over !== undefined || right.over !== undefined) return undefined;
    const [leftKind, rightKind] = [kindOf(left.with), kindOf(right.with)];
    if (leftKind === undefined || rightKind === undefined) return undefined;
    // A decimal and a plain number are no sum the model computes as written.
    if (leftKind !== rightKind && leftKind !== "either" && rightKind !== "either") return undefined;
    if (node.operator !== "multiply" && (leftKind === "decimal" || rightKind === "decimal") && (leftKind === "either" || rightKind === "either")) return undefined;
    if (node.operator === "quotient") {
      // A quotient by a whole number stands in a comparison multiplied out.
      const divisor = right.with;
      return typeof divisor === "number" && Number.isSafeInteger(divisor) && divisor !== 0
        ? rest => (rest.length === 0 ? { with: left.with, over: divisor } : undefined)
        : undefined;
    }
    const combined = node.operator === "multiply"
      ? (Number.isSafeInteger(right.with) ? linearCombination([{ operand: left.with, coefficient: right.with as number }])
        : Number.isSafeInteger(left.with) ? linearCombination([{ operand: right.with, coefficient: left.with as number }]) : undefined)
      : linearCombination([{ operand: left.with, coefficient: 1 }, { operand: right.with, coefficient: node.operator === "add" ? 1 : -1 }]);
    if (combined === undefined) return undefined;
    const decimal = leftKind === "decimal" || rightKind === "decimal";
    const exact = decimal && typeof combined === "number" ? decimalOf(fractionOf(combined)) : combined;
    return rest => (rest.length === 0 ? { with: exact } : undefined);
  };
  // A local is bound once, so a condition or a node written in two places is
  // rewritten alike in both, and stands for one rewritten object.
  const rewrittenRules = new Map<Rule, Rule>();
  const rewrittenNodes = new Map<object, unknown>();
  const visit = (value: unknown, aliases: ReadonlyMap<string, Alias>): unknown => {
    const node = nodeOf(value);
    if (node === undefined) return rewrite(value, aliases);
    if (!rewrittenNodes.has(node)) rewrittenNodes.set(node, rewrite(value, aliases));
    return rewrittenNodes.get(node);
  };
  const rewrite = (value: unknown, aliases: ReadonlyMap<string, Alias>): unknown => {
    const replace = (path: readonly string[]) => (path.length > 0 ? aliases.get(path[0]!)?.(path.slice(1)) : undefined);
    if (isTerm(value)) {
      if (aliases.size === 0) return value;
      const found = substitutedOperand(value, replace);
      return found === undefined || found.over !== undefined ? value : found.with;
    }
    const node = nodeOf(value);
    if (node === undefined) {
      if (atom(value)) return value;
      return Array.isArray(value) ? value.map(item => visit(item, aliases))
        : Object.fromEntries(Object.entries(value as object).map(([key, child]) => [key, visit(child, aliases)]));
    }
    switch (node.kind) {
      case "bind": {
        const bound = visit(node.value, aliases);
        const position = isTerm(bound) ? positionData(bound) : undefined;
        if (position !== undefined && position.measure === "value" && position.path.length > 0 && !position.path[0]!.startsWith(LOCAL)) {
          inlined = true;
          // The binding is kept, so the field is still parsed with its schema
          // and a read the field cannot stand in for still reads the local.
          const body = visit(node.body, new Map([...aliases, [node.name, rest => ({ with: positionTerm([...position.path, ...rest], "value") })]]));
          return expression({ ...node, value: bound, body });
        }
        // A computed value bound under a schema with invariants may be one the
        // schema refuses at run time, which the expression it would stand for
        // does not say, so it stays a local of its own.
        const refusable = nodeOf(bound) !== undefined && node.schema.invariants.length > 0;
        const alias = isAnswer(node.name) || refusable ? undefined : aliasOf(bound);
        if (alias !== undefined) inlined = true;
        return expression({ ...node, value: bound, body: visit(node.body, alias === undefined ? aliases : new Map([...aliases, [node.name, alias]])) });
      }
      case "choose": {
        if (!rewrittenRules.has(node.condition)) rewrittenRules.set(node.condition, aliases.size === 0 ? node.condition : substitutedRule(node.condition, replace) ?? node.condition);
        const condition = rewrittenRules.get(node.condition)!;
        return expression({ ...node, condition, yes: visit(node.yes, aliases), no: visit(node.no, aliases) });
      }
      case "map":
        return expression({ ...node, values: visit(node.values, aliases), body: visit(node.body, aliases) });
      case "fold":
        return expression({ ...node, values: visit(node.values, aliases), initial: visit(node.initial, aliases), body: visit(node.body, aliases) });
      case "call":
        return expression({ ...node, input: visit(node.input, aliases) });
      case "construct":
        return expression({ ...node, value: visit(node.value, aliases) });
      case "operation":
      case "temporal":
        return expression({ ...node, left: visit(node.left, aliases), right: visit(node.right, aliases) });
    }
  };
  const result = visit(template, new Map());
  return inlined ? result : template;
}

export function guardsOf(template: unknown): RulesDecision<unknown, unknown, unknown>["guards"] {
  return choicesOf(template).map(node => ({ kind: "guard" as const, condition: node.condition, orElse: () => { throw new Error("Expression guards are interpreted"); } }));
}

// The calls a model makes, by dependency, with the argument each is written with.
export function callsIn(template: unknown): readonly { readonly dependency: string; readonly input: unknown }[] {
  const node = nodeOf(template);
  const own = node?.kind === "call" ? [{ dependency: dependencyName(node.dependency), input: node.input }] : [];
  return [...own, ...childrenOf(template).flatMap(callsIn)];
}

// The input with an argument written so it reads `value`: each field of the
// input the argument reads takes the part of `value` it stands at, and a
// constant must already be `value`. Undefined where the argument is computed
// or reads anything but the input.
export function writtenArgument(input: unknown, argument: unknown, value: unknown): unknown {
  if (isTerm(argument)) {
    const position = positionData(argument);
    if (position === undefined || position.measure !== "value") return undefined;
    const [first] = position.path;
    if (first !== undefined && (first === DEPS || first.startsWith(LOCAL))) return undefined;
    return writePath(input, position.path, value);
  }
  if (nodeOf(argument) !== undefined) return undefined;
  if (atom(argument)) return deepEqualValue(argument, value) ? input : undefined;
  if (typeof value !== "object" || value === null || Array.isArray(argument) !== Array.isArray(value)) return undefined;
  const keys = Object.keys(argument as object);
  if (keys.length !== Object.keys(value).length) return undefined;
  let written: unknown = input;
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) return undefined;
    written = writtenArgument(written, (argument as Record<string, unknown>)[key], (value as Record<string, unknown>)[key]);
    if (written === undefined) return undefined;
  }
  return written;
}

function writePath(value: unknown, path: readonly string[], leaf: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return leaf;
  const record = (typeof value === "object" && value !== null ? value : {}) as Readonly<Record<string, unknown>>;
  return { ...record, [key]: writePath(record[key], rest, leaf) };
}

function deepEqualValue(left: unknown, right: unknown): boolean {
  return left === right || (isDecimal(left) && isDecimal(right) && left.equals(right));
}

// Every map and fold in a model with the steps the choices around it take to
// reach it, one entry per way of reaching it.
export interface IterationEntry { readonly node: Extract<Node, { kind: "map" | "fold" }>; readonly steps: readonly Step[] }
export function* iterationEntries(template: unknown, steps: readonly Step[] = []): Generator<IterationEntry> {
  const node = nodeOf(template);
  if (node?.kind === "choose") {
    // A choice whose branches hold no iteration is not expanded: its outcomes may be far more than any iteration needs.
    if (iterationsOf(node.yes).length === 0 && iterationsOf(node.no).length === 0) return;
    for (const outcome of outcomesOf(node.condition)) yield* iterationEntries(outcome.result ? node.yes : node.no, [...steps, ...outcome.steps]);
    return;
  }
  if (node?.kind === "map" || node?.kind === "fold") yield { node, steps };
  for (const child of childrenOf(template)) yield* iterationEntries(child, steps);
}

// Every map and fold in a model, each with the body one element is read in.
export function iterationsOf(template: unknown): readonly Extract<Node, { kind: "map" | "fold" }>[] {
  const node = nodeOf(template);
  const own = node?.kind === "map" || node?.kind === "fold" ? [node] : [];
  return [...own, ...childrenOf(template).flatMap(iterationsOf)];
}

// The values a model reads that no input field holds, each under the schema it
// takes, besides a dependency's answer: what a bind holds that is read as a
// value of its own, an element of a map or a fold, and a fold's accumulator.
// `opaque` where the input settles the value in a way no position shows, so a
// way reading it is told only by a row taking it: a computed value, an
// accumulator, and an element of anything but an array the input holds.
export function localsOf(template: unknown, opaque: ReadonlySet<string> = new Set()): readonly { readonly name: string; readonly schema: Schema<unknown>; readonly opaque: boolean }[] {
  const node = nodeOf(template);
  const rootedIn = (value: unknown, seen: ReadonlySet<string>): boolean => {
    const position = isTerm(value) ? positionData(value) : undefined;
    const first = position?.path[0];
    return position !== undefined && position.measure === "value" && first !== undefined && first !== DEPS && !isAnswer(first) && !seen.has(first);
  };
  if (node?.kind === "bind" && !isAnswer(node.name)) {
    const inner = new Set([...opaque, node.name]);
    return [{ name: node.name, schema: node.schema, opaque: true }, ...childrenOf(template).flatMap(child => localsOf(child, inner))];
  }
  if (node?.kind === "map" || node?.kind === "fold") {
    const elementOpaque = !rootedIn(node.values, opaque);
    const own = [{ name: node.name, schema: node.element, opaque: elementOpaque }, ...(node.kind === "fold" ? [{ name: node.accumulator, schema: node.output, opaque: true }] : [])];
    const inner = new Set([...opaque, ...own.filter(local => local.opaque).map(local => local.name)]);
    return [...own, ...childrenOf(template).flatMap(child => localsOf(child, inner))];
  }
  return childrenOf(template).flatMap(child => localsOf(child, opaque));
}

// The top-level input fields a run of the model may turn on: every field it
// reads, since a value computed before a choice may throw on one, less what a
// dependency is asked where `matters` says neither its answer nor its refusal
// of the argument differs with it. Undefined where the model reads the whole
// input.
export function fieldsTurnedOn(template: unknown, matters: (dependency: string, argument: unknown) => boolean = () => true): ReadonlySet<string> | undefined {
  const fields = new Set<string>();
  let whole = false;
  const add = (path: readonly string[]) => {
    if (path.length === 0) whole = true;
    else if (!path[0]!.startsWith(LOCAL) && path[0] !== DEPS) fields.add(path[0]!);
  };
  const visit = (value: unknown): void => {
    if (isTerm(value)) {
      const data = termData(value);
      (data.kind === "position" ? [data.path] : data.parts.map(part => part.path)).forEach(add);
      return;
    }
    const node = nodeOf(value);
    if (node?.kind === "choose") pathsReadOfRule(node.condition).forEach(add);
    if (node?.kind === "call" && !matters(dependencyName(node.dependency), node.input)) return;
    childrenOf(value).forEach(visit);
  };
  visit(template);
  return whole ? undefined : fields;
}

// The rules and nodes of a rewritten model standing for those of the model as
// written, read off the two trees side by side: the rewrite keeps every node
// and the shape of every condition.
export interface Translation {
  readonly rules: ReadonlyMap<object, object>;
  readonly nodes: ReadonlyMap<object, object>;
}
export function translationOf(written: unknown, rewritten: unknown): Translation {
  const rules = new Map<object, object>();
  const nodes = new Map<object, object>();
  const pairRules = (a: Rule, b: Rule): void => {
    if (a === b) return;
    rules.set(a, b);
    if ((a.kind === "and" || a.kind === "or") && (b.kind === "and" || b.kind === "or")) a.rules.forEach((part, index) => b.rules[index] && pairRules(part, b.rules[index]!));
    if (a.kind === "not" && b.kind === "not") pairRules(a.rule, b.rule);
    if ((a.kind === "all" || a.kind === "any") && (b.kind === "all" || b.kind === "any")) pairRules(a.each, b.each);
  };
  const walk = (a: unknown, b: unknown): void => {
    if (a === b) return;
    const left = nodeOf(a), right = nodeOf(b);
    if (left !== undefined && right !== undefined) {
      nodes.set(left, right);
      if (left.kind === "choose" && right.kind === "choose") pairRules(left.condition, right.condition);
    }
    const [first, second] = [childrenOf(a), childrenOf(b)];
    first.forEach((child, index) => walk(child, second[index]));
  };
  walk(written, rewritten);
  return { rules, nodes };
}
