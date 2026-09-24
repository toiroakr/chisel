import type { AnyImplementation, ComparisonReached } from "./behavior.js";
import type { Border } from "./border.js";
import type { Carrier } from "./border.js";
import { bordersOf, integerCarrier, normalize, numberCarrier } from "./border.js";
import type { Position } from "./partition.js";
import { carrierOf, positionsOf } from "./partition.js";
import type { CompareRule, Rule, Term } from "./rule.js";
import {
  boundTermPath,
  describeRule,
  isTerm,
  readOperand,
  selfTerm,
  sizeOf,
  termData,
} from "./rule.js";
import type {
  AnySchema,
  ArraySchema,
  ObjectSchema,
  ObjectShape,
  OptionalSchema,
} from "./schema.js";

export interface GuardBorder {
  readonly path: string;
  readonly comparison: CompareRule;
  readonly border: Border;
  coordinateOf(reached: ComparisonReached): unknown;
  compose(given: unknown, coordinate: unknown): unknown;
}

export function guardBordersOf(implementation: AnyImplementation): readonly GuardBorder[] {
  const input = implementation.behavior.input;
  const positions = positionsOf(input);
  const at = (path: string): Position | undefined =>
    positions.find(position => position.path === path);
  return Object.entries(implementation.cases).flatMap(([tag, decision]) =>
    decision.kind !== "rules"
      ? []
      : decision.guards.flatMap(candidate =>
          walk(candidate.condition, input.variants[tag] as AnySchema, `@${tag}`, "$", at),
        ),
  );
}

type PositionAt = (path: string) => Position | undefined;

export interface GuardClass {
  readonly name: string;
  readonly witness: unknown;
  contains(value: unknown): boolean;
}

export interface GuardPartition {
  readonly path: string;
  readonly classes: readonly GuardClass[];
}

interface Threshold {
  readonly path: string;
  readonly schema: AnySchema;
  readonly rule: CompareRule;
}

export function guardPartitionsOf(implementation: AnyImplementation): readonly GuardPartition[] {
  const input = implementation.behavior.input;
  const thresholds = Object.entries(implementation.cases).flatMap(([tag, decision]) =>
    decision.kind !== "rules"
      ? []
      : decision.guards.flatMap(candidate =>
          thresholdsIn(candidate.condition, input.variants[tag] as AnySchema, `@${tag}`),
        ),
  );
  const paths = [...new Set(thresholds.map(threshold => threshold.path))];
  return paths.flatMap(path => {
    const atPath = thresholds.filter(threshold => threshold.path === path);
    const partition = partitionAt(path, atPath[0]!.schema, atPath.map(threshold => threshold.rule));
    return partition === undefined ? [] : [partition];
  });
}

function thresholdsIn(rule: Rule, scope: AnySchema, path: string): Threshold[] {
  if (rule.kind === "all") {
    const of = termData(rule.of).path;
    const collection = schemaAt(scope, of);
    return collection?.kind === "array"
      ? thresholdsIn(
          rule.each,
          (collection as ArraySchema<unknown>).element,
          `${path}${of.map(key => `.${key}`).join("")}[]`,
        )
      : [];
  }
  const normalized = normalize(rule);
  if (normalized === undefined || normalized.measure !== "value") {
    return [];
  }
  const term = (isTerm(rule.left) ? rule.left : rule.right) as Term<unknown>;
  const keys = termData(term).path;
  const schema = schemaAt(scope, keys);
  return schema === undefined
    ? []
    : [{ path: `${path}${keys.map(key => `.${key}`).join("")}`, schema, rule }];
}

interface Edge {
  readonly value: unknown;
  readonly inclusive: boolean;
}

function partitionAt(
  path: string,
  schema: AnySchema,
  rules: readonly CompareRule[],
): GuardPartition | undefined {
  const carrier = carrierOf(schema, "value");
  if (carrier === undefined) {
    return undefined;
  }
  const cuts = rules.flatMap(rule => {
    const { operator, bound } = normalize(rule)!;
    return operator === "==" || operator === "!="
      ? []
      : [{ value: bound, lowerHoldsIt: operator === "<=" || operator === ">" }];
  });
  const unique = cuts
    .filter(
      (cut, index) =>
        cuts.findIndex(
          other =>
            carrier.compare(other.value, cut.value) === 0 &&
            other.lowerHoldsIt === cut.lowerHoldsIt,
        ) === index,
    )
    .sort((left, right) => carrier.compare(left.value, right.value));
  const { lower, upper } = admittedRange(schema, carrier);
  const edges: (Edge | undefined)[] = [
    lower,
    ...unique.flatMap(cut => [
      { value: cut.value, inclusive: cut.lowerHoldsIt },
      { value: cut.value, inclusive: !cut.lowerHoldsIt },
    ]),
    upper,
  ];
  const classes: GuardClass[] = [];
  for (let index = 0; index < edges.length; index += 2) {
    const from = edges[index];
    const to = edges[index + 1];
    const contains = (value: unknown) =>
      (from === undefined ||
        carrier.compare(value, from.value) > 0 ||
        (from.inclusive && carrier.compare(value, from.value) === 0)) &&
      (to === undefined ||
        carrier.compare(value, to.value) < 0 ||
        (to.inclusive && carrier.compare(value, to.value) === 0));
    const witness =
      from === undefined
        ? to === undefined
          ? undefined
          : to.inclusive
            ? to.value
            : (carrier.step?.(to.value, -1) ?? carrier.past?.(to.value, -1))
        : from.inclusive
          ? from.value
          : (carrier.step?.(from.value, 1) ?? carrier.past?.(from.value, 1));
    if (witness === undefined || !contains(witness)) {
      continue;
    }
    const name = [
      from === undefined ? "" : `${carrier.format(from.value)} ${from.inclusive ? "<=" : "<"} `,
      "v",
      to === undefined ? "" : ` ${to.inclusive ? "<=" : "<"} ${carrier.format(to.value)}`,
    ].join("");
    classes.push({ name, witness, contains });
  }
  return { path, classes };
}

