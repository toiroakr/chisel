import type { Carrier } from "./border.js";
import { normalize } from "./border.js";
import { inheritedAt } from "./guard-borders.js";
import { carrierOf } from "./partition.js";
import type { CompareRule, Operator, Rule, Term } from "./rule.js";
import { boundTermPath, conjuncts, describeRule, holds, isTerm, termData, termPaths } from "./rule.js";
import type { AnySchema, AnyVariantsSchema, EnumSchema, ObjectSchema, ObjectShape } from "./schema.js";
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

// How many combinations of finite values feasibility tries against the
// invariants relating them, before leaving a way or a point undecided.
export const FEASIBILITY_COMBINATION_LIMIT = 4096;

export function tooManyCombinations(limit: number): string {
  return `不変条件とあわせて調べる値の組が上限の${limit}通りを超える`;
}

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
  combinations: number = FEASIBILITY_COMBINATION_LIMIT,
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
    const placed = placedConstraintOf(step);
    if (placed !== undefined) {
      groups.get(groupFor(placed.path, placed.measure))!.constraints.push(placed.constraint);
      continue;
    }
    const { distinction, outcome } = step;
    if (distinction.kind === "all" || distinction.kind === "any") {
      opaque.push(termPaths(distinction));
      continue;
    }
    if (distinction.kind !== "compare") {
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
  const joint = jointAssignment([...groups.values()], scope, combinations);
  if (joint === "none") {
    return { kind: "infeasible", reason: contradicts };
  }
  if (joint === "too many") {
    return { kind: "undecided", reason: tooManyCombinations(combinations) };
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

// The constraint a step puts on one coordinate: a match, or a comparison with a constant.
function placedConstraintOf(
  step: Step,
): { readonly path: readonly string[]; readonly measure: Measure; readonly constraint: Constraint } | undefined {
  const { distinction, outcome } = step;
  if (distinction.kind === "match") {
    return { path: termData(distinction.on).path, measure: "value", constraint: { operator: "==", bound: outcome } };
  }
  if (distinction.kind !== "compare") {
    return undefined;
  }
  const normalized = normalize(distinction);
  if (normalized === undefined) {
    return undefined;
  }
  const term = (isTerm(distinction.left) ? distinction.left : distinction.right) as Term<unknown>;
  return {
    path: termData(term).path,
    measure: normalized.measure,
    constraint: {
      operator: outcome === true ? normalized.operator : negated[normalized.operator],
      bound: normalized.bound,
    },
  };
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
  const domain = measure === "value" ? finiteDomainAt(scope, path) : undefined;
  if (domain !== undefined) {
    return finite(domain, group.constraints);
  }
  const schema = schemaAtPath(scope, path);
  if (schema === undefined) {
    return undefined;
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
export function witnessesOf(
  way: Pick<Way, "steps">,
  scope: AnySchema,
  inputCase?: { readonly discriminant: string; readonly tag: string },
): readonly Witness[] | undefined {
  const groups = new Map<string, { path: readonly string[]; constraints: Constraint[] }>();
  for (const step of way.steps) {
    const placed = placedConstraintOf(step);
    if (placed === undefined || placed.measure !== "value") {
      return undefined;
    }
    const key = JSON.stringify(placed.path);
    if (!groups.has(key)) {
      groups.set(key, { path: placed.path, constraints: [] });
    }
    groups.get(key)!.constraints.push(placed.constraint);
  }
  const witnesses: Witness[] = [];
  for (const { path, constraints } of groups.values()) {
    const domain =
      inputCase !== undefined && path.length === 1 && path[0] === inputCase.discriminant
        ? [inputCase.tag]
        : finiteDomainAt(scope, path);
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
    // A case the sum's invariants refuse is no value the discriminant can take.
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

// A rule over finite positions: each comparison reads one of them against a
// constant with == or !=, combined with and/or/not. Its positions, or
// undefined when any part of it reads something else.
function finitePathsOf(
  rule: Rule,
  scope: AnySchema,
  prefix: readonly string[],
): readonly (readonly string[])[] | undefined {
  switch (rule.kind) {
    case "compare": {
      const normalized = normalize(rule);
      if (normalized === undefined || normalized.measure !== "value") {
        return undefined;
      }
      if (normalized.operator !== "==" && normalized.operator !== "!=") {
        return undefined;
      }
      const term = (isTerm(rule.left) ? rule.left : rule.right) as Term<unknown>;
      const path = [...prefix, ...termData(term).path];
      return finiteDomainAt(scope, path) === undefined ? undefined : [path];
    }
    case "not":
      return finitePathsOf(rule.rule, scope, prefix);
    case "and":
    case "or": {
      const parts = rule.rules.map(part => finitePathsOf(part, scope, prefix));
      return parts.some(part => part === undefined) ? undefined : parts.flat() as (readonly string[])[];
    }
    default:
      return undefined;
  }
}

// Values for the finite positions the groups constrain, together with every
// finite position an invariant relating two or more of them reaches, that
// keep those invariants: "none" when no such values exist, "too many" when
// there are more combinations to try than the limit.
function jointAssignment(
  groups: readonly Group[],
  scope: AnySchema,
  combinations: number,
): ReadonlyMap<string, unknown> | "none" | "too many" {
  const joint = scopedInvariants(scope, []).flatMap(({ prefix, rule }) => {
    const paths = finitePathsOf(rule, scope, prefix);
    const distinct = paths === undefined ? [] : [...new Map(paths.map(path => [JSON.stringify(path), path])).values()];
    return distinct.length < 2 ? [] : [{ prefix, rule, paths: distinct }];
  });
  const constrained = groups.filter(group => group.measure === "value" && finiteDomainAt(scope, group.path) !== undefined);
  const component = new Map(constrained.map(group => [JSON.stringify(group.path), group.path] as const));
  const involved: (typeof joint)[number][] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const invariant of joint) {
      const { paths } = invariant;
      if (!involved.includes(invariant) && paths.some(path => component.has(JSON.stringify(path)))) {
        involved.push(invariant);
        for (const path of paths) {
          component.set(JSON.stringify(path), path);
        }
        grew = true;
      }
    }
  }
  const positions = [...component.values()];
  if (involved.length === 0) {
    return new Map();
  }
  const domains = positions.map(path => {
    const keeps = constrained.filter(group => JSON.stringify(group.path) === JSON.stringify(path));
    return finiteDomainAt(scope, path)!.filter(value =>
      keeps.every(group =>
        group.constraints.every(item => (value === item.bound) === (item.operator === "==")),
      ),
    );
  });
  if (domains.reduce((product, domain) => product * domain.length, 1) > combinations) {
    return "too many";
  }
  const chosen: unknown[] = [];
  const search = (index: number): boolean => {
    if (index === positions.length) {
      const value = positions.reduce<unknown>((built, path, at) => writeAt(built, path, chosen[at]), {});
      return involved.every(({ prefix, rule }) => holds(rule, readAt(value, prefix)));
    }
    return domains[index]!.some(candidate => {
      chosen[index] = candidate;
      return search(index + 1);
    });
  };
  return search(0)
    ? new Map(positions.map((path, index) => [JSON.stringify(path), chosen[index]]))
    : "none";
}

function writeAt(value: unknown, path: readonly string[], leaf: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) {
    return leaf;
  }
  const record = (typeof value === "object" && value !== null ? value : {}) as Readonly<Record<string, unknown>>;
  return { ...record, [key]: writeAt(record[key], rest, leaf) };
}

// Every invariant written on the scope or on an object its fields hold, with
// the path of the object it is written on.
function scopedInvariants(
  schema: AnySchema,
  prefix: readonly string[],
): readonly { readonly prefix: readonly string[]; readonly rule: Rule }[] {
  if (schema.kind !== "object") {
    return [];
  }
  const { shape } = schema as ObjectSchema<ObjectShape>;
  return [
    ...schema.invariants.map(rule => ({ prefix, rule })),
    ...Object.entries(shape).flatMap(([key, field]) => scopedInvariants(field, [...prefix, key])),
  ];
}

function readAt(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (current, key) =>
      typeof current === "object" && current !== null
        ? (current as Readonly<Record<string, unknown>>)[key]
        : undefined,
    value,
  );
}
