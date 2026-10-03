import { Rational, isRational, fractionOf, decimalOf } from "./exact.js";
import { compareText } from "./text.js";
import { isDeepStrictEqual } from "node:util";
import type { Decimal } from "decimal.js";
import type { Temporal as TemporalTypes } from "temporal-spec";
import type { Execution, Guard } from "./behavior.js";

type Moment =
  | TemporalTypes.Instant
  | TemporalTypes.PlainDate
  | TemporalTypes.PlainTime
  | TemporalTypes.PlainDateTime;

export type Comparable = number | bigint | Rational | string | Moment | Decimal;

// Symbol.for, not Symbol(): the CLI loads spec files through tsImport in a
// separate module graph, and a per-module symbol would not recognise their terms.
const TERM = Symbol.for("chisel.term");

export interface PositionTermData {
  readonly kind: "position";
  readonly path: readonly string[];
  readonly measure: "value" | "length";
}

export interface LinearPart {
  readonly path: readonly string[];
  readonly measure: "value" | "length";
  readonly coefficient: number;
}

// A sum of positions weighed by whole numbers, plus a constant.
export interface LinearTermData {
  readonly kind: "linear";
  readonly parts: readonly LinearPart[];
  readonly constant: number | Decimal;
}

export type TermData = PositionTermData | LinearTermData;

export type Term<T> = {
  readonly [TERM]: TermData;
  readonly __value?: { bivariant(value: T): void }["bivariant"];
};

export type Operand<T> = Term<T> | T;

export interface Condition {
  $and(other: Rule): Rule & Condition;
  $or(other: Rule): Rule & Condition;
  $not(): Rule & Condition;
  $else<Input, Result, Effect, Deps = unknown>(
    orElse: (input: Input, deps: Deps) => Execution<Result, Effect>,
  ): Guard<Input, Result, Effect, Deps>;
}

interface Ordered<T> {
  $lt(other: Operand<T>): Rule & Condition;
  $lte(other: Operand<T>): Rule & Condition;
  $gt(other: Operand<T>): Rule & Condition;
  $gte(other: Operand<T>): Rule & Condition;
  $eq(other: Operand<T>): Rule & Condition;
  $ne(other: Operand<T>): Rule & Condition;
}

interface Arithmetic<T> {
  $plus(other: Operand<T>): TermOf<T>;
  $minus(other: Operand<T>): TermOf<T>;
}

interface Equatable<T> {
  $eq(other: Operand<T>): Rule & Condition;
  $ne(other: Operand<T>): Rule & Condition;
}

interface Measured {
  $length(): TermOf<number>;
}

interface Quantified<E> {
  $all(each: (element: TermOf<E>) => Rule): Rule & Condition;
  $any(each: (element: TermOf<E>) => Rule): Rule & Condition;
}

// Operators carry the `$` prefix rather than fields, so a field reads as it does
// on the value `run` receives, and a field named `length` or `all` stays ordinary.
type TermOperator =
  | "$lt"
  | "$lte"
  | "$gt"
  | "$gte"
  | "$eq"
  | "$ne"
  | "$length"
  | "$all"
  | "$any"
  | "$plus"
  | "$minus";

type Fields<T> = {
  readonly [K in Exclude<keyof T & string, TermOperator>]-?: TermOf<Exclude<T[K], undefined>>;
};

export type TermOf<T> = Term<T> &
  (0 extends 1 & T
    ? { readonly [key: string]: any }
    : [T] extends [boolean]
    ? Equatable<T>
    : [T] extends [number | Decimal]
      ? Ordered<T> & Arithmetic<T>
      : [T] extends [bigint | Rational]
      ? Ordered<T>
      : [T] extends [Moment]
      ? Ordered<T>
      : [T] extends [string]
        ? Ordered<T> & Measured
        : [T] extends [readonly (infer E)[]]
          ? Measured & Quantified<E>
          : [T] extends [object]
            ? string extends keyof T
              ? unknown extends T[string & keyof T]
                ? { readonly [key: string]: any }
                : Measured & { readonly [key: string]: TermOf<Exclude<T[string & keyof T], undefined>> }
              : Fields<T>
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
  readonly element: string;
  readonly each: Rule;
}

