import type { Carrier } from "./border.js";
import { normalize } from "./border.js";
import { inheritedAt } from "./guard-borders.js";
import { carrierOf } from "./partition.js";
import type { CompareRule, Operator, Rule, Term } from "./rule.js";
import { boundTermPath, conjuncts, describeRule, holds, isTerm, termData, termPaths } from "./rule.js";
import type { AnySchema, AnyVariantsSchema, EnumSchema } from "./schema.js";
import { isVariantsSchema, schemaAtPath } from "./schema.js";
import type { Step, Way } from "./ways.js";

export type Feasibility =
  | { readonly kind: "feasible" }
  | { readonly kind: "infeasible"; readonly reason: string }
  | { readonly kind: "undecided"; readonly reason: string };

type Measure = "value" | "length";

interface Constraint {
  readonly operator: Operator;
  readonly bound: unknown;
}

interface Group {
  readonly path: readonly string[];
  readonly measure: Measure;
  readonly constraints: Constraint[];
}

interface Relation {
  readonly left: string;
  readonly right: string;
  readonly operator: Operator;
}

interface Edge {
  readonly value: unknown;
  readonly inclusive: boolean;
}

interface Interval {
  readonly carrier: Carrier;
  readonly lower: Edge | undefined;
  readonly upper: Edge | undefined;
}

const negated: Readonly<Record<Operator, Operator>> = {
  "<": ">=",
  "<=": ">",
  ">": "<=",
  ">=": "<",
  "==": "!=",
  "!=": "==",
};

const mirrored: Readonly<Record<Operator, Operator>> = {
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
  "==": "==",
  "!=": "!=",
};

export const contradicts = "ガードの条件がこの値について両立しない";
export const unreadable = "読めない条件が同じ値を読む別の条件と重なる";

export interface Placement {
  readonly path: readonly string[];
  readonly measure: Measure;
  readonly operator: Operator;
  readonly bound: unknown;
}

export function feasibilityOf(
  way: Pick<Way, "steps">,
  scope: AnySchema,
  placement?: Placement,
): Feasibility {
  const groups = new Map<string, Group>();
  const relations: Relation[] = [];
  const opaque: (readonly (readonly string[])[])[] = [];
  const outcomes = new Map<string, boolean | string>();
  const groupFor = (path: readonly string[], measure: Measure): string => {
    const key = JSON.stringify([path, measure]);
    if (!groups.has(key)) {
      groups.set(key, { path, measure, constraints: [] });
    }
    return key;
  };

  if (placement !== undefined) {
    groups
      .get(groupFor(placement.path, placement.measure))!
      .constraints.push({ operator: placement.operator, bound: placement.bound });
  }
  for (const step of way.steps) {
    const key = stepKey(step);
    const seen = outcomes.get(key);
    if (seen !== undefined) {
      if (seen !== step.outcome) {
        return { kind: "infeasible", reason: contradicts };
      }
      continue;
    }
    outcomes.set(key, step.outcome);
    const { distinction, outcome } = step;
    if (distinction.kind === "match") {
      groups
        .get(groupFor(termData(distinction.on).path, "value"))!
        .constraints.push({ operator: "==", bound: outcome });
      continue;
    }
    if (distinction.kind !== "compare") {
      opaque.push(termPaths(distinction));
      continue;
    }
    const normalized = normalize(distinction);
    if (normalized !== undefined) {
      const term = (isTerm(distinction.left) ? distinction.left : distinction.right) as Term<unknown>;
      groups.get(groupFor(termData(term).path, normalized.measure))!.constraints.push({
        operator: outcome === true ? normalized.operator : negated[normalized.operator],
        bound: normalized.bound,
      });
      continue;
    }
    const operator = outcome === true ? distinction.operator : negated[distinction.operator];
    const relation = relationOf(distinction, operator, groupFor);
    if (relation === undefined) {
      opaque.push(termPaths(distinction));
    } else {
      relations.push(relation);
    }
  }

  const intervals = new Map<string, Interval | undefined>();
  let unsettled = false;
  for (const [key, group] of groups) {
    const settled = settle(group, scope);
    if (settled === false) {
      return { kind: "infeasible", reason: contradicts };
    }
    intervals.set(key, typeof settled === "object" ? settled : undefined);
    unsettled ||= settled === undefined && group.constraints.length > 1;
  }

  const related = relations.flatMap(relation => [relation.left, relation.right]);
  for (const relation of relations) {
    const left = intervals.get(relation.left);
    const right = intervals.get(relation.right);
    const shared = [relation.left, relation.right].some(
      key => related.filter(other => other === key).length > 1,
    );
    if (left === undefined || right === undefined || shared) {
      unsettled = true;
      continue;
    }
    if (!admitsRelation(relation.operator, left, right)) {
      return { kind: "infeasible", reason: contradicts };
    }
  }

  const readPaths = [...groups.values()].map(group => group.path);
  const overlaps = opaque.some((paths, index) =>
    paths.some(path =>
      [...readPaths, ...opaque.filter((_, other) => other !== index).flat()].some(other =>
        sharesValue(path, other),
      ),
    ),
  );
  return overlaps || unsettled
    ? { kind: "undecided", reason: unreadable }
    : { kind: "feasible" };
}

