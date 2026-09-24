import type { Temporal as TemporalTypes } from "temporal-spec";

export type Comparable = number | string | TemporalTypes.Instant;

// Symbol.for, not Symbol(): the CLI loads spec files through tsImport in a
// separate module graph, and a per-module symbol would not recognise their terms.
const TERM = Symbol.for("chisel.term");

export interface TermData {
  readonly path: readonly string[];
  readonly measure: "value" | "length";
}

export type Term<T> = {
  readonly [TERM]: TermData;
  readonly __value?: { bivariant(value: T): void }["bivariant"];
};

export type Operand<T> = Term<T> | T;

export type TermOf<T> = Term<T> &
  (T extends Comparable | boolean | readonly unknown[]
    ? unknown
    : T extends object
      ? string extends keyof T
        ? { readonly [key: string]: any }
        : { readonly [K in keyof T]-?: TermOf<Exclude<T[K], undefined>> }
      : unknown);

export type InvariantRule<T> = { bivariant(self: TermOf<T>): Rule }["bivariant"];

export type Operator = "<" | "<=" | ">" | ">=" | "==" | "!=";

export interface CompareRule {
  readonly kind: "compare";
  readonly operator: Operator;
  readonly left: Operand<unknown>;
  readonly right: Operand<unknown>;
}

export interface AllRule {
  readonly kind: "all";
  readonly of: Term<readonly unknown[]>;
  readonly each: Rule;
}

export interface AnyRule {
  readonly kind: "any";
  readonly of: Term<readonly unknown[]>;
  readonly each: Rule;
}

export interface AndRule {
  readonly kind: "and";
  readonly rules: readonly Rule[];
}

export interface OrRule {
  readonly kind: "or";
  readonly rules: readonly Rule[];
}

export interface NotRule {
  readonly kind: "not";
  readonly rule: Rule;
}

export type Rule = CompareRule | AllRule | AnyRule | AndRule | OrRule | NotRule;

export type Distinction = CompareRule | AllRule | AnyRule;

export function conjuncts(rule: Rule): readonly Rule[] {
  return rule.kind === "and" ? rule.rules.flatMap(conjuncts) : [rule];
}

export function any<E>(
  of: Term<readonly E[]>,
  each: (element: TermOf<E>) => Rule,
): Rule {
  return { kind: "any", of: of as Term<readonly unknown[]>, each: each(selfTerm<E>()) };
}

export function and(...rules: readonly Rule[]): Rule {
  return { kind: "and", rules };
}

export function or(...rules: readonly Rule[]): Rule {
  return { kind: "or", rules };
}

export function not(rule: Rule): Rule {
  return { kind: "not", rule };
}

export function all<E>(
  of: Term<readonly E[]>,
  each: (element: TermOf<E>) => Rule,
): Rule {
  return { kind: "all", of: of as Term<readonly unknown[]>, each: each(selfTerm<E>()) };
}

export function lt<T extends Comparable>(left: Operand<T>, right: Operand<T>): Rule {
  return compare("<", left, right);
}

export function le<T extends Comparable>(left: Operand<T>, right: Operand<T>): Rule {
  return compare("<=", left, right);
}

export function gt<T extends Comparable>(left: Operand<T>, right: Operand<T>): Rule {
  return compare(">", left, right);
}

export function ge<T extends Comparable>(left: Operand<T>, right: Operand<T>): Rule {
  return compare(">=", left, right);
}

export function eq<T extends Comparable | boolean>(
  left: Operand<T>,
  right: Operand<T>,
): Rule {
  return compare("==", left, right);
}

export function ne<T extends Comparable | boolean>(
  left: Operand<T>,
  right: Operand<T>,
): Rule {
  return compare("!=", left, right);
}

export function length(
  of: Term<string | readonly unknown[] | Readonly<Record<string, unknown>>>,
): Term<number> {
  return termAt(of[TERM].path, "length");
}