export interface AnyRule {
  readonly kind: "any";
  readonly of: Term<readonly unknown[]>;
  readonly element: string;
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

// An invariant may carry the name refine() was given for it.
export type Rule = (CompareRule | AllRule | AnyRule | AndRule | OrRule | NotRule) & { readonly name?: string };

export type Distinction = CompareRule | AllRule | AnyRule;

// Each part of a named invariant keeps its name.
export function conjuncts(rule: Rule): readonly Rule[] {
  if (rule.kind !== "and") {
    return [rule];
  }
  const { name } = rule;
  return rule.rules.flatMap(part => conjuncts(name === undefined || part.name !== undefined ? part : { ...part, name }));
}

let quantifiedDepth = 0;

// The element is named by nesting depth, not by a fresh symbol: a term from an
// enclosing all/any must keep a path the analysis can resolve to that
// enclosing element, and a depth reads the same in every module graph.
function quantified(
  kind: "all" | "any",
  of: Term<unknown>,
  each: (element: TermOf<unknown>) => Rule,
): Rule & Condition {
  const element = `#each${quantifiedDepth}`;
  quantifiedDepth += 1;
  try {
    return condition({
      kind,
      of: of as Term<readonly unknown[]>,
      element,
      each: each(termAt([element], "value") as TermOf<unknown>),
    });
  } finally {
    quantifiedDepth -= 1;
  }
}

// The combinators are not enumerable, so a rule still compares, prints and
// serialises as the plain data the analysis reads.
function condition(rule: Rule): Rule & Condition {
  Object.defineProperties(rule, {
    $and: { value: (other: Rule) => condition({ kind: "and", rules: [rule, other] }) },
    $or: { value: (other: Rule) => condition({ kind: "or", rules: [rule, other] }) },
    $not: { value: () => condition({ kind: "not", rule }) },
    $else: { value: (orElse: Guard<unknown, unknown, unknown>["orElse"]) => ({ kind: "guard", condition: rule, orElse }) },
  });
  return rule as Rule & Condition;
}

// A key no object schema field is expected to take: deps terms live beside the
// input fields in the scope a guard is evaluated against, not in a separate one,
// so a comparison reached records the dependency values with the input.
export const DEPS = "#deps";
const INPUT = Symbol.for("chisel.input");

export function depsTerm<T>(): TermOf<T> {
  return termAt([DEPS], "value") as TermOf<T>;
}

export function bindElement(scope: unknown, name: string, element: unknown): unknown {
  return typeof scope === "object" && scope !== null && !Array.isArray(scope)
    ? { ...scope, [name]: element }
    : { [name]: element };
}

export function withDeps(input: unknown, deps: unknown): unknown {
  return deps === undefined || typeof input !== "object" || input === null
    ? input
    : { ...input, [DEPS]: deps, [INPUT]: input };
}

export function rootTerm<T>(key: string): TermOf<T> {
  return termAt([key], "value") as TermOf<T>;
}

export function termPaths(rule: Rule): readonly (readonly string[])[] {
  switch (rule.kind) {
    case "compare":
      return [rule.left, rule.right].filter(isTerm).flatMap(term => pathsOf(termData(term)));
    case "all":
    case "any":
      return [positionOf(rule.of).path];
    case "and":
    case "or":
      return rule.rules.flatMap(termPaths);
    case "not":
      return termPaths(rule.rule);
  }
}

export function rootsRead(rule: Rule): ReadonlySet<string | undefined> {
  const roots = new Set(termPaths(rule).map(path => path[0]));
  if (rule.kind === "all" || rule.kind === "any") {
    for (const root of rootsRead(rule.each)) {
      roots.add(root);
    }
  }
  if (rule.kind === "and" || rule.kind === "or") {
    rule.rules.forEach(part => rootsRead(part).forEach(root => roots.add(root)));
  }
  if (rule.kind === "not") {
    rootsRead(rule.rule).forEach(root => roots.add(root));
  }
  return roots;
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
    return positionData((isTerm(rule.left) ? rule.left : rule.right) as Term<unknown>)?.path;
  }
  return undefined;
}

