import { Decimal } from "decimal.js";
import { Rational, isRational, fractionOf, decimalOf, EvaluationLimit } from "./exact.js";
import type { Execution, RulesDecision, ValueDepsOf, Branch } from "./behavior.js";
import type { Rule, Term, TermOf, ComparisonObserver } from "./rule.js";
import { depsTerm, holds, isDecimal, isTerm, readOperand, selfTerm } from "./rule.js";
import type { Schema } from "./schema.js";
import type { Step } from "./ways.js";
import { outcomesOf } from "./ways.js";

const EXPRESSION = Symbol.for("chisel.expression");
export interface Expression<T> {
  readonly [EXPRESSION]: Node;
  readonly output?: T;
}
export type Template<T> = Term<T> | Expression<T> | (T extends readonly (infer E)[]
  ? readonly Template<E>[]
  : T extends object ? { readonly [K in keyof T]: Template<T[K]> } : T);
export type Node =
  | { readonly kind: "choose"; readonly condition: Rule; readonly yes: unknown; readonly no: unknown }
  | { readonly kind: "construct"; readonly schema: Schema<unknown>; readonly value: unknown }
  | { readonly kind: "operation"; readonly operator: "add" | "subtract" | "multiply" | "divide" | "quotient" | "concat"; readonly left: unknown; readonly right: unknown };

function expression<T>(node: Node): Expression<T> {
  return Object.freeze({ [EXPRESSION]: Object.freeze(node) });
}
export function choose<T>(condition: Rule, yes: Template<T>, no: Template<NoInfer<T>>): Expression<T> {
  return expression({ kind: "choose", condition, yes, no });
}
export function construct<T>(schema: Schema<T>, value: Template<NoInfer<T extends object ? Pick<T, Extract<keyof T, string | number>> : T>>): Expression<T> {
  return expression({ kind: "construct", schema: schema as Schema<unknown>, value });
}
export function concat(left: Template<string>, right: Template<string>): Expression<string> {
  return expression({ kind: "operation", operator: "concat", left, right });
}
export function arithmetic<T extends number | bigint | Rational | Decimal>(operator: "add" | "subtract" | "multiply" | "divide", left: Template<T>, right: Template<NoInfer<T>>): Expression<T> {
  return expression({ kind: "operation", operator, left, right });
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
  if (node?.kind === "choose") return [node.yes, node.no];
  if (node?.kind === "construct") return [node.value];
  if (node?.kind === "operation") return [node.left, node.right];
  if (isTerm(value) || atom(value)) return [];
  return Object.values(value as object);
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
    if (isDecimal(value)) { const copy = new Decimal(value); Object.freeze(copy.d); return Object.freeze(copy); }
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
  if (node?.kind === "choose") return expression({ ...node, yes: check(node.yes), no: check(node.no) });
  if (node?.kind === "construct") return expression({ ...node, value: check(node.value) });
  if (node?.kind === "operation") return expression({ ...node, left: check(node.left), right: check(node.right) });
  return Object.freeze(Array.isArray(value) ? value.map(check) : Object.fromEntries(Object.entries(value as object).map(([key, child]) => [key, check(child)])));
}
export function model<Input, Result, Effect, Deps = unknown>(
  id: string,
  build: (input: TermOf<NoInfer<Input>>, deps: TermOf<ValueDepsOf<NoInfer<Deps>>>) => Template<Execution<NoInfer<Result>, NoInfer<Effect>>>,
): RulesDecision<Input, Result, Effect, Deps> {
  const template = checkedTemplate(build(selfTerm<NoInfer<Input>>(), depsTerm<ValueDepsOf<NoInfer<Deps>>>()));
  return Object.freeze({
    kind: "rules", id, expression: template,
    guards: choicesOf(template).map(node => ({ kind: "guard" as const, condition: node.condition, orElse: () => { throw new Error("Expression guards are interpreted"); } })),
    otherwise: () => { throw new Error("Expression models are interpreted"); },
  });
}
export function interpret(template: unknown, scope: unknown, options: {
  readonly steps?: number;
  readonly observe?: ComparisonObserver;
  readonly distinguish?: (distinction: Branch, outcome: boolean | string) => void;
  readonly arm?: (index: number, outcome: boolean) => void;
} = {}): unknown {
  let remaining = options.steps ?? 100000;
  const choices = choicesOf(template);
  function read(value: unknown): unknown {
    if (--remaining < 0) throw new EvaluationLimit("Model evaluation step budget exceeded");
    if (isTerm(value)) return readOperand(value, scope);
    const node = nodeOf(value);
    if (node?.kind === "choose") {
      const outcome = holds(node.condition, scope, options.observe, options.distinguish);
      options.arm?.(choices.indexOf(node), outcome);
      return read(outcome ? node.yes : node.no);
    }
    if (node?.kind === "construct") {
      const parsed = node.schema.parse(read(node.value));
      if (!parsed.success) throw new Error(`Invalid construction: ${parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
      return parsed.value;
    }
    if (node?.kind === "operation") {
      const left = read(node.left), right = read(node.right);
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
    return Array.isArray(value) ? value.map(read) : Object.fromEntries(Object.entries(value as object).map(([key, child]) => [key, read(child)]));
  }
  return read(template);
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
  const children = childrenOf(template);
  if (children.length === 0) { yield { value: template, steps: [], choices: [] }; return; }
  function* product(index: number, before: ModelPath & { values: unknown[] }): Generator<ModelPath & { values: unknown[] }> {
    if (index === children.length) { yield before; return; }
    for (const child of modelPaths(children[index])) yield* product(index + 1, { value: undefined, values: [...before.values, child.value], steps: [...before.steps, ...child.steps], choices: [...before.choices, ...child.choices] });
  }
  for (const path of product(0, { value: undefined, values: [], steps: [], choices: [] })) {
    const value = node?.kind === "construct" ? expression({ ...node, value: path.values[0] })
      : node?.kind === "operation" ? expression({ ...node, left: path.values[0], right: path.values[1] })
      : Array.isArray(template) ? path.values : Object.fromEntries(Object.keys(template as object).map((key, index) => [key, path.values[index]]));
    yield { value, steps: path.steps, choices: path.choices };
  }
}
