import { Rational, fractionOf, INT64_MIN, INT64_MAX } from "./exact.js";
import { nodeOf } from "./model.js";
import type { Rule, Operator } from "./rule.js";
import { isDecimal, isTerm, termData, positionTerm, conjuncts, positionData, counts } from "./rule.js";
import type { AnySchema, DecimalSchema, ObjectSchema, ObjectShape } from "./schema.js";
import { schemaAtPath } from "./schema.js";
import type { Step } from "./ways.js";
import { isDeepStrictEqual } from "node:util";

interface Interval {
  readonly low: Rational;
  readonly high: Rational;
  readonly kind: "number" | "bigint" | "rational" | "decimal";
  readonly integral: boolean;
  readonly scale?: number | undefined;
}
const zero = new Rational(0n);
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
  let bound: Rational;
  try { bound = fractionOf(rule.right as number); } catch { return false; }
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
        if (!total || !found || total.kind !== found.kind && total.kind !== "number") return undefined;
        const coefficient = fractionOf(part.coefficient);
        const a = found.low.times(coefficient), b = found.high.times(coefficient);
        total = { kind: found.kind, scale: found.scale === undefined ? undefined : Math.max(total.scale ?? 0, found.scale), integral: total.integral && found.integral && Number.isInteger(part.coefficient), low: total.low.plus(min(a, b)), high: total.high.plus(max(a, b)) };
      }
      return exactNumber(total);
    }
    if (optionalAlong(scope, term.path)) return undefined;
    const schema = schemaAtPath(scope, term.path);
    if (!schema) return undefined;
    const integral = counts(term.measure) || schema.kind === "integer" || schema.kind === "int64";
    let low: Rational | undefined = counts(term.measure) ? zero : schema.kind === "int64" ? new Rational(INT64_MIN) : schema.kind === "integer" ? fractionOf(Number.MIN_SAFE_INTEGER) : undefined;
    let high: Rational | undefined = counts(term.measure) ? fractionOf(Number.MAX_SAFE_INTEGER) : schema.kind === "int64" ? new Rational(INT64_MAX) : schema.kind === "integer" ? fractionOf(Number.MAX_SAFE_INTEGER) : undefined;
    const rules: { rule: Rule; prefix: readonly string[]; holds: boolean }[] = [];
    for (let size = 0; size <= term.path.length; size++) {
      const at = schemaAtPath(scope, term.path.slice(0, size));
      rules.push(...(at?.invariants.flatMap(conjuncts) ?? []).map(rule => ({ rule, prefix: term.path.slice(0, size), holds: true })));
    }
    rules.push(...steps.filter(step => step.distinction.kind !== "match").map(step => ({ rule: step.distinction as Rule, prefix: [], holds: step.outcome === true })));
    for (const item of rules) {
      if (item.rule.kind !== "compare" || !isTerm(item.rule.left) || isTerm(item.rule.right)) continue;
      const left = positionData(item.rule.left);
      if (!left || left.measure !== term.measure || !isDeepStrictEqual([...item.prefix, ...left.path], term.path)) continue;
      let bound: Rational;
      try { bound = fractionOf(item.rule.right as number); } catch { continue; }
      const operator = item.holds ? item.rule.operator : inverse[item.rule.operator];
      const next = integral && bound.denominator === 1n && (operator === "<" || operator === ">") ? bound.plus(new Rational(operator === "<" ? -1n : 1n)) : bound;
      if ([">", ">=", "=="].includes(operator)) low = low ? max(low, next) : next;
      if (["<", "<=", "=="].includes(operator)) high = high ? min(high, next) : next;
    }
    if (!low || !high || low.comparedTo(high) > 0) return undefined;
    return { low, high, integral, scale: schema.kind === "decimal" ? (schema as DecimalSchema).scale : undefined, kind: schema.kind === "int64" ? "bigint" : schema.kind === "rational" ? "rational" : schema.kind === "decimal" ? "decimal" : "number" };
  }
  const node = nodeOf(value);
  if (node?.kind === "construct") return interval(node.value, scope, steps);
  if (node?.kind === "operation") {
    if (node.operator === "concat") return undefined;
    const left = interval(node.left, scope, steps), right = interval(node.right, scope, steps);
    if (!left || !right || node.operator !== "quotient" && left.kind !== right.kind) return undefined;
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