export function shiftTerms(rule: CompareRule): CompareRule {
  const shift = (operand: unknown): unknown => (isTerm(operand) ? shiftedTerm(termData(operand)) : operand);
  return { ...rule, left: shift(rule.left), right: shift(rule.right) };
}

export function stepInto(rule: Rule, key: string): Rule | undefined {
  const path = boundTermPath(rule);
  if (rule.kind !== "compare" || path === undefined || path[0] !== key) {
    return undefined;
  }
  const shift = (operand: unknown): unknown => (isTerm(operand) ? shiftedTerm(termData(operand)) : operand);
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
      const each = (element: unknown) =>
        holds(rule.each, bindElement(value, rule.element, element), observe);
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

// `stepAt` names the step of the value a term reads, where it is not the default
// (the value next to 0.5 in a decimal of cents is 0.51, not 1.5), or the values it
// may take: an enum's that its own invariants keep.
export function satisfy(rule: Rule, value: unknown, stepAt?: StepAt): unknown {
  if (holds(rule, value)) {
    return value;
  }
  switch (rule.kind) {
    case "and":
      return rule.rules.reduce<unknown>((current, part) => satisfy(part, current, stepAt), value);
    case "or": {
      for (const part of rule.rules) {
        const moved = satisfy(part, value, stepAt);
        if (holds(rule, moved)) {
          return moved;
        }
      }
      return value;
    }
    case "compare":
      return satisfyComparison(rule, value, stepAt);
    default:
      return value;
  }
}

function satisfyComparison(rule: CompareRule, value: unknown, stepAt: StepAt | undefined): unknown {
  const [term, other, operator] =
    isTerm(rule.left) && positionData(rule.left) !== undefined
      ? [rule.left, rule.right, rule.operator]
      : isTerm(rule.right) && positionData(rule.right) !== undefined
        ? [rule.right, rule.left, mirrored[rule.operator]]
        : [rule.left, rule.right, rule.operator];
  if (!isTerm(term)) {
    return value;
  }
  const bound = read(other, value);
  if (bound === undefined) {
    return value;
  }
  const position = positionData(term);
  if (position === undefined) {
    return value;
  }
  const { path, measure } = position;
  const named = measure === "value" ? stepAt?.(path) : undefined;
  if (named !== undefined && typeof named !== "function") {
    // A value of a finite domain is chosen, not stepped to: the first one the rule
    // keeps, whichever way the rule orders them.
    const chosen = named.among.find(candidate => holds(rule, writeAt(value, path, () => candidate)));
    return chosen === undefined ? value : writeAt(value, path, () => chosen);
  }
  const move = named ?? step;
  const target =
    operator === ">" || operator === "!="
      ? move(bound, 1)
      : operator === "<"
        ? move(bound, -1)
        : bound;
  return writeAt(value, path, current =>
    measure === "length" ? resize(current, target as number) : target,
  );
}

export type ElementLabels = Readonly<Record<string, string>>;

export function describeRule(rule: Rule, path = "$", elements: ElementLabels = {}): string {
  switch (rule.kind) {
    case "all":
    case "any": {
      const of = describeOperand(rule.of, path, elements);
      return `${rule.kind}(${of}, ${describeRule(rule.each, path, { ...elements, [rule.element]: `${of}[]` })})`;
    }
    case "and":
    case "or":
      return `${rule.kind}(${rule.rules.map(part => describeRule(part, path, elements)).join(", ")})`;
    case "not":
      return `not(${describeRule(rule.rule, path, elements)})`;
    case "compare":
      break;
  }
  return `${describeOperand(rule.left, path, elements)} ${rule.operator} ${describeOperand(rule.right, path, elements)}`;
}

const mirrored: Readonly<Record<Operator, Operator>> = {
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
  "==": "==",
  "!=": "!=",
};

export type Step = (bound: unknown, direction: 1 | -1) => unknown;
// The step of the value a path reads, or the values it may take, where it is not
// the default.
export type StepAt = (path: readonly string[]) => Step | { readonly among: readonly unknown[] } | undefined;

// A Decimal from decimal.js, read by its methods rather than by instanceof, so a
// specification using another copy of the library is read the same.
export function isDecimal(value: unknown): value is Decimal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<Decimal>).comparedTo === "function" &&
    typeof (value as Partial<Decimal>).toFixed === "function" &&
    typeof (value as Partial<Decimal>).decimalPlaces === "function"
  );
}

