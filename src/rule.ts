import { Rational, isRational, fractionOf, decimalOf } from "./exact.js";
import { compareText } from "./text.js";
import { deepEqual } from "./equal.js";
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

// A change a term makes to the string it reads before reading it, as the
// String.prototype method of that name does.
export type Transform = "trim" | "lowercase" | "uppercase";

type Reading = "value" | "length";

// What a term reads at its path: the value itself or its length, after the
// transforms written before a colon, in order (`trim,lowercase:length`). One
// string, so two terms read the same coordinate exactly when their measures are
// equal, and a transformed value is never taken for the value itself.
export type Measure = Reading | `${string}:${Reading}`;

export function measureOf(transforms: readonly Transform[], reading: Reading): Measure {
  return transforms.length === 0 ? reading : `${transforms.join(",")}:${reading}`;
}

export function partsOfMeasure(measure: Measure): { readonly transforms: readonly Transform[]; readonly reading: Reading } {
  const colon = measure.lastIndexOf(":");
  return colon === -1
    ? { transforms: [], reading: measure as Reading }
    : { transforms: measure.slice(0, colon).split(",") as Transform[], reading: measure.slice(colon + 1) as Reading };
}

export interface PositionTermData {
  readonly kind: "position";
  readonly path: readonly string[];
  readonly measure: Measure;
}

