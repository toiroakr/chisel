import { Decimal } from "decimal.js";
import { Rational, fractionOf, isOutOfRoom, isRational, INT64_MIN, INT64_MAX, roundedAt } from "./exact.js";
import { nodeOf } from "./model.js";
import type { Rule, Operator } from "./rule.js";
import { isDecimal, isTerm, termData, positionTerm, conjuncts, positionData, counts } from "./rule.js";
import type { AnySchema, DecimalSchema, ObjectSchema, ObjectShape } from "./schema.js";
import { schemaAtPath } from "./schema.js";
import type { Step } from "./ways.js";
import { deepEqual } from "./equal.js";
import { compatibleBound } from "./bounds.js";
export { compatibleBound } from "./bounds.js";
import { DURATION_LIMIT, fixedLength, onTimeline, takesUnit, temporalKindOf, timelineOf, TIMELINE_RANGE } from "./temporal.js";

interface Interval {
  readonly low: Rational;
  readonly high: Rational;
  // A date, date-time or instant ranges over its nanoseconds since 1970-01-01 (temporal.ts).
  readonly kind: "number" | "bigint" | "rational" | "decimal" | "date" | "datetime" | "instant";
  readonly integral: boolean;
  readonly scale?: number | undefined;
}
const zero = new Rational(0n);
// A bound a rule compares with, as a number or as a place on the timeline. A
// date, date-time or instant is read only against a range of its own kind, and
// a number only against a number: Temporal compares a date with a date-time by
// the date alone, and an instant with nothing else.
function boundOf(value: unknown, kind: string): Rational | undefined {
  if (!compatibleBound(value, kind)) return undefined;
  const temporal = temporalKindOf(value);
  if (onTimeline(kind) || temporal) return temporal === kind ? timelineOf(value) : undefined;
  try { return fractionOf(value as number); } catch { return undefined; }
}