// A decimal of `scale` digits after the point, as a whole number of units of its
// last digit: exact, and free of the precision a Decimal's arithmetic rounds to.
// A value off that grid is rounded down or up, as `rounding` says.
export function decimalUnits(value: Decimal, scale: number, rounding: "floor" | "ceil"): bigint {
  const mode = rounding === "floor" ? 3 : 2; // decimal.js ROUND_FLOOR and ROUND_CEIL
  const text = value.toFixed(scale, mode as Decimal.Rounding);
  return BigInt(text.replace(".", ""));
}

// The Decimal a whole number of units stands for, built with the constructor of
// `like`, so the value comes back as the kind the specification uses.
export function decimalOfUnits(like: Decimal, units: bigint, scale: number): Decimal {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  const Constructor = like.constructor as new (text: string) => Decimal;
  return new Constructor(negative ? `-${text}` : text);
}

// Steps a decimal to the next value of `scale` digits strictly past it, so a bound
// written off that grid, such as 0.004 in cents, steps to 0.01 above and 0 below.
export function decimalStep(scale: number): Step {
  return (bound, direction) => {
    const value = bound as Decimal;
    const units =
      direction > 0 ? decimalUnits(value, scale, "floor") + 1n : decimalUnits(value, scale, "ceil") - 1n;
    return decimalOfUnits(value, units, scale);
  };
}