export interface LinearPart {
  readonly path: readonly string[];
  readonly measure: Measure;
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

// A string read after a change, as the String.prototype method of that name
// makes it: the value itself is left as it is.
interface Transformable {
  $trim(): TermOf<string>;
  $lowercase(): TermOf<string>;
  $uppercase(): TermOf<string>;
}

interface Quantified<E> {
  $all(each: (element: TermOf<E>) => Rule): Rule & Condition;
  $any(each: (element: TermOf<E>) => Rule): Rule & Condition;
  // Whether some element is the value (Souther's List.contains): a value the
  // source writes or one a position holds.
  $includes(value: Operand<E>): Rule & Condition;
}

// How a string stands to another (Souther's String.startsWith and the rest),
// read over strings of any length (ADR-0130).
interface Related {
  $startsWith(other: Operand<string>): Rule & Condition;
  $endsWith(other: Operand<string>): Rule & Condition;
  $contains(other: Operand<string>): Rule & Condition;
}

// Whether a record holds an entry under the key (Souther's Map.containsKey).
interface Keyed {
  $hasKey(key: Operand<string>): Rule & Condition;
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
  | "$trim"
  | "$lowercase"
  | "$uppercase"
  | "$all"
  | "$any"
  | "$includes"
  | "$startsWith"
  | "$endsWith"
  | "$contains"
  | "$hasKey"
  | "$plus"
  | "$minus";

// A sum's term reaches the fields of every case: implement refuses a comparison
// reading one where the guards before it leave other cases possible.
type KeysOfCases<T> = T extends unknown ? keyof T : never;
type FieldOfCases<T, K extends PropertyKey> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;
type Fields<T> = {
  readonly [K in Exclude<KeysOfCases<T> & string, TermOperator>]-?: TermOf<Exclude<FieldOfCases<T, K>, undefined>>;
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
        ? Ordered<T> & Measured & Transformable & Related
        : [T] extends [readonly (infer E)[]]
          ? Measured & Quantified<E>
          : [T] extends [object]
            ? string extends keyof T
              ? unknown extends T[string & keyof T]
                ? { readonly [key: string]: any }
                : Measured & Keyed & { readonly [key: string]: TermOf<Exclude<T[string & keyof T], undefined>> }
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

// A relation of a string to another, of a record to a key, or of an array to
// an element: the other side is a value the source writes or one at a place
// (ADR-0129), and the subject is always a place.
export type Relation = "startsWith" | "endsWith" | "contains" | "hasKey" | "includes";

export interface RelationRule {
  readonly kind: "relation";
  readonly relation: Relation;
  readonly subject: Term<unknown>;
  readonly other: Operand<unknown>;
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
export type Rule = (CompareRule | AllRule | AnyRule | RelationRule | AndRule | OrRule | NotRule) & { readonly name?: string };

export type Distinction = CompareRule | AllRule | AnyRule | RelationRule;

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

export function withLocal(scope: unknown, name: string, value: unknown): unknown {
  const original = typeof scope === "object" && scope !== null && INPUT in scope ? (scope as { [INPUT]: unknown })[INPUT] : scope;
  return { ...(typeof scope === "object" && scope !== null ? scope : {}), [name]: value, [INPUT]: original };
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
    case "relation":
      return [rule.subject, rule.other].filter(isTerm).flatMap(term => pathsOf(termData(term)));
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

// Every path the rule reads, inside a quantifier's condition too, less those
// of the element it ranges over.
export function pathsRead(rule: Rule): readonly (readonly string[])[] {
  switch (rule.kind) {
    case "compare":
    case "relation":
      return termPaths(rule);
    case "all":
    case "any":
      return [positionOf(rule.of).path, ...pathsRead(rule.each).filter(path => path[0] !== rule.element)];
    case "and":
    case "or":
      return rule.rules.flatMap(pathsRead);
    case "not":
      return pathsRead(rule.rule);
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
  // A relation of a field to a written value is one of the field itself.
  if (rule.kind === "relation") {
    const subject = positionData(rule.subject);
    if (subject === undefined || isTerm(rule.other) || subject.path[0] !== key) return undefined;
    return { ...rule, subject: shiftedTerm(termData(rule.subject)) as Term<unknown> };
  }
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
    case "relation": {
      const outcome = relates(rule, value);
      decide?.(rule, outcome);
      return outcome;
    }
  }
}

// Read as a comparison is: where either side is absent it holds, since the
// analyses read rules over partial values and no declared rule reaches one.
export function relates(rule: RelationRule, value: unknown): boolean {
  const subject = read(rule.subject, value);
  const other = read(rule.other, value);
  if (subject === undefined || other === undefined) {
    return true;
  }
  return relationHolds(rule.relation, subject, other);
}

export function relationHolds(relation: Relation, subject: unknown, other: unknown): boolean {
  switch (relation) {
    case "startsWith":
      return typeof subject === "string" && typeof other === "string" && subject.startsWith(other);
    case "endsWith":
      return typeof subject === "string" && typeof other === "string" && subject.endsWith(other);
    case "contains":
      return typeof subject === "string" && typeof other === "string" && subject.includes(other);
    case "hasKey":
      return typeof subject === "object" && subject !== null && !Array.isArray(subject) && typeof other === "string" && Object.hasOwn(subject, other);
    case "includes":
      // Decimals are one value however written, as $eq reads them.
      return Array.isArray(subject) && subject.some(element => (isDecimal(element) && isDecimal(other) ? element.equals(other) : deepEqual(element, other)));
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
  const named = stepAt?.(path);
  if (named !== undefined && typeof named !== "function") {
    // A value of a finite domain is chosen, not stepped to: the first one the rule
    // keeps, whichever way the rule orders them, and however it reads the value
    // (`$lowercase()` would otherwise write "high" into an enum of "High").
    const chosen = named.among.find(candidate => holds(rule, writeAt(value, path, () => candidate)));
    return chosen === undefined ? value : writeAt(value, path, () => chosen);
  }
  const move = (measure === "value" ? named : undefined) ?? step;
  const target =
    operator === ">" || operator === "!="
      ? move(bound, 1)
      : operator === "<"
        ? move(bound, -1)
        : bound;
  const written = writeAt(value, path, current => rewrite(current, measure, target));
  if (operator === "==" && !holds(rule, written)) {
    // A rule that the string reads the same transformed, `uppercase($) == $`, is
    // kept by the transformed value itself, which no transform changes again.
    const { transforms, reading } = partsOfMeasure(measure);
    if (reading === "value" && transforms.length > 0) {
      const kept = writeAt(value, path, current => transformed(current, transforms));
      if (holds(rule, kept)) {
        return kept;
      }
    }
  }
  return written;
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
    case "relation":
      return `${rule.relation}(${describeOperand(rule.subject, path, elements)}, ${describeOperand(rule.other, path, elements)})`;
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

// Whether a measure counts (a length), rather than reading a value.
export function counts(measure: Measure): boolean {
  return partsOfMeasure(measure).reading === "length";
}

const TRANSFORMS: Readonly<Record<Transform, (text: string) => string>> = {
  trim: text => text.trim(),
  lowercase: text => text.toLowerCase(),
  uppercase: text => text.toUpperCase(),
};

export function transformed(value: unknown, transforms: readonly Transform[]): unknown {
  if (typeof value !== "string") {
    return value;
  }
  return transforms.reduce((text, transform) => TRANSFORMS[transform](text), value);
}

// Whether the transforms leave a string as it reads, compared as text is: "İ"
// lowercases to "i̇" and uppercases back to "I" with a combining dot, which
// reads as "İ" though it is not the same code points.
export function leftAsItReads(value: unknown, transforms: readonly Transform[]): value is string {
  return typeof value === "string" && compareText(transformed(value, transforms) as string, value) === 0;
}

// A location as `measure` reads it: `length(lowercase(trim($.x)))`.
export function measureLabel(location: string, measure: Measure): string {
  const { transforms, reading } = partsOfMeasure(measure);
  const read = transforms.reduce((inner, transform) => `${transform}(${inner})`, location);
  return reading === "length" ? `length(${read})` : read;
}

// What `measure` reads of a value found at a term's path.
export function measured(value: unknown, measure: Measure): unknown {
  const { transforms, reading } = partsOfMeasure(measure);
  const read = transformed(value, transforms);
  return reading === "length" ? sizeOf(read) : read;
}

// A value whose `measure` reads `target`, written on the current value. Each
// transform gives back a string it then leaves as it is, so a target the
// transforms leave alone is written as it is, and one they change is not
// written at all, since no value reads back as it. A length is written by
// resizing the transformed value, or by a string of `_` where resizing leaves
// whitespace at an end that `trim` would take off.
export function rewrite(current: unknown, measure: Measure, target: unknown, empty?: () => unknown): unknown {
  const { transforms, reading } = partsOfMeasure(measure);
  if (reading === "value") {
    return transforms.length === 0 || leftAsItReads(target, transforms) ? target : current;
  }
  if (transforms.length === 0 || typeof current !== "string") {
    return resize(current, target as number, empty);
  }
  const resized = resize(transformed(current, transforms), target as number);
  return measured(resized, measure) === target ? resized : resize("", target as number);
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

function termAt(path: readonly string[], measure: Measure): Term<unknown> {
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
          return () => termAt(path, measureOf(partsOfMeasure(measure).transforms, "length"));
        case "trim":
        case "lowercase":
        case "uppercase":
          return () => termAt(path, measureOf([...partsOfMeasure(measure).transforms, name], "value"));
        case "all":
        case "any":
          return (each: (element: TermOf<unknown>) => Rule) => quantified(name, self, each);
        case "includes":
        case "startsWith":
        case "endsWith":
        case "contains":
        case "hasKey":
          return (other: unknown) => condition({ kind: "relation", relation: name, subject: self, other });
        default:
          return termAt([...path, key], "value");
      }
    },
    has: (_target, key) => key === TERM,
  });
  return self;
}

export function positionTerm(path: readonly string[], measure: Measure): Term<unknown> {
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
      existing => existing.measure === part.measure && deepEqual(existing.path, part.path),
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
  return found === undefined ? found : measured(found, measure);
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

// A local bound to a dependency's answer reads as the call, any other by its number.
export function localLabel(name: string): string {
  const rest = name.slice("#local:".length);
  if (rest.startsWith("call:")) return `${rest.slice("call:".length, rest.lastIndexOf(":"))}()`;
  const at = rest.indexOf("@");
  return at === -1 ? `local${rest}` : rest.slice(at + 1);
}

export function describeTerm(term: Term<unknown>, path = "$", elements: ElementLabels = {}): string {
  return describeOperand(term, path, elements);
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
      : first.startsWith("#local:")
        ? [localLabel(first), ...rest]
        : elements[first] !== undefined
        ? [elements[first], ...rest]
        : [path, ...keys]
  )
    .filter(part => part !== "")
    .join(".");
  const { transforms, reading } = partsOfMeasure(measure);
  const read = transforms.reduce((inner, transform) => `${transform}(${inner})`, location);
  return reading === "length" ? `length(${read})` : read;
}

// A plain date has no time of day, so adding a nanosecond leaves it where it is.
function isPlainDate(value: unknown): boolean {
  const constructor = (globalThis as { readonly Temporal?: { readonly PlainDate?: abstract new (...args: never[]) => unknown } })
    .Temporal?.PlainDate;
  return constructor !== undefined && value instanceof constructor;
}

export function rebaseTerm(term: Term<unknown>, move: (path: readonly string[]) => readonly string[]): Term<unknown> {
  const data = termData(term);
  return data.kind === "position"
    ? termAt(move(data.path), data.measure)
    : linearTerm({ ...data, parts: data.parts.map(part => ({ ...part, path: move(part.path) })) });
}

// The rule with every term moved by `move`, which takes a path and answers the
// path to read instead; constants, operators, names and element roots are kept.
export function rebaseRule(rule: Rule, move: (path: readonly string[]) => readonly string[]): Rule {
  const term = (value: unknown): unknown => (isTerm(value) ? rebaseTerm(value, move) : value);
  const named = <R extends Rule>(rebased: R): R => (rule.name === undefined ? rebased : { ...rebased, name: rule.name });
  switch (rule.kind) {
    case "compare":
      return named({ kind: "compare", operator: rule.operator, left: term(rule.left), right: term(rule.right) });
    case "relation":
      return named({ kind: "relation", relation: rule.relation, subject: term(rule.subject) as Term<unknown>, other: term(rule.other) });
    case "all":
    case "any":
      return named({ ...rule, of: term(rule.of) as Term<readonly unknown[]>, each: rebaseRule(rule.each, path => (path[0] === rule.element ? path : move(path))) });
    case "and":
    case "or":
      return named({ kind: rule.kind, rules: rule.rules.map(part => rebaseRule(part, move)) });
    case "not":
      return named({ kind: "not", rule: rebaseRule(rule.rule, move) });
  }
}

// A sum of operands weighed by whole numbers: a term where any operand is one,
// otherwise the constant it adds up to. Undefined where a term is not a value
// of a position or an expression of them.
function foldsExactly(items: readonly { readonly operand: unknown; readonly coefficient: number }[], folded: number): boolean {
  try {
    const exact = items.reduce((total, { operand, coefficient }) => total.plus(fractionOf(linearOf(operand).constant as number | Decimal).times(fractionOf(coefficient))), fractionOf(0));
    return fractionOf(folded).comparedTo(exact) === 0;
  } catch {
    return false;
  }
}

export function linearCombination(items: readonly { readonly operand: unknown; readonly coefficient: number }[]): unknown {
  let parts: LinearPart[] = [];
  let constant: unknown = 0;
  for (const { operand, coefficient } of items) {
    const data = linearOf(operand);
    for (const part of data.parts) {
      const index = parts.findIndex(existing => existing.measure === part.measure && deepEqual(existing.path, part.path));
      const weight = part.coefficient * coefficient;
      const total = index === -1 ? weight : parts[index]!.coefficient + weight;
      // A weight or a running total that rounds could cancel to a value the exact sum does not have.
      if (!Number.isSafeInteger(weight) || !Number.isSafeInteger(total)) return undefined;
      if (index === -1) parts.push({ ...part, coefficient: total });
      else parts[index] = { ...parts[index]!, coefficient: total };
    }
    constant = sum(constant, scaled(data.constant, coefficient));
  }
  parts = parts.filter(part => part.coefficient !== 0);
  // A constant is read exactly, as a term reads it: a fold that rounds is not read.
  if (typeof constant === "number" && (!Number.isFinite(constant) || (Number.isInteger(constant) && !Number.isSafeInteger(constant)) || !foldsExactly(items, constant))) return undefined;
  // What decimals add to stays a decimal where their parts cancel.
  if (typeof constant === "number" && items.some(({ operand }) => isDecimal(operand) || (isTerm(operand) && isDecimal(linearOf(operand).constant)))) constant = decimalOf(fractionOf(constant));
  if (parts.length === 0) return constant;
  if (parts.length === 1 && parts[0]!.coefficient === 1 && constant === 0) return termAt(parts[0]!.path, parts[0]!.measure);
  return linearTerm({ kind: "linear", parts, constant: constant as number | Decimal });
}

// The rule with each operand `replace` answers for put in its place: a path it
// answers is read as the term or constant it gives, measured as the operand
// read it. Undefined where a replacement cannot stand in: a length or a
// transform of an expression, or an expression inside a quantifier's range.
// A replacement may be a value divided by a whole number (`over`), as a
// quotient by a constant is: it stands in only where a comparison can be
// multiplied out, never as a value of its own.
export interface Replacement {
  readonly with: unknown;
  readonly over?: number;
}

export function substitutedOperand(value: unknown, replace: (path: readonly string[]) => Replacement | undefined): Replacement | undefined {
  {
    if (!isTerm(value)) return { with: value };
    const data = termData(value);
    if (data.kind === "position") {
      const found = replace(data.path);
      if (found === undefined) return { with: value };
      if (data.measure === "value") return found;
      if (found.over !== undefined) return undefined;
      if (isTerm(found.with)) {
        const inner = termData(found.with);
        return inner.kind === "position" && inner.measure === "value" ? { with: termAt(inner.path, data.measure) } : undefined;
      }
      return { with: measured(found.with, data.measure) };
    }
    const items: { operand: unknown; coefficient: number }[] = [{ operand: data.constant, coefficient: 1 }];
    for (const part of data.parts) {
      const found = part.measure === "value" ? replace(part.path) : undefined;
      if (found === undefined && part.measure !== "value" && replace(part.path) !== undefined) return undefined;
      if (found?.over !== undefined) return undefined;
      items.push({ operand: found === undefined ? termAt(part.path, part.measure) : found.with, coefficient: part.coefficient });
    }
    const combined = linearCombination(items);
    return combined === undefined ? undefined : { with: combined };
  }
}

export function substitutedRule(rule: Rule, replace: (path: readonly string[]) => Replacement | undefined): Rule | undefined {
  const operand = (value: unknown) => substitutedOperand(value, replace);
  const named = <R extends Rule>(made: R): R => (rule.name === undefined ? made : { ...made, name: rule.name });
  switch (rule.kind) {
    case "compare": {
      const left = operand(rule.left), right = operand(rule.right);
      if (left === undefined || right === undefined) return undefined;
      if (left.over === undefined && right.over === undefined) return named({ kind: "compare", operator: rule.operator, left: left.with, right: right.with });
      if (left.over !== undefined && right.over !== undefined) return undefined;
      // x / k op y is x op y * k, the order turned where k is negative. A
      // quotient is a rational, which compares as written only with a rational.
      const divisor = (left.over ?? right.over)!;
      if (!isRational(left.over === undefined ? left.with : right.with)) return undefined;
      const multiplied = scaledBy(left.over === undefined ? left.with : right.with, divisor);
      if (multiplied === undefined) return undefined;
      const operator = divisor < 0 ? mirrored[rule.operator] : rule.operator;
      return left.over !== undefined
        ? named({ kind: "compare", operator, left: left.with, right: multiplied })
        : named({ kind: "compare", operator, left: multiplied, right: right.with });
    }
    case "relation": {
      const subject = operand(rule.subject), other = operand(rule.other);
      if (subject === undefined || other === undefined || subject.over !== undefined || other.over !== undefined || !isTerm(subject.with)) return undefined;
      return named({ kind: "relation", relation: rule.relation, subject: subject.with as Term<unknown>, other: other.with });
    }
    case "all":
    case "any": {
      const of = operand(rule.of);
      const each = substitutedRule(rule.each, replace);
      return of === undefined || !isTerm(of.with) || each === undefined ? undefined : named({ ...rule, of: of.with as Term<readonly unknown[]>, each });
    }
    case "and":
    case "or": {
      const rules = rule.rules.map(part => substitutedRule(part, replace));
      return rules.some(part => part === undefined) ? undefined : named({ kind: rule.kind, rules: rules as Rule[] });
    }
    case "not": {
      const inner = substitutedRule(rule.rule, replace);
      return inner === undefined ? undefined : named({ kind: "not", rule: inner });
    }
  }
}

// A value multiplied by a whole number, a term or a number, decimal or rational
// constant; undefined where a rational does not come out whole.
function scaledBy(value: unknown, factor: number): unknown {
  if (isRational(value)) {
    const product = value.times(new Rational(BigInt(factor)));
    return product.denominator === 1n && product.numerator <= BigInt(Number.MAX_SAFE_INTEGER) && product.numerator >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(product.numerator) : undefined;
  }
  return linearCombination([{ operand: value, coefficient: factor }]);
}

export function normalize(
  rule: Rule,
): { operator: Operator; bound: unknown; measure: Measure } | undefined {
  if (rule.kind !== "compare") {
    return undefined;
  }
  const left = isTerm(rule.left) ? positionData(rule.left as Term<unknown>) : undefined;
  const right = isTerm(rule.right) ? positionData(rule.right as Term<unknown>) : undefined;
  if (left !== undefined && !isTerm(rule.right)) {
    return { operator: rule.operator, bound: rule.right, measure: left.measure };
  }
  if (right !== undefined && !isTerm(rule.left)) {
    return { operator: mirrored[rule.operator], bound: rule.left, measure: right.measure };
  }
  return undefined;
}