function stepKey(step: Step): string {
  return step.distinction.kind === "match"
    ? `match ${termData(step.distinction.on).path.join(".")}`
    : describeRule(step.distinction);
}

function relationOf(
  rule: CompareRule,
  operator: Operator,
  groupFor: (path: readonly string[], measure: Measure) => string,
): Relation | undefined {
  if (!isTerm(rule.left) || !isTerm(rule.right)) {
    return undefined;
  }
  const left = termData(rule.left as Term<unknown>);
  const right = termData(rule.right as Term<unknown>);
  return {
    left: groupFor(left.path, left.measure),
    right: groupFor(right.path, right.measure),
    operator,
  };
}

function sharesValue(left: readonly string[], right: readonly string[]): boolean {
  const length = Math.min(left.length, right.length);
  return left.slice(0, length).every((key, index) => key === right[index]);
}

function settle(group: Group, scope: AnySchema): Interval | boolean | undefined {
  const { path, measure } = group;
  const discriminated = measure === "value" ? sumOwning(scope, path) : undefined;
  if (discriminated !== undefined) {
    // A case the sum's invariants refuse is no value the discriminant can take.
    const discriminant = path[path.length - 1]!;
    const refusing = [...discriminated.invariants, ...inheritedAt(scope, path.slice(0, -1))]
      .flatMap(conjuncts)
      .filter(rule => boundTermPath(rule)?.join("\u0000") === discriminant);
    const admitted = discriminated.variantTags.filter(tag =>
      refusing.every(rule => holds(rule, { [discriminant]: tag })),
    );
    return finite(admitted, group.constraints);
  }
  const schema = schemaAtPath(scope, path);
  if (schema === undefined) {
    return undefined;
  }
  if (measure === "value" && schema.kind === "boolean") {
    return finite(admittedBy([true, false], schema, scope, path), group.constraints);
  }
  if (measure === "value" && schema.kind === "enum") {
    return finite(admittedBy((schema as EnumSchema<string>).values, schema, scope, path), group.constraints);
  }
  const carrier = carrierOf(schema, measure);
  if (carrier === undefined) {
    return undefined;
  }
  const invariants = [...schema.invariants, ...inheritedAt(scope, path)]
    .flatMap(conjuncts)
    .flatMap((rule: Rule): Constraint[] => {
      if (boundTermPath(rule)?.length !== 0) {
        return [];
      }
      const normalized = normalize(rule);
      return normalized === undefined || normalized.measure !== measure
        ? []
        : [{ operator: normalized.operator, bound: normalized.bound }];
    });
  return ordered([...group.constraints, ...invariants], carrier);
}

