import { Rational, fractionOf, INT64_MIN, INT64_MAX } from "./exact.js";
import { nodeOf } from "./model.js";
import type { Rule, Operator } from "./rule.js";
import { isDecimal, isTerm, termData, positionTerm, conjuncts, positionData, counts } from "./rule.js";
import type { AnySchema, DecimalSchema, ObjectSchema, ObjectShape } from "./schema.js";
import { schemaAtPath } from "./schema.js";
import type { Step } from "./ways.js";
import { deepEqual } from "./equal.js";
import { fixedLength, onTimeline, temporalKindOf, timelineOf, TIMELINE_RANGE } from "./temporal.js";

interface Interval {
  readonly low: Rational;
  readonly high: Rational;
  // A date, date-time or instant ranges over its nanoseconds since 1970-01-01 (temporal.ts).
  readonly kind: "number" | "bigint" | "rational" | "decimal" | "date" | "datetime" | "instant";
  readonly integral: boolean;
  readonly scale?: number | undefined;
}
const zero = new Rational(0n);
// A bound a rule compares with, as a number or as a place on the timeline.
function boundOf(value: unknown): Rational | undefined {
  const placed = timelineOf(value);
  if (placed) return placed;
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
    return schema.invariants.length === 0;
  }
  const range = interval(value, scope, steps);
  if (!range || !onTimeline(range.kind)) return false;
  const held = TIMELINE_RANGE[range.kind];
  if (range.low.comparedTo(held.low) < 0 || range.high.comparedTo(held.high) > 0) return false;
  return schema.invariants.every(rule => satisfied(rule, range));
}
function kindOf(value: unknown, scope: AnySchema): string | undefined {
  if (isTerm(value)) {
    const term = termData(value);
    return term.kind === "position" && term.measure === "value" ? schemaAtPath(scope, term.path)?.kind : undefined;
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
  if (schema.kind === "decimal" && (range.kind !== "decimal" || range.scale === undefined || range.scale > (schema as DecimalSchema).scale)) return false;
  if (!["integer", "number", "int64", "rational", "decimal"].includes(schema.kind)) return false;
  return schema.invariants.every(rule => satisfied(rule, range));
}
function satisfied(rule: Rule, range: Interval): boolean {
  if (rule.kind === "and") return rule.rules.every(part => satisfied(part, range));
  if (rule.kind === "or") return rule.rules.some(part => satisfied(part, range));
  if (rule.kind !== "compare" || !isTerm(rule.left)) return false;
  const position = positionData(rule.left);
  if (!position || position.path.length || position.measure !== "value" || isTerm(rule.right)) return false;
  const bound = boundOf(rule.right);
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
      for (const part of term.parts) {
        const found = interval(positionTerm(part.path, part.measure), scope, steps);
        if (!total || !found || onTimeline(found.kind) || total.kind !== found.kind && total.kind !== "number") return undefined;
        const coefficient = fractionOf(part.coefficient);
        const a = found.low.times(coefficient), b = found.high.times(coefficient);
        total = { kind: found.kind, scale: found.scale === undefined ? undefined : Math.max(total.scale ?? 0, found.scale), integral: total.integral && found.integral && Number.isInteger(part.coefficient), low: total.low.plus(min(a, b)), high: total.high.plus(max(a, b)) };
      }
      return exactNumber(total);
    }
    if (optionalAlong(scope, term.path)) return undefined;
    const schema = schemaAtPath(scope, term.path);
    if (!schema) return undefined;
    const timeline = term.measure === "value" && onTimeline(schema.kind) ? TIMELINE_RANGE[schema.kind] : undefined;
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
      const bound = boundOf(item.rule.right);
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
    if (!unit || !left || !right || !onTimeline(left.kind)) return undefined;
    if (node.operator === "between") {
      if (right.kind !== left.kind) return undefined;
      // Whole units from start to end, the part of a unit dropped toward zero.
      const whole = (span: Rational) => new Rational(span.numerator / (span.denominator * unit.numerator));
      return exactNumber({ kind: "number", integral: true, low: whole(right.low.minus(left.high)), high: whole(right.high.minus(left.low)) });
    }
    if (right.kind !== "number" || !right.integral) return undefined;
    const sign = new Rational(node.operator === "plus" ? 1n : -1n);
    const a = right.low.times(unit).times(sign), b = right.high.times(unit).times(sign);
    return { kind: left.kind, integral: true, low: left.low.plus(min(a, b)), high: left.high.plus(max(a, b)) };
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
  try {
    const bound = fractionOf(value as number);
    return { low: bound, high: bound, scale: isDecimal(value) ? value.decimalPlaces() : undefined, integral: bound.denominator === 1n, kind: typeof value === "number" ? "number" : typeof value === "bigint" ? "bigint" : isDecimal(value) ? "decimal" : "rational" };
  } catch { return undefined; }
}
function exactNumber(range: Interval | undefined): Interval | undefined {
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