// Whether a date, time, date-time or instant meets its schema: a time of day
// moved by clock units always does, since it wraps at midnight; a date,
// date-time or instant does when its range on the timeline stays where Temporal
// holds it and within the schema's bounds.
export function provesTemporal(schema: AnySchema, value: unknown, scope: AnySchema, steps: readonly Step[]): boolean {
  if (!["date", "time", "datetime", "instant"].includes(schema.kind) || kindOf(value, scope) !== schema.kind) return false;
  if (schema.kind === "time") {
    // Any time of day meets a time schema without bounds; one with bounds is not read here.
    return schema.invariants.length === 0 && movesTime(value, scope, steps);
  }
  const range = interval(value, scope, steps);
  if (!range || !onTimeline(range.kind)) return false;
  const held = TIMELINE_RANGE[range.kind];
  if (range.low.comparedTo(held.low) < 0 || range.high.comparedTo(held.high) > 0) return false;
  return schema.invariants.every(rule => satisfied(rule, range));
}
// Whether a time of day is moved only by whole clock units Temporal takes as a
// duration, so the move wraps rather than throws.
function movesTime(value: unknown, scope: AnySchema, steps: readonly Step[]): boolean {
  const node = nodeOf(value);
  if (node?.kind !== "temporal") return true;
  if (node.operator === "between" || !takesUnit("time", node.unit) || !movesTime(node.left, scope, steps)) return false;
  const amount = interval(node.right, scope, steps), unit = fixedLength(node.unit)!;
  if (amount?.kind !== "number" || !amount.integral || !safeInteger(amount)) return false;
  return max(amount.high, amount.low.times(new Rational(-1n))).times(unit).comparedTo(DURATION_LIMIT) < 0;
}
// moveTemporal takes an amount only as a safe integer.
function safeInteger(range: Interval): boolean {
  return range.low.comparedTo(fractionOf(Number.MIN_SAFE_INTEGER)) >= 0 && range.high.comparedTo(fractionOf(Number.MAX_SAFE_INTEGER)) <= 0;
}
function kindOf(value: unknown, scope: AnySchema): string | undefined {
  if (isTerm(value)) {
    const term = termData(value);
    // A value an optional around it may leave out is no value of its type.
    return term.kind === "position" && term.measure === "value" && !optionalAlong(scope, term.path) ? schemaAtPath(scope, term.path)?.kind : undefined;
  }
  const node = nodeOf(value);
  if (node?.kind === "construct") return node.schema.kind;
  if (node?.kind === "temporal") return node.operator === "between" ? "integer" : kindOf(node.left, scope);
  return temporalKindOf(value);
}
const inverse: Record<Operator, Operator> = { "<": ">=", "<=": ">", ">": "<=", ">=": "<", "==": "!=", "!=": "==" };
export function provesNumeric(schema: AnySchema, value: unknown, scope: AnySchema, steps: readonly Step[]): boolean {
  const range = interval(value, scope, steps);
  if (!range) return false;
  if (schema.kind === "integer" && (range.kind !== "number" || !range.integral)) return false;
  if (schema.kind === "number" && range.kind !== "number") return false;
  if (schema.kind === "int64" && (range.kind !== "bigint" || range.low.comparedTo(new Rational(INT64_MIN)) < 0 || range.high.comparedTo(new Rational(INT64_MAX)) > 0)) return false;
  if (schema.kind === "rational" && range.kind !== "rational") return false;
  const declared = (schema as DecimalSchema).scale;
  if (schema.kind === "decimal" && (range.kind !== "decimal" || (declared !== undefined && (range.scale === undefined || range.scale > declared)))) return false;
  if (!["integer", "number", "int64", "rational", "decimal"].includes(schema.kind)) return false;
  return schema.invariants.every(rule => satisfied(rule, range));
}
function satisfied(rule: Rule, range: Interval): boolean {
  if (rule.kind === "and") return rule.rules.every(part => satisfied(part, range));
  if (rule.kind === "or") return rule.rules.some(part => satisfied(part, range));
  if (rule.kind !== "compare" || !isTerm(rule.left)) return false;
  const position = positionData(rule.left);
  if (!position || position.path.length || position.measure !== "value" || isTerm(rule.right)) return false;
  const bound = boundOf(rule.right, range.kind);
  if (!bound) return false;
  const low = range.low.comparedTo(bound), high = range.high.comparedTo(bound);
  switch (rule.operator) {
    case ">": return low > 0;
    case ">=": return low >= 0;
    case "<": return high < 0;
    case "<=": return high <= 0;
    case "==": return low === 0 && high === 0;
    case "!=": return low > 0 || high < 0;
  }
}
function interval(value: unknown, scope: AnySchema, steps: readonly Step[]): Interval | undefined {
  if (isTerm(value)) {
    const term = termData(value);
    if (term.kind === "linear") {
      let total = interval(term.constant, scope, steps);
      // A decimal part of no declared scale leaves the sum's scale unknown,
      // whatever the parts after it declare.
      for (const part of term.parts) {
        const found = interval(positionTerm(part.path, part.measure), scope, steps);
        if (!total || !found || onTimeline(found.kind) || total.kind !== found.kind && total.kind !== "number") return undefined;
        const coefficient = fractionOf(part.coefficient);
        const a = found.low.times(coefficient), b = found.high.times(coefficient);
        total = { kind: found.kind, scale: found.scale === undefined || (total.kind === "decimal" && total.scale === undefined) ? undefined : Math.max(total.scale ?? 0, found.scale), integral: total.integral && found.integral && Number.isInteger(part.coefficient), low: total.low.plus(min(a, b)), high: total.high.plus(max(a, b)) };
      }
      return exactNumber(total);
    }
    if (optionalAlong(scope, term.path)) return undefined;
    const schema = schemaAtPath(scope, term.path);
    if (!schema) return undefined;
    const timeline = term.measure === "value" && onTimeline(schema.kind) ? TIMELINE_RANGE[schema.kind] : undefined;
    const kind = counts(term.measure) || schema.kind === "integer" ? "number" : schema.kind === "int64" ? "bigint" : schema.kind;
    const integral = !!timeline || counts(term.measure) || schema.kind === "integer" || schema.kind === "int64";
    let low: Rational | undefined = timeline ? timeline.low : counts(term.measure) ? zero : schema.kind === "int64" ? new Rational(INT64_MIN) : schema.kind === "integer" ? fractionOf(Number.MIN_SAFE_INTEGER) : undefined;
    let high: Rational | undefined = timeline ? timeline.high : counts(term.measure) ? fractionOf(Number.MAX_SAFE_INTEGER) : schema.kind === "int64" ? new Rational(INT64_MAX) : schema.kind === "integer" ? fractionOf(Number.MAX_SAFE_INTEGER) : undefined;
    const rules: { rule: Rule; prefix: readonly string[]; holds: boolean }[] = [];
    for (let size = 0; size <= term.path.length; size++) {
      const at = schemaAtPath(scope, term.path.slice(0, size));
      rules.push(...(at?.invariants.flatMap(conjuncts) ?? []).map(rule => ({ rule, prefix: term.path.slice(0, size), holds: true })));
    }
    rules.push(...steps.filter(step => step.distinction.kind !== "match").map(step => ({ rule: step.distinction as Rule, prefix: [], holds: step.outcome === true })));
    for (const item of rules) {
      if (item.rule.kind !== "compare" || !isTerm(item.rule.left) || isTerm(item.rule.right)) continue;
      const left = positionData(item.rule.left);
      if (!left || left.measure !== term.measure || !deepEqual([...item.prefix, ...left.path], term.path)) continue;
      const bound = boundOf(item.rule.right, kind);
      if (!bound) continue;
      const operator = item.holds ? item.rule.operator : inverse[item.rule.operator];
      const next = integral && bound.denominator === 1n && (operator === "<" || operator === ">") ? bound.plus(new Rational(operator === "<" ? -1n : 1n)) : bound;
      if ([">", ">=", "=="].includes(operator)) low = low ? max(low, next) : next;
      if (["<", "<=", "=="].includes(operator)) high = high ? min(high, next) : next;
    }
    if (!low || !high || low.comparedTo(high) > 0) return undefined;
    if (timeline) return { low, high, integral, kind: schema.kind as "date" | "datetime" | "instant" };
    return { low, high, integral, scale: schema.kind === "decimal" ? (schema as DecimalSchema).scale : undefined, kind: schema.kind === "int64" ? "bigint" : schema.kind === "rational" ? "rational" : schema.kind === "decimal" ? "decimal" : "number" };
  }
  const node = nodeOf(value);
  if (node?.kind === "construct") return interval(node.value, scope, steps);
  if (node?.kind === "temporal") {
    // Only a unit of fixed length moves a value along the timeline by a fixed amount.
    const unit = fixedLength(node.unit);
    const left = interval(node.left, scope, steps), right = interval(node.right, scope, steps);
    if (!unit || !left || !right || !onTimeline(left.kind) || !takesUnit(left.kind, node.unit)) return undefined;
    if (node.operator === "between") {
      if (right.kind !== left.kind) return undefined;
      // Temporal rounds a count of weeks by placing the start up to a week past
      // the end, so the end must leave a week of room within the range held.
      const held = TIMELINE_RANGE[left.kind];
      if (node.unit === "weeks" && (right.low.comparedTo(held.low.plus(unit)) < 0 || right.high.comparedTo(held.high.minus(unit)) > 0)) return undefined;
      // Whole units from start to end, the part of a unit dropped toward zero.
      const whole = (span: Rational) => new Rational(span.numerator / (span.denominator * unit.numerator));
      return exactNumber({ kind: "number", integral: true, low: whole(right.low.minus(left.high)), high: whole(right.high.minus(left.low)) });
    }
    if (right.kind !== "number" || !right.integral || !safeInteger(right)) return undefined;
    const sign = new Rational(node.operator === "plus" ? 1n : -1n);
    const a = right.low.times(unit).times(sign), b = right.high.times(unit).times(sign);
    const low = left.low.plus(min(a, b)), high = left.high.plus(max(a, b));
    // Temporal refuses a move that leaves the range it holds the type in, even
    // one a later move brings back or a count only reads.
    const held = TIMELINE_RANGE[left.kind];
    if (low.comparedTo(held.low) < 0 || high.comparedTo(held.high) > 0) return undefined;
    return { kind: left.kind, integral: true, low, high };
  }
  if (node?.kind === "operation" && node.operator === "round") {
    // Rounding keeps order, so the range rounds at its ends.
    const inner = interval(node.left, scope, steps);
    if (!inner || onTimeline(inner.kind) || typeof node.right !== "number") return undefined;
    // A number is rounded only where it is a whole one: round refuses any other.
    if (inner.kind === "number" && !(inner.integral && safeInteger(inner))) return undefined;
    // A decimal with no scale holds any number of digits, among them more than exact arithmetic has room for, so a run may be out of room where its range says it completes.
    if (inner.kind === "decimal" && inner.scale === undefined) return undefined;
    const mode = node.mode ?? "half-even";
    try {
      return { kind: "decimal", integral: node.right === 0, scale: node.right, low: roundedAt(inner.low, node.right, mode), high: roundedAt(inner.high, node.right, mode) };
    } catch (error) {
      // A scale past the room exact arithmetic has completes to no range.
      if (isOutOfRoom(error)) return undefined;
      throw error;
    }
  }
  if (node?.kind === "operation") {
    if (node.operator === "concat") return undefined;
    const left = interval(node.left, scope, steps), right = interval(node.right, scope, steps);
    if (!left || !right || onTimeline(left.kind) || onTimeline(right.kind) || node.operator !== "quotient" && left.kind !== right.kind) return undefined;
    let low: Rational, high: Rational;
    if (node.operator === "add") { low = left.low.plus(right.low); high = left.high.plus(right.high); }
    else if (node.operator === "subtract") { low = left.low.minus(right.high); high = left.high.minus(right.low); }
    else {
      if (node.operator !== "multiply" && right.low.comparedTo(zero) <= 0 && right.high.comparedTo(zero) >= 0) return undefined;
      if (node.operator === "divide" && left.kind !== "rational") return undefined;
      const values = [left.low, left.high].flatMap(a => [right.low, right.high].map(b => node.operator === "multiply" ? a.times(b) : a.dividedBy(b)));
      low = values.reduce(min); high = values.reduce(max);
    }
    const scale = left.scale === undefined || right.scale === undefined ? undefined : node.operator === "multiply" ? left.scale + right.scale : Math.max(left.scale, right.scale);
    return exactNumber({ low, high, scale, kind: node.operator === "quotient" ? "rational" : left.kind, integral: node.operator !== "divide" && node.operator !== "quotient" && left.integral && right.integral });
  }
  const placed = timelineOf(value);
  if (placed) return { low: placed, high: placed, integral: true, kind: temporalKindOf(value) as "date" | "datetime" | "instant" };
  if (typeof value !== "number" && typeof value !== "bigint" && !isDecimal(value) && !isRational(value)) return undefined;
  try {
    const bound = fractionOf(value as number);
    return { low: bound, high: bound, scale: isDecimal(value) ? value.decimalPlaces() : undefined, integral: bound.denominator === 1n, kind: typeof value === "number" ? "number" : typeof value === "bigint" ? "bigint" : isDecimal(value) ? "decimal" : "rational" };
  } catch { return undefined; }
}
function exactNumber(range: Interval | undefined): Interval | undefined {
  // A signed 64-bit result past its ends is an operation that stops, however exactly the range is worked out.
  if (range?.kind === "bigint") return range.low.comparedTo(fractionOf(INT64_MIN)) >= 0 && range.high.comparedTo(fractionOf(INT64_MAX)) <= 0 ? range : undefined;
  if (range?.kind !== "number") return range;
  return range.integral && range.low.comparedTo(fractionOf(Number.MIN_SAFE_INTEGER)) >= 0 && range.high.comparedTo(fractionOf(Number.MAX_SAFE_INTEGER)) <= 0 ? range : undefined;
}
function min(a: Rational, b: Rational): Rational { return a.comparedTo(b) <= 0 ? a : b; }
function max(a: Rational, b: Rational): Rational { return a.comparedTo(b) >= 0 ? a : b; }
function optionalAlong(schema: AnySchema, path: readonly string[]): boolean {
  if (schema.kind === "optional") return true;
  if (!path.length) return false;
  if (schema.kind !== "object") return true;
  const child = (schema as ObjectSchema<ObjectShape>).shape[path[0]!];
  return !child || optionalAlong(child, path.slice(1));
}