// The values of a finite domain the position's own invariants keep, the way its
// classes leave out the ones an invariant refuses.
function admittedBy(
  domain: readonly unknown[],
  schema: AnySchema,
  scope: AnySchema,
  path: readonly string[],
): readonly unknown[] {
  const own = [...schema.invariants, ...inheritedAt(scope, path)]
    .flatMap(conjuncts)
    .filter(rule => boundTermPath(rule)?.length === 0);
  return domain.filter(value => own.every(rule => holds(rule, value)));
}

function sumOwning(scope: AnySchema, path: readonly string[]): AnyVariantsSchema | undefined {
  const owner = schemaAtPath(scope, path.slice(0, -1));
  return owner !== undefined && isVariantsSchema(owner) && owner.discriminant === path[path.length - 1]
    ? owner
    : undefined;
}

function finite(domain: readonly unknown[], constraints: readonly Constraint[]): boolean | undefined {
  if (constraints.some(item => item.operator !== "==" && item.operator !== "!=")) {
    return undefined;
  }
  return domain.some(value =>
    constraints.every(item => (value === item.bound) === (item.operator === "==")),
  );
}

function ordered(constraints: readonly Constraint[], carrier: Carrier): Interval | false {
  let lower: Edge | undefined =
    carrier.floor === undefined ? undefined : { value: carrier.floor.value, inclusive: true };
  let upper: Edge | undefined =
    carrier.ceiling === undefined ? undefined : { value: carrier.ceiling.value, inclusive: true };
  const equal: unknown[] = [];
  const unequal: unknown[] = [];
  for (const { operator, bound } of constraints) {
    const edge = { value: bound, inclusive: operator === ">=" || operator === "<=" };
    if (operator === ">" || operator === ">=") {
      lower = tighter(lower, edge, 1, carrier);
    } else if (operator === "<" || operator === "<=") {
      upper = tighter(upper, edge, -1, carrier);
    } else if (operator === "==") {
      equal.push(bound);
    } else {
      unequal.push(bound);
    }
  }
  const within = (value: unknown) =>
    above(value, lower, carrier) &&
    below(value, upper, carrier) &&
    unequal.every(refused => carrier.compare(value, refused) !== 0);
  if (equal.length > 0) {
    const [value] = equal;
    return equal.every(other => carrier.compare(other, value) === 0) && within(value)
      ? { carrier, lower: { value, inclusive: true }, upper: { value, inclusive: true } }
      : false;
  }
  const interval = { carrier, lower, upper };
  if (lower === undefined || upper === undefined) {
    return interval;
  }
  const { step } = carrier;
  if (step === undefined) {
    const order = carrier.compare(lower.value, upper.value);
    return order < 0 || (order === 0 && within(lower.value)) ? interval : false;
  }
  let candidate = lower.inclusive ? lower.value : step(lower.value, 1);
  for (let tried = 0; tried <= unequal.length; tried += 1) {
    if (candidate === undefined || !below(candidate, upper, carrier)) {
      return false;
    }
    if (within(candidate)) {
      return interval;
    }
    candidate = step(candidate, 1);
  }
  return false;
}

function admitsRelation(operator: Operator, left: Interval, right: Interval): boolean {
  const { carrier } = left;
  switch (operator) {
    case "==":
      return reaches(left.lower, right.upper, carrier) && reaches(right.lower, left.upper, carrier);
    case "!=":
      return !(
        single(left) &&
        single(right) &&
        carrier.compare(left.lower!.value, right.lower!.value) === 0
      );
    case "<":
      return strictlyReaches(left.lower, right.upper, carrier);
    case "<=":
      return reaches(left.lower, right.upper, carrier);
    case ">":
    case ">=":
      return admitsRelation(mirrored[operator], right, left);
  }
}

function reaches(low: Edge | undefined, high: Edge | undefined, carrier: Carrier): boolean {
  if (low === undefined || high === undefined) {
    return true;
  }
  const order = carrier.compare(low.value, high.value);
  return order < 0 || (order === 0 && low.inclusive && high.inclusive);
}