export function rootTerm<T>(key: string): TermOf<T> {
  return termAt([key], "value") as TermOf<T>;
}

export function termPaths(rule: Rule): readonly (readonly string[])[] {
  switch (rule.kind) {
    case "compare":
      return [rule.left, rule.right].filter(isTerm).map(term => termData(term).path);
    case "all":
    case "any":
      return [termData(rule.of).path];
    case "and":
    case "or":
      return rule.rules.flatMap(termPaths);
    case "not":
      return termPaths(rule.rule);
  }
}

export function selfTerm<T>(): TermOf<T> {
  return termAt([], "value") as TermOf<T>;
}

export function isTerm(value: unknown): value is Term<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    TERM in value
  );
}

export function termData(term: Term<unknown>): TermData {
  return term[TERM];
}

export function boundTermPath(rule: Rule): readonly string[] | undefined {
  if (rule.kind !== "compare") {
    return undefined;
  }
  if (isTerm(rule.left) !== isTerm(rule.right)) {
    return termData((isTerm(rule.left) ? rule.left : rule.right) as Term<unknown>).path;
  }
  return undefined;
}

export function stepInto(rule: Rule, key: string): Rule | undefined {
  const path = boundTermPath(rule);
  if (rule.kind !== "compare" || path === undefined || path[0] !== key) {
    return undefined;
  }
  const shift = (operand: unknown): unknown => {
    if (!isTerm(operand)) {
      return operand;
    }
    const data = termData(operand);
    return termAt(data.path.slice(1), data.measure);
  };
  return { ...rule, left: shift(rule.left), right: shift(rule.right) };
}

export type ComparisonObserver = (rule: CompareRule, scope: unknown) => void;

export type DistinctionObserver = (distinction: Distinction, outcome: boolean) => void;

export function holds(
  rule: Rule,
  value: unknown,
  observe?: ComparisonObserver,
  decide?: DistinctionObserver,
): boolean {
  switch (rule.kind) {
    case "and":
      return rule.rules.every(part => holds(part, value, observe, decide));
    case "or":
      return rule.rules.some(part => holds(part, value, observe, decide));
    case "not":
      return !holds(rule.rule, value, observe, decide);
    case "all":
    case "any": {
      const elements = read(rule.of, value);
      const each = (element: unknown) => holds(rule.each, element, observe);
      const outcome = !Array.isArray(elements)
        ? rule.kind === "all"
        : rule.kind === "all"
          ? elements.every(each)
          : elements.some(each);
      decide?.(rule, outcome);
      return outcome;
    }
    case "compare": {
      const outcome = compares(rule, value, observe);
      decide?.(rule, outcome);
      return outcome;
    }
  }
}

function compares(rule: CompareRule, value: unknown, observe?: ComparisonObserver): boolean {
  observe?.(rule, value);
  const left = read(rule.left, value);
  const right = read(rule.right, value);
  if (left === undefined || right === undefined) {
    return true;
  }
  const order = ordering(left, right);
  switch (rule.operator) {
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "==":
      return order === 0;
    case "!=":
      return order !== 0;
  }
}

export function satisfy(rule: Rule, value: unknown): unknown {
  if (rule.kind !== "compare" || holds(rule, value)) {
    return value;
  }
  const [term, bound, operator] = isTerm(rule.left)
    ? [rule.left, rule.right, rule.operator]
    : [rule.right, rule.left, mirrored[rule.operator]];
  if (!isTerm(term) || isTerm(bound)) {
    return value;
  }
  const target =
    operator === ">" || operator === "!="
      ? step(bound, 1)
      : operator === "<"
        ? step(bound, -1)
        : bound;
  const { path, measure } = termData(term);
  return writeAt(value, path, current =>
    measure === "length" ? resize(current, target as number) : target,
  );
}