// The values a sum, difference or product of numbers may take, read from the
// bounds of the positions it reads and what the steps settle of them, as exact
// rationals with no limit of size, for telling a comparison it never meets. A
// `number` is added and multiplied in floating point at run time: one that is
// not a whole number is not read, and a result past the safe integers is widened
// by the relative error one rounding may make.
export function rangeOf(value: unknown, scope: AnySchema, steps: readonly Step[]): { readonly low: Rational; readonly high: Rational } | undefined {
  const range = measuredRange(value, scope, steps);
  return range === undefined ? undefined : { low: range.low, high: range.high };
}
const rounding = new Rational(1n, 1n << 52n);
function widened(low: Rational, high: Rational): { readonly low: Rational; readonly high: Rational } {
  const room = (bound: Rational) => (bound.comparedTo(zero) < 0 ? bound.times(new Rational(-1n)) : bound).times(rounding);
  return {
    low: low.comparedTo(fractionOf(Number.MIN_SAFE_INTEGER)) < 0 ? low.minus(room(low)) : low,
    high: high.comparedTo(fractionOf(Number.MAX_SAFE_INTEGER)) > 0 ? high.plus(room(high)) : high,
  };
}
function measuredRange(value: unknown, scope: AnySchema, steps: readonly Step[]): { readonly low: Rational; readonly high: Rational; readonly floating: boolean } | undefined {
  const node = nodeOf(value);
  if (node?.kind === "construct") return measuredRange(node.value, scope, steps);
  if (node?.kind === "operation" && (node.operator === "add" || node.operator === "subtract" || node.operator === "multiply")) {
    const left = measuredRange(node.left, scope, steps), right = measuredRange(node.right, scope, steps);
    if (!left || !right) return undefined;
    let low: Rational, high: Rational;
    if (node.operator === "add") { low = left.low.plus(right.low); high = left.high.plus(right.high); }
    else if (node.operator === "subtract") { low = left.low.minus(right.high); high = left.high.minus(right.low); }
    else {
      const values = [left.low, left.high].flatMap(a => [right.low, right.high].map(b => a.times(b)));
      low = values.reduce(min); high = values.reduce(max);
    }
    const floating = left.floating || right.floating;
    return floating ? { ...widened(low, high), floating } : { low, high, floating };
  }
  const found = interval(value, scope, steps);
  if (found === undefined || onTimeline(found.kind)) return undefined;
  const floating = found.kind === "number";
  return floating && !found.integral ? undefined : { low: found.low, high: found.high, floating };
}

// Whether working out an operation completes wherever its operands do: an
// exact range of its answer exists, read from the bounds of what it reads, so
// no division by nought and no number past the exact range is in it. Undefined
// ranges say nothing either way.
export function completes(value: unknown, scope: AnySchema, steps: readonly Step[]): boolean {
  return interval(value, scope, steps) !== undefined;
}