function strictlyReaches(low: Edge | undefined, high: Edge | undefined, carrier: Carrier): boolean {
  return low === undefined || high === undefined || carrier.compare(low.value, high.value) < 0;
}

function single(interval: Interval): boolean {
  return (
    interval.lower !== undefined &&
    interval.upper !== undefined &&
    interval.carrier.compare(interval.lower.value, interval.upper.value) === 0
  );
}

function above(value: unknown, lower: Edge | undefined, carrier: Carrier): boolean {
  if (lower === undefined) {
    return true;
  }
  const order = carrier.compare(value, lower.value);
  return order > 0 || (lower.inclusive && order === 0);
}

function below(value: unknown, upper: Edge | undefined, carrier: Carrier): boolean {
  if (upper === undefined) {
    return true;
  }
  const order = carrier.compare(value, upper.value);
  return order < 0 || (upper.inclusive && order === 0);
}

function tighter(
  current: Edge | undefined,
  next: Edge,
  direction: 1 | -1,
  carrier: Carrier,
): Edge {
  if (current === undefined) {
    return next;
  }
  const order = carrier.compare(next.value, current.value) * direction;
  if (order > 0) {
    return next;
  }
  if (order < 0) {
    return current;
  }
  return current.inclusive ? next : current;
}

export interface Witness {
  readonly path: readonly string[];
  readonly value: unknown;
}

// One value per finite position a way compares, or undefined when a step reads
// anything else.
export function witnessesOf(way: Pick<Way, "steps">, scope: AnySchema): readonly Witness[] | undefined {
  const groups = new Map<string, { path: readonly string[]; constraints: Constraint[] }>();
  for (const { distinction, outcome } of way.steps) {
    let path: readonly string[];
    let constraint: Constraint;
    if (distinction.kind === "match") {
      path = termData(distinction.on).path;
      constraint = { operator: "==", bound: outcome };
    } else {
      if (distinction.kind !== "compare") {
        return undefined;
      }
      const normalized = normalize(distinction);
      if (normalized === undefined || normalized.measure !== "value") {
        return undefined;
      }
      const term = (isTerm(distinction.left) ? distinction.left : distinction.right) as Term<unknown>;
      path = termData(term).path;
      constraint = {
        operator: outcome === true ? normalized.operator : negated[normalized.operator],
        bound: normalized.bound,
      };
    }
    const key = JSON.stringify(path);
    if (!groups.has(key)) {
      groups.set(key, { path, constraints: [] });
    }
    groups.get(key)!.constraints.push(constraint);
  }
  const witnesses: Witness[] = [];
  for (const { path, constraints } of groups.values()) {
    const domain = finiteDomainAt(scope, path);
    if (domain === undefined || constraints.some(item => item.operator !== "==" && item.operator !== "!=")) {
      return undefined;
    }
    const value = domain.find(candidate =>
      constraints.every(item => (candidate === item.bound) === (item.operator === "==")),
    );
    if (value === undefined) {
      return undefined;
    }
    witnesses.push({ path, value });
  }
  return witnesses;
}

function finiteDomainAt(scope: AnySchema, path: readonly string[]): readonly unknown[] | undefined {
  const discriminated = sumOwning(scope, path);
  if (discriminated !== undefined) {
    const discriminant = path[path.length - 1]!;
    const refusing = [...discriminated.invariants, ...inheritedAt(scope, path.slice(0, -1))]
      .flatMap(conjuncts)
      .filter(rule => boundTermPath(rule)?.join("\u0000") === discriminant);
    return discriminated.variantTags.filter(tag =>
      refusing.every(rule => holds(rule, { [discriminant]: tag })),
    );
  }
  const schema = schemaAtPath(scope, path);
  if (schema?.kind === "boolean") {
    return admittedBy([true, false], schema, scope, path);
  }
  if (schema?.kind === "enum") {
    return admittedBy((schema as EnumSchema<string>).values, schema, scope, path);
  }
  return undefined;
}