function admittedRange(
  schema: AnySchema,
  carrier: Carrier,
): { readonly lower: Edge | undefined; readonly upper: Edge | undefined } {
  let lower: Edge | undefined;
  let upper: Edge | undefined;
  for (const rule of schema.invariants) {
    if (rule.kind !== "compare" || boundTermPath(rule)?.length !== 0) {
      continue;
    }
    const normalized = normalize(rule);
    if (normalized === undefined || normalized.measure !== "value") {
      continue;
    }
    const { operator, bound } = normalized;
    if (operator === ">=" || operator === ">") {
      const edge = { value: bound, inclusive: operator === ">=" };
      if (lower === undefined || carrier.compare(bound, lower.value) > 0) {
        lower = edge;
      }
    }
    if (operator === "<=" || operator === "<") {
      const edge = { value: bound, inclusive: operator === "<=" };
      if (upper === undefined || carrier.compare(bound, upper.value) < 0) {
        upper = edge;
      }
    }
  }
  return { lower, upper };
}

function walk(
  rule: Rule,
  scope: AnySchema,
  path: string,
  label: string,
  at: PositionAt,
): GuardBorder[] {
  if (rule.kind === "all") {
    const of = termData(rule.of).path;
    const collection = schemaAt(scope, of);
    const element =
      collection?.kind === "array" ? (collection as ArraySchema<unknown>).element : undefined;
    const suffix = of.map(key => `.${key}`).join("");
    return element === undefined
      ? []
      : walk(rule.each, element, `${path}${suffix}[]`, `${label}${suffix}[]`, at);
  }
  if (isTerm(rule.left) && isTerm(rule.right)) {
    return between(rule, rule.left, rule.right, scope, path, label, at);
  }
  const term = isTerm(rule.left) ? rule.left : isTerm(rule.right) ? rule.right : undefined;
  if (term === undefined) {
    return [];
  }
  const { path: keys, measure } = termData(term);
  const schema = schemaAt(scope, keys);
  if (schema === undefined) {
    return [];
  }
  const borders = bordersOf([rule], found => carrierOf(schema, found), {
    source: "guard",
    describe: compared => describeRule(compared, label),
    admits: coordinate => measure !== "value" || schema.parse(coordinate).success,
  });
  const positionPath = `${path}${keys.map(key => `.${key}`).join("")}`;
  return borders.map(border => ({
    path: positionPath,
    comparison: rule,
    border,
    coordinateOf: reached => {
      const value = readOperand(term, reached.scope);
      return measure === "length" && value !== undefined ? sizeOf(value) : value;
    },
    compose: (given, coordinate) => at(positionPath)?.write(given, measure, coordinate),
  }));
}

function between(
  rule: CompareRule,
  left: Term<unknown>,
  right: Term<unknown>,
  scope: AnySchema,
  path: string,
  label: string,
  at: PositionAt,
): GuardBorder[] {
  const sides = [left, right].map(term => {
    const { path: keys, measure } = termData(term);
    const schema = schemaAt(scope, keys);
    return {
      term,
      measure,
      path: `${path}${keys.map(key => `.${key}`).join("")}`,
      kind: measure === "length" ? "integer" : schema?.kind,
    };
  });
  const [first, second] = sides as [(typeof sides)[number], (typeof sides)[number]];
  const carrier =
    first.kind === "integer" && second.kind === "integer"
      ? integerCarrier
      : (first.kind === "integer" || first.kind === "number") &&
          (second.kind === "integer" || second.kind === "number")
        ? numberCarrier
        : undefined;
  if (carrier === undefined) {
    return [];
  }
  const difference: CompareRule = {
    kind: "compare",
    operator: rule.operator,
    left: selfTerm<number>(),
    right: 0,
  };
  const borders = bordersOf([difference], () => carrier, {
    source: "guard",
    describe: () => describeRule(rule, label),
    admits: () => true,
  });
  const read = (side: (typeof sides)[number], scopeValue: unknown): number | undefined => {
    const value = readOperand(side.term, scopeValue);
    if (value === undefined) {
      return undefined;
    }
    return side.measure === "length" ? sizeOf(value) : (value as number);
  };
  return borders.map(border => ({
    path: `${first.path} − ${second.path}`,
    comparison: rule,
    border,
    coordinateOf: reached => {
      const a = read(first, reached.scope);
      const b = read(second, reached.scope);
      return a === undefined || b === undefined ? undefined : a - b;
    },
    compose: (given, coordinate) => {
      const moved = at(first.path);
      const other = at(second.path)?.valuesIn(given)[0];
      if (moved === undefined || other === undefined) {
        return undefined;
      }
      const base = second.measure === "length" ? sizeOf(other) : (other as number);
      return moved.write(given, first.measure, base + (coordinate as number));
    },
  }));
}

function schemaAt(schema: AnySchema, keys: readonly string[]): AnySchema | undefined {
  const unwrapped =
    schema.kind === "optional" ? (schema as OptionalSchema<unknown>).schema : schema;
  const [key, ...rest] = keys;
  if (key === undefined) {
    return unwrapped;
  }
  if (unwrapped.kind !== "object") {
    return undefined;
  }
  const field = (unwrapped as ObjectSchema<ObjectShape>).shape[key];
  return field === undefined ? undefined : schemaAt(field, rest);
}