function step(bound: unknown, direction: 1 | -1): unknown {
  if (typeof bound === "number") {
    return bound + direction;
  }
  const add = (bound as { readonly add?: (duration: object) => unknown } | null)?.add;
  if (typeof add === "function") {
    const moved = add.call(bound, isPlainDate(bound) ? { days: direction } : { nanoseconds: direction });
    // A plain time wraps past midnight, landing on the far side of the bound; no
    // time of day lies past either end, so the bound is kept rather than wrapped.
    return Math.sign(ordering(moved, bound)) === direction ? moved : bound;
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
  return typeof value === "string" ? [...value.normalize("NFC")].length : Array.isArray(value)
    ? value.length
    : Object.keys(value as object).length;
}

export function resize(current: unknown, size: number, empty?: () => unknown): unknown {
  if (typeof current === "string") {
    const points = [...current.normalize("NFC")];
    return points.length >= size ? points.slice(0, size).join("") : current.normalize("NFC") + "_".repeat(size - points.length);
  }
  if (Array.isArray(current)) {
    const filler = current.length > 0 ? current[current.length - 1] : empty?.();
    return Array.from({ length: Math.max(size, 0) }, (_, index) => current[index] ?? filler);
  }
  if (typeof current === "object" && current !== null) {
    const entries = Object.entries(current);
    const filler = entries.length > 0 ? entries[entries.length - 1]![1] : empty?.();
    return Object.fromEntries(
      Array.from(
        { length: Math.max(size, 0) },
        (_, index) => entries[index] ?? [`<key${index + 1}>`, filler],
      ),
    );
  }
  return current;
}

function compare(operator: Operator, left: unknown, right: unknown): Rule & Condition {
  return condition({ kind: "compare", operator, left, right });
}

const OPERATORS: Readonly<Record<string, Operator>> = {
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  eq: "==",
  ne: "!=",
};

function termAt(path: readonly string[], measure: PositionTermData["measure"]): Term<unknown> {
  const data: PositionTermData = { kind: "position", path, measure };
  const self: Term<unknown> = new Proxy({} as Term<unknown>, {
    get: (_target, key) => {
      if (key === TERM) {
        return data;
      }
      if (typeof key !== "string") {
        return undefined;
      }
      if (!key.startsWith("$")) {
        return termAt([...path, key], "value");
      }
      const name = key.slice(1);
      const operator = Object.hasOwn(OPERATORS, name) ? OPERATORS[name] : undefined;
      if (operator !== undefined) {
        return (other: unknown) => compare(operator, self, other);
      }
      switch (name) {
        case "plus":
          return (other: unknown) => linearTerm(combined(data, other, 1));
        case "minus":
          return (other: unknown) => linearTerm(combined(data, other, -1));
        case "length":
          return () => termAt(path, "length");
        case "all":
        case "any":
          return (each: (element: TermOf<unknown>) => Rule) => quantified(name, self, each);
        default:
          return termAt([...path, key], "value");
      }
    },
    has: (_target, key) => key === TERM,
  });
  return self;
}

export function positionTerm(path: readonly string[], measure: PositionTermData["measure"]): Term<unknown> {
  return termAt(path, measure);
}

// The expression a comparison draws its line on: its left side less its right.
export function differenceOf(rule: CompareRule): LinearTermData {
  const left = linearOf(rule.left);
  const right = linearOf(rule.right);
  return combined(left, linearTerm(right), -1);
}

export function positionData(term: Term<unknown>): PositionTermData | undefined {
  const data = termData(term);
  return data.kind === "position" ? data : undefined;
}

// Where only one position can stand, such as what a match selects or what $all
// ranges over, an expression is refused rather than read as some position.
export function positionOf(term: Term<unknown>): PositionTermData {
  const data = positionData(term);
  if (data === undefined) {
    throw new Error(`${describeTerm(term)} is an expression of positions, not one position`);
  }
  return data;
}

function pathsOf(data: TermData): readonly (readonly string[])[] {
  return data.kind === "position" ? [data.path] : data.parts.map(part => part.path);
}

function shiftedTerm(data: TermData): Term<unknown> {
  return data.kind === "position"
    ? termAt(data.path.slice(1), data.measure)
    : linearTerm({ ...data, parts: data.parts.map(part => ({ ...part, path: part.path.slice(1) })) });
}

function linearOf(operand: unknown): LinearTermData {
  if (!isTerm(operand)) {
    return { kind: "linear", parts: [], constant: operand as number | Decimal };
  }
  const data = termData(operand);
  return data.kind === "linear"
    ? data
    : { kind: "linear", parts: [{ path: data.path, measure: data.measure, coefficient: 1 }], constant: 0 };
}

function combined(data: TermData, other: unknown, sign: 1 | -1): LinearTermData {
  const base: LinearTermData =
    data.kind === "linear"
      ? data
      : { kind: "linear", parts: [{ path: data.path, measure: data.measure, coefficient: 1 }], constant: 0 };
  const right = linearOf(other);
  const parts = [...base.parts];
  for (const part of right.parts) {
    const index = parts.findIndex(
      existing => existing.measure === part.measure && isDeepStrictEqual(existing.path, part.path),
    );
    const coefficient = sign * part.coefficient;
    if (index === -1) {
      parts.push({ ...part, coefficient });
    } else {
      parts[index] = { ...parts[index]!, coefficient: parts[index]!.coefficient + coefficient };
    }
  }
  if (parts.some(part => !Number.isSafeInteger(part.coefficient))) throw new Error("Linear coefficient exceeds the exact integer range; use Rational expressions");
  return {
    kind: "linear",
    parts: parts.filter(part => part.coefficient !== 0),
    constant: sum(base.constant, scaled(right.constant, sign)) as number | Decimal,
  };
}

function linearTerm(data: LinearTermData): Term<unknown> {
  const self: Term<unknown> = new Proxy({} as Term<unknown>, {
    get: (_target, key) => {
      if (key === TERM) {
        return data;
      }
      if (typeof key !== "string" || !key.startsWith("$")) {
        return undefined;
      }
      const name = key.slice(1);
      const operator = Object.hasOwn(OPERATORS, name) ? OPERATORS[name] : undefined;
      if (operator !== undefined) {
        return (other: unknown) => compare(operator, self, other);
      }
      if (name === "plus") {
        return (other: unknown) => linearTerm(combined(data, other, 1));
      }
      if (name === "minus") {
        return (other: unknown) => linearTerm(combined(data, other, -1));
      }
      return undefined;
    },
    has: (_target, key) => key === TERM,
  });
  return self;
}

function readLinear(data: LinearTermData, value: unknown): unknown {
  let total = fractionOf(data.constant);
  let decimal = isDecimal(data.constant);
  for (const part of data.parts) {
    const found = read(termAt(part.path, part.measure), value);
    if (found === undefined) return undefined;
    decimal ||= isDecimal(found);
    total = total.plus(fractionOf(found as number | Decimal).times(fractionOf(part.coefficient)));
  }
  if (decimal) return decimalOf(total);
  if (total.denominator === 1n && (total.numerator < BigInt(Number.MIN_SAFE_INTEGER) || total.numerator > BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error("Exact integer arithmetic exceeds the safe range; use int64 or Rational expressions");
  }
  return decimalOf(total).toNumber();
}

function scaled(value: unknown, coefficient: number): unknown {
  return isDecimal(value) ? decimalOf(fractionOf(value).times(fractionOf(coefficient))) : (value as number) * coefficient;
}

function sum(left: unknown, right: unknown): unknown {
  if (isDecimal(left)) {
    return decimalOf(fractionOf(left).plus(fractionOf(right as Decimal | number)));
  }
  if (isDecimal(right)) {
    return decimalOf(fractionOf(right).plus(fractionOf(left as number)));
  }
  return (left as number) + (right as number);
}

function describeLinear(data: LinearTermData, describePart: (part: LinearPart) => string): string {
  const pieces = data.parts.map((part, index) => {
    const size = Math.abs(part.coefficient);
    const sign = part.coefficient < 0 ? "-" : "+";
    const body = size === 1 ? describePart(part) : `${size} * ${describePart(part)}`;
    return index === 0 ? (sign === "-" ? `-${body}` : body) : `${sign} ${body}`;
  });
  const constant = data.constant;
  const zero = isDecimal(constant) ? constant.isZero() : constant === 0;
  if (!zero) {
    const negative = isDecimal(constant) ? constant.isNegative() : (constant as number) < 0;
    const size = isDecimal(constant) ? constant.abs().toString() : String(Math.abs(constant as number));
    pieces.push(pieces.length === 0 ? String(constant) : `${negative ? "-" : "+"} ${size}`);
  }
  return pieces.length === 0 ? "0" : pieces.join(" ");
}

export function readOperand(operand: unknown, value: unknown): unknown {
  return read(operand, value);
}

function read(operand: unknown, value: unknown): unknown {
  if (!isTerm(operand)) {
    return operand;
  }
  const data = termData(operand);
  if (data.kind === "linear") {
    return readLinear(data, value);
  }
  const { path, measure } = data;
  if (path.length === 0 && typeof value === "object" && value !== null && INPUT in value) value = (value as { [INPUT]: unknown })[INPUT];
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
  if (typeof left === "bigint" && typeof right === "bigint") return left < right ? -1 : left > right ? 1 : 0;
  if (isRational(left) && isRational(right)) return left.comparedTo(right);
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return compareText(left, right);
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === right ? 0 : Number.NaN;
  }
  // A Decimal compares exactly, by its own comparedTo.
  if (isDecimal(left)) {
    return left.comparedTo(right as Decimal.Value);
  }
  if (isDecimal(right)) {
    return -right.comparedTo(left as Decimal.Value);
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

function describeOperand(operand: unknown, path: string, elements: ElementLabels = {}): string {
  if (!isTerm(operand)) {
    return typeof operand === "string" ? JSON.stringify(operand) : String(operand);
  }
  const data = termData(operand);
  if (data.kind === "linear") {
    return describeLinear(data, part => describeOperand(termAt(part.path, part.measure), path, elements));
  }
  const { path: keys, measure } = data;
  const [first = "", ...rest] = keys;
  const location = (
    first === DEPS
      ? ["deps", ...rest]
      : elements[first] !== undefined
        ? [elements[first], ...rest]
        : [path, ...keys]
  )
    .filter(part => part !== "")
    .join(".");
  return measure === "length" ? `length(${location})` : location;
}

// A plain date has no time of day, so adding a nanosecond leaves it where it is.
function isPlainDate(value: unknown): boolean {
  const constructor = (globalThis as { readonly Temporal?: { readonly PlainDate?: abstract new (...args: never[]) => unknown } })
    .Temporal?.PlainDate;
  return constructor !== undefined && value instanceof constructor;
}