export function describeRule(rule: Rule, path = "$"): string {
  switch (rule.kind) {
    case "all":
    case "any":
      return `${rule.kind}(${describeOperand(rule.of, path)}, ${describeRule(rule.each, `${describeOperand(rule.of, path)}[]`)})`;
    case "and":
    case "or":
      return `${rule.kind}(${rule.rules.map(part => describeRule(part, path)).join(", ")})`;
    case "not":
      return `not(${describeRule(rule.rule, path)})`;
    case "compare":
      break;
  }
  return `${describeOperand(rule.left, path)} ${rule.operator} ${describeOperand(rule.right, path)}`;
}

const mirrored: Readonly<Record<Operator, Operator>> = {
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
  "==": "==",
  "!=": "!=",
};

function step(bound: unknown, direction: 1 | -1): unknown {
  if (typeof bound === "number") {
    return bound + direction;
  }
  const add = (bound as { readonly add?: (duration: object) => unknown } | null)?.add;
  if (typeof add === "function") {
    return add.call(bound, { nanoseconds: direction });
  }
  return bound;
}

function writeAt(
  value: unknown,
  path: readonly string[],
  change: (current: unknown) => unknown,
): unknown {
  const [key, ...rest] = path;
  if (key === undefined) {
    return change(value);
  }
  const record = value as Readonly<Record<string, unknown>>;
  return { ...record, [key]: writeAt(record[key], rest, change) };
}

export function sizeOf(value: unknown): number {
  return typeof value === "string" || Array.isArray(value)
    ? value.length
    : Object.keys(value as object).length;
}

export function resize(current: unknown, size: number): unknown {
  if (typeof current === "string") {
    return current.length >= size ? current.slice(0, size) : current.padEnd(size, "_");
  }
  if (Array.isArray(current)) {
    const filler = current[current.length - 1];
    return Array.from({ length: Math.max(size, 0) }, (_, index) => current[index] ?? filler);
  }
  if (typeof current === "object" && current !== null) {
    const entries = Object.entries(current);
    const filler = entries[entries.length - 1]?.[1];
    return Object.fromEntries(
      Array.from(
        { length: Math.max(size, 0) },
        (_, index) => entries[index] ?? [`<key${index + 1}>`, filler],
      ),
    );
  }
  return current;
}

function compare(operator: Operator, left: unknown, right: unknown): Rule {
  return { kind: "compare", operator, left, right };
}

function termAt(path: readonly string[], measure: TermData["measure"]): Term<unknown> {
  const data: TermData = { path, measure };
  return new Proxy({} as Term<unknown>, {
    get: (_target, key) => {
      if (key === TERM) {
        return data;
      }
      return typeof key === "string" ? termAt([...path, key], "value") : undefined;
    },
    has: (_target, key) => key === TERM,
  });
}

export function readOperand(operand: unknown, value: unknown): unknown {
  return read(operand, value);
}

function read(operand: unknown, value: unknown): unknown {
  if (!isTerm(operand)) {
    return operand;
  }
  const { path, measure } = termData(operand);
  const found = path.reduce<unknown>(
    (current, key) =>
      typeof current === "object" && current !== null
        ? (current as Readonly<Record<string, unknown>>)[key]
        : undefined,
    value,
  );
  if (found === undefined || measure === "value") {
    return found;
  }
  return sizeOf(found);
}

function ordering(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === right ? 0 : Number.NaN;
  }
  const compareInstants = (
    left as { readonly constructor?: { readonly compare?: (a: unknown, b: unknown) => number } }
  )?.constructor?.compare;
  if (typeof compareInstants === "function") {
    return compareInstants(left, right);
  }
  return Number.NaN;
}

export function describeTerm(term: Term<unknown>, path = "$"): string {
  return describeOperand(term, path);
}

function describeOperand(operand: unknown, path: string): string {
  if (!isTerm(operand)) {
    return typeof operand === "string" ? JSON.stringify(operand) : String(operand);
  }
  const { path: keys, measure } = termData(operand);
  const location = [path, ...keys].filter(part => part !== "").join(".");
  return measure === "length" ? `length(${location})` : location;
}
