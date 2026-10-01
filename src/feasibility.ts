import { isDeepStrictEqual } from "node:util";
import type { Carrier } from "./border.js";
import { integerCarrier, normalize, numberCarrier } from "./border.js";
import { inheritedAt } from "./guard-borders.js";
import { carrierOf } from "./partition.js";
import type { CompareRule, LinearTermData, Operator, Rule, Term } from "./rule.js";
import { DEPS, boundTermPath, conjuncts, describeRule, differenceOf, holds, isTerm, positionData, positionOf, readOperand, termData, termPaths } from "./rule.js";
import type { AnySchema, AnyVariantsSchema, EnumSchema, ObjectSchema, ObjectShape, OptionalSchema } from "./schema.js";
import { isVariantsSchema, schemaAtPath } from "./schema.js";
import type { RulesDecision } from "./behavior.js";
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
export const unreached = "どの値の組もこの分岐を通らない";

// How many combinations of finite values feasibility tries against the
// invariants relating them, before leaving a way or a point undecided.
export const FEASIBILITY_COMBINATION_LIMIT = 4096;

export function tooManyWays(limit: number): string {
  return `道筋が上限の${limit}本を超える`;
}

export function tooManyCombinations(limit: number): string {
  return `不変条件とあわせて調べる値の組が上限の${limit}通りを超える`;
}

export type Placement =
  | {
      readonly path: readonly string[];
      readonly measure: Measure;
      readonly operator: Operator;
      readonly bound: unknown;
    }
  | {
      readonly between: readonly [
        { readonly path: readonly string[]; readonly measure: Measure },
        { readonly path: readonly string[]; readonly measure: Measure },
      ];
      readonly operator: Operator;
      readonly bound: unknown;
    }
  | {
      readonly form: LinearTermData;
      readonly operator: Operator;
      readonly bound: unknown;
    };

// A sum of coordinates weighed by whole numbers, as a comparison of two of
// them or of an expression constrains it.
interface Form {
  readonly parts: readonly { readonly key: string; readonly coefficient: number }[];
  readonly constraints: Constraint[];
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

  const forms = new Map<string, Form>();
  let constant = true;
  const constrain = (
    weighed: readonly { readonly key: string; readonly coefficient: number }[],
    operator: Operator,
    bound: number,
  ): void => {
    const merged = new Map<string, number>();
    for (const { key, coefficient } of weighed) {
      merged.set(key, (merged.get(key) ?? 0) + coefficient);
    }
    const parts = [...merged]
      .filter(([, coefficient]) => coefficient !== 0)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, coefficient]) => ({ key, coefficient }));
    if (parts.length === 0) {
      constant &&= holds({ kind: "compare", left: 0, operator, right: bound } as Rule, undefined);
      return;
    }
    const sign = parts[0]!.coefficient < 0 ? -1 : 1;
    const canonical = parts.map(part => ({ key: part.key, coefficient: sign * part.coefficient }));
    const key = JSON.stringify(canonical);
    if (!forms.has(key)) {
      forms.set(key, { parts: canonical, constraints: [] });
    }
    forms
      .get(key)!
      .constraints.push(sign === 1 ? { operator, bound } : { operator: mirrored[operator], bound: -bound });
  };
  const differ = (left: string, right: string, operator: Operator, bound: number): void =>
    constrain(
      [
        { key: left, coefficient: 1 },
        { key: right, coefficient: -1 },
      ],
      operator,
      bound,
    );
  const constrainForm = (form: LinearTermData, operator: Operator, bound: number): void =>
    constrain(
      form.parts.map(part => ({ key: groupFor(part.path, part.measure), coefficient: part.coefficient })),
      operator,
      bound - (form.constant as number),
    );

  if (placement !== undefined && "between" in placement) {
    const [left, right] = placement.between;
    differ(
      groupFor(left.path, left.measure),
      groupFor(right.path, right.measure),
      placement.operator,
      placement.bound as number,
    );
  } else if (placement !== undefined && "form" in placement) {
    constrainForm(placement.form, placement.operator, placement.bound as number);
  } else if (placement !== undefined) {
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
    const form = readableFormOf(distinction, scope);
    if (form !== undefined) {
      constrainForm(form, operator, 0);
      continue;
    }
    const relation = relationOf(distinction, operator, groupFor);
    if (relation === undefined) {
      opaque.push(termPaths(distinction));
    } else {
      relations.push(relation);
      differ(relation.left, relation.right, relation.operator, 0);
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

  if (!constant) {
    return { kind: "infeasible", reason: contradicts };
  }
  const related = [...forms.values()].flatMap(form => form.parts.map(part => part.key));
  for (const form of forms.values()) {
    const carrier = differenceCarrierOf(
      form.parts.map(part => groups.get(part.key)!),
      scope,
    );
    if (carrier === undefined) {
      unsettled ||= form.constraints.length > 1;
      continue;
    }
    if (ordered(form.constraints, carrier) === false) {
      return { kind: "infeasible", reason: contradicts };
    }
    if (isPair(form)) {
      continue;
    }
    // Not settled on the parts' own intervals, as a pair is below: the values an
    // expression can take once each part is bounded are not one interval to meet.
    const free = form.parts.every(
      part =>
        groups.get(part.key)!.constraints.length === 0 &&
        related.filter(other => other === part.key).length === 1 &&
        intervals.get(part.key)?.lower === undefined &&
        intervals.get(part.key)?.upper === undefined,
    );
    unsettled ||= !free || (carrier === integerCarrier && !form.parts.some(part => Math.abs(part.coefficient) === 1));
  }

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
    return { path: positionOf(distinction.on).path, measure: "value", constraint: { operator: "==", bound: outcome } };
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
    path: positionOf(term).path,
    measure: normalized.measure,
    constraint: {
      operator: outcome === true ? normalized.operator : negated[normalized.operator],
      bound: normalized.bound,
    },
  };
}

function stepKey(step: Step): string {
  return step.distinction.kind === "match"
    ? `match ${positionOf(step.distinction.on).path.join(".")}`
    : describeRule(step.distinction);
}

function isPair(form: Form): boolean {
  return form.parts.length === 2 && form.parts[0]!.coefficient === 1 && form.parts[1]!.coefficient === -1;
}

// An expression of integer or number positions, read as the left side less the
// right; a decimal or another kind of part leaves the comparison unread.
function readableFormOf(rule: CompareRule, scope: AnySchema): LinearTermData | undefined {
  if (![rule.left, rule.right].some(operand => isTerm(operand) && positionData(operand as Term<unknown>) === undefined)) {
    return undefined;
  }
  const form = differenceOf(rule);
  const kinds = form.parts.map(part =>
    part.measure === "length" ? "integer" : schemaAtPath(scope, part.path)?.kind,
  );
  return typeof form.constant === "number" && kinds.every(kind => kind === "integer" || kind === "number")
    ? form
    : undefined;
}

function relationOf(
  rule: CompareRule,
  operator: Operator,
  groupFor: (path: readonly string[], measure: Measure) => string,
): Relation | undefined {
  if (!isTerm(rule.left) || !isTerm(rule.right)) {
    return undefined;
  }
  const left = positionData(rule.left as Term<unknown>);
  const right = positionData(rule.right as Term<unknown>);
  if (left === undefined || right === undefined) {
    return undefined;
  }
  return {
    left: groupFor(left.path, left.measure),
    right: groupFor(right.path, right.measure),
    operator,
  };
}

// Only a difference counted in whole steps or in plain numbers is settled here;
// two decimals or two instants differ in units their readers convert to, which
// the steps of a way do not carry.
function differenceCarrierOf(sides: readonly Group[], scope: AnySchema): Carrier | undefined {
  const kinds = sides.map(side =>
    side.measure === "length" ? "integer" : schemaAtPath(scope, side.path)?.kind,
  );
  if (kinds.every(kind => kind === "integer")) {
    return integerCarrier;
  }
  return kinds.every(kind => kind === "integer" || kind === "number") ? numberCarrier : undefined;
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

// The combinations of values a way's finite positions can take together with
// the finite positions an invariant relates them to, keeping those
// invariants; undefined when a step reads anything else or there are more
// combinations to try than the limit.
export function witnessesOf(
  way: Pick<Way, "steps">,
  scope: AnySchema,
  inputCase?: { readonly discriminant: string; readonly tag: string },
  combinations: number = FEASIBILITY_COMBINATION_LIMIT,
): Iterable<readonly Witness[]> | undefined {
  const groups = new Map<string, Group>();
  const constrain = (path: readonly string[], constraint: Constraint) => {
    const key = JSON.stringify(path);
    if (!groups.has(key)) {
      groups.set(key, { path, measure: "value", constraints: [] });
    }
    groups.get(key)!.constraints.push(constraint);
  };
  for (const step of way.steps) {
    const placed = placedConstraintOf(step);
    if (
      placed === undefined ||
      placed.measure !== "value" ||
      (placed.constraint.operator !== "==" && placed.constraint.operator !== "!=") ||
      finiteDomainAt(scope, placed.path) === undefined
    ) {
      return undefined;
    }
    constrain(placed.path, placed.constraint);
  }
  if (inputCase !== undefined && groups.has(JSON.stringify([inputCase.discriminant]))) {
    constrain([inputCase.discriminant], { operator: "==", bound: inputCase.tag });
  }
  const tried = jointAssignments([...groups.values()], scope, combinations, undefined, true);
  if (tried === "too many") {
    return undefined;
  }
  return (function* () {
    for (const assignment of tried) {
      yield [...assignment].map(([key, value]) => ({ path: JSON.parse(key) as string[], value }));
    }
  })();
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
      if (isTerm(rule.left) && isTerm(rule.right)) {
        const sides = [rule.left, rule.right].map(side => positionData(side as Term<unknown>));
        if (sides.some(side => side === undefined)) {
          return undefined;
        }
        const paths = sides.map(side => [...prefix, ...side!.path]);
        return (rule.operator === "==" || rule.operator === "!=") &&
          sides.every(side => side!.measure === "value") &&
          paths.every(path => finiteDomainAt(scope, path) !== undefined)
          ? paths
          : undefined;
      }
      const normalized = normalize(rule);
      if (normalized === undefined || normalized.measure !== "value") {
        return undefined;
      }
      if (normalized.operator !== "==" && normalized.operator !== "!=") {
        return undefined;
      }
      const term = (isTerm(rule.left) ? rule.left : rule.right) as Term<unknown>;
      const path = [...prefix, ...positionOf(term).path];
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

// The combinations of values for the finite positions the groups constrain,
// together with every finite position an invariant relating two or more of
// them reaches, that keep those invariants, in the order of `prefer`; "too
// many" when there are more combinations to try than the limit. Unless
// `whole`, positions no such invariant reaches are left out, and nothing is
// tried when there are none.
function jointAssignments(
  groups: readonly Group[],
  scope: AnySchema,
  combinations: number,
  prefer: (path: readonly string[]) => unknown = () => undefined,
  whole = false,
): Iterable<ReadonlyMap<string, unknown>> | "too many" {
  const joint = jointInvariantsOf(scope);
  const constrained = groups.filter(group => group.measure === "value" && finiteDomainAt(scope, group.path) !== undefined);
  const component = new Map(constrained.map(group => [JSON.stringify(group.path), group.path] as const));
  const involved: JointInvariant[] = [];
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
  if (involved.length === 0 && !whole) {
    return [new Map()];
  }
  const domains = positions.map(path => {
    const keeps = constrained.filter(group => JSON.stringify(group.path) === JSON.stringify(path));
    const kept = finiteDomainAt(scope, path)!.filter(value =>
      keeps.every(group =>
        group.constraints.every(item => (value === item.bound) === (item.operator === "==")),
      ),
    );
    const preferred = prefer(path);
    return kept.includes(preferred) ? [preferred, ...kept.filter(value => value !== preferred)] : kept;
  });
  if (domains.reduce((product, domain) => product * domain.length, 1) > combinations) {
    return "too many";
  }
  function* from(index: number, chosen: readonly unknown[]): Generator<ReadonlyMap<string, unknown>> {
    if (index === positions.length) {
      const value = positions.reduce<unknown>((built, path, at) => writeAt(built, path, chosen[at]), {});
      if (involved.every(({ prefix, rule }) => holds(rule, readAt(value, prefix)))) {
        yield new Map(positions.map((path, at) => [JSON.stringify(path), chosen[at]]));
      }
      return;
    }
    for (const candidate of domains[index]!) {
      yield* from(index + 1, [...chosen, candidate]);
    }
  }
  return from(0, []);
}

// The first of the combinations jointAssignments tries, or "none".
function jointAssignment(
  groups: readonly Group[],
  scope: AnySchema,
  combinations: number,
  prefer?: (path: readonly string[]) => unknown,
): ReadonlyMap<string, unknown> | "none" | "too many" {
  const tried = jointAssignments(groups, scope, combinations, prefer);
  if (tried === "too many") {
    return "too many";
  }
  for (const first of tried) {
    return first;
  }
  return "none";
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

// The value `after` becomes when the finite positions an invariant relates,
// other than those `after` moved away from `before`, are chosen again so every
// such invariant holds, keeping what `after` holds wherever it can; undefined
// when no choice keeps them, when there are more combinations than the limit,
// or when it would take another case of a sum field.
export function keepingInvariants(
  scope: AnySchema,
  before: unknown,
  after: unknown,
  combinations: number = FEASIBILITY_COMBINATION_LIMIT,
): unknown {
  const related = distinctPaths(jointInvariantsOf(scope).flatMap(invariant => invariant.paths));
  const groups = related.map(
    (path): Group => ({
      path,
      measure: "value",
      constraints: isDeepStrictEqual(readAt(before, path), readAt(after, path))
        ? []
        : [{ operator: "==", bound: readAt(after, path) }],
    }),
  );
  const assignment = jointAssignment(groups, scope, combinations, path => readAt(after, path));
  if (typeof assignment === "string") {
    return undefined;
  }
  let kept = after;
  for (const [key, value] of assignment) {
    const path = JSON.parse(key) as string[];
    if (readAt(kept, path) === value) {
      continue;
    }
    if (sumOwning(scope, path) !== undefined) {
      return undefined;
    }
    kept = writeAt(kept, path, value);
  }
  return kept;
}

// Whether no combination the invariants relating finite positions keep gives
// the position at `path` this value.
export function refusedJointly(
  scope: AnySchema,
  path: readonly string[],
  value: unknown,
  combinations: number = FEASIBILITY_COMBINATION_LIMIT,
): boolean {
  return (
    finiteDomainAt(scope, path) !== undefined &&
    jointAssignment([{ path, measure: "value", constraints: [{ operator: "==", bound: value }] }], scope, combinations) ===
      "none"
  );
}

interface JointInvariant {
  readonly prefix: readonly string[];
  readonly rule: Rule;
  readonly paths: readonly (readonly string[])[];
}

// The invariants the scope holds that relate two or more finite positions,
// each with the positions it reads.
function jointInvariantsOf(scope: AnySchema): readonly JointInvariant[] {
  return scopedInvariants(scope, []).flatMap(({ prefix, rule }) => {
    const paths = finitePathsOf(rule, scope, prefix);
    const distinct = paths === undefined ? [] : distinctPaths(paths);
    return distinct.length < 2 ? [] : [{ prefix, rule, paths: distinct }];
  });
}

function distinctPaths(paths: readonly (readonly string[])[]): readonly (readonly string[])[] {
  return [...new Map(paths.map(path => [JSON.stringify(path), path] as const)).values()];
}

export interface Reached {
  readonly way: Way;
  // The value each position the decision reads holds in one combination that
  // takes the way, keyed by its path as JSON; undefined is a field left out.
  readonly witness: ReadonlyMap<string, unknown>;
}

// When every position a decision's guards and match read is finite (a
// boolean, an enum or a sum's discriminant, an optional one only where the
// field itself may be left out) and their combinations, together with the
// finite positions an invariant on only finite positions connects to them,
// are within the limit: the ways those combinations take, each with one
// combination taking it, of the combinations that keep every such invariant.
// Undefined otherwise.
export function finiteReach(
  decision: RulesDecision<unknown, unknown, unknown>,
  scope: AnySchema,
  combinations: number,
  fixed: readonly (readonly string[])[] = [],
): readonly Reached[] | undefined {
  const read = decisionPaths(decision);
  if (read === undefined) {
    return undefined;
  }
  const positions = [...distinctPaths([...read, ...fixed])];
  const invariants = fieldInvariants(scope, []);
  const has = (path: readonly string[]) => positions.some(other => isDeepStrictEqual(other, path));
  for (let grew = true; grew; ) {
    grew = false;
    for (const { prefix, rule } of invariants) {
      const paths = termPaths(rule).map(path => [...prefix, ...path]);
      if (!paths.some(has) || !paths.every(path => domainWithAbsence(scope, path) !== undefined)) {
        continue;
      }
      for (const path of paths.filter(path => !has(path))) {
        positions.push(path);
        grew = true;
      }
    }
  }
  const domains = positions.map(path => domainWithAbsence(scope, path));
  if (domains.some(domain => domain === undefined)) {
    return undefined;
  }
  if (domains.reduce((product, domain) => product * domain!.length, 1) > combinations) {
    return undefined;
  }
  const keys = new Set(positions.map(path => JSON.stringify(path)));
  const kept = invariants.filter(({ prefix, rule }) =>
    termPaths(rule).every(path => keys.has(JSON.stringify([...prefix, ...path]))),
  );
  const reached = new Map<string, Reached>();
  const chosen: unknown[] = [];
  const visit = (index: number): void => {
    if (index === positions.length) {
      const value = positions.reduce<unknown>(
        (built, path, at) => (chosen[at] === undefined ? built : writeAt(built, path, chosen[at])),
        {},
      );
      if (!kept.every(({ prefix, rule }) => holds(rule, readAt(value, prefix)))) {
        return;
      }
      const way = traceFinite(decision, value);
      const key = JSON.stringify(way.steps.map(step => [describeStep(step), step.outcome]).concat([[String(way.exit)]]));
      if (!reached.has(key)) {
        reached.set(key, { way, witness: new Map(positions.map((path, at) => [JSON.stringify(path), chosen[at]])) });
      }
      return;
    }
    for (const candidate of domains[index]!) {
      chosen[index] = candidate;
      visit(index + 1);
    }
  };
  visit(0);
  return [...reached.values()].sort((left, right) => inWayOrder(left.way, right.way));
}

// The order waysOf lists ways in: depth first, a condition holding before it
// fails, a match's cases as written.
function inWayOrder(left: Way, right: Way): number {
  const rank = (step: Step): number => {
    if (step.distinction.kind === "match") {
      return Object.keys(step.distinction.cases).indexOf(String(step.outcome));
    }
    return step.outcome === true ? 0 : 1;
  };
  for (let index = 0; index < Math.min(left.steps.length, right.steps.length); index++) {
    const difference = rank(left.steps[index]!) - rank(right.steps[index]!);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.steps.length - right.steps.length;
}

function describeStep(step: Step): string {
  return step.distinction.kind === "match" ? `match ${positionOf(step.distinction.on).path.join(".")}` : describeRule(step.distinction);
}

function decisionPaths(decision: RulesDecision<unknown, unknown, unknown>): readonly (readonly string[])[] | undefined {
  const paths: (readonly string[])[] = [];
  const collect = (rule: Rule): boolean => {
    switch (rule.kind) {
      case "compare":
        return [rule.left, rule.right].filter(isTerm).every(side => {
          const data = positionData(side as Term<unknown>);
          if (data === undefined) {
            return false;
          }
          paths.push(data.path);
          return data.measure === "value";
        });
      case "not":
        return collect(rule.rule);
      case "and":
      case "or":
        return rule.rules.every(collect);
      default:
        return false;
    }
  };
  if (!decision.guards.every(candidate => collect(candidate.condition))) {
    return undefined;
  }
  const { otherwise } = decision;
  if (typeof otherwise !== "function") {
    paths.push(positionOf(otherwise.on).path);
  }
  return paths.some(path => path[0] === DEPS) ? undefined : paths;
}

function domainWithAbsence(scope: AnySchema, path: readonly string[]): readonly unknown[] | undefined {
  const parent = rawAt(scope, path.slice(0, -1));
  const last = path[path.length - 1];
  const domain = finiteDomainAt(scope, path);
  if (parent === undefined || last === undefined || domain === undefined) {
    return undefined;
  }
  if (isVariantsSchema(parent)) {
    return parent.discriminant === last ? domain : undefined;
  }
  if (parent.kind !== "object") {
    return undefined;
  }
  const field = (parent as ObjectSchema<ObjectShape>).shape[last];
  return field?.kind === "optional" ? [...domain, undefined] : domain;
}

// The schema at a path without stepping through an optional, which a
// combination could not write a field under.
function rawAt(schema: AnySchema, keys: readonly string[]): AnySchema | undefined {
  const [key, ...rest] = keys;
  if (key === undefined) {
    return schema;
  }
  if (schema.kind !== "object") {
    return undefined;
  }
  const field = (schema as ObjectSchema<ObjectShape>).shape[key];
  return field === undefined ? undefined : rawAt(field, rest);
}

// Every invariant written on the scope, an object or a field it holds, or
// what an optional field holds, with the path of what it is written on.
function fieldInvariants(
  schema: AnySchema,
  prefix: readonly string[],
): readonly { readonly prefix: readonly string[]; readonly rule: Rule }[] {
  const own = schema.invariants.map(rule => ({ prefix, rule }));
  if (schema.kind === "optional") {
    return [...own, ...fieldInvariants((schema as OptionalSchema<unknown>).schema, prefix)];
  }
  if (schema.kind !== "object") {
    return own;
  }
  const { shape } = schema as ObjectSchema<ObjectShape>;
  return [...own, ...Object.entries(shape).flatMap(([key, field]) => fieldInvariants(field, [...prefix, key]))];
}

function traceFinite(decision: RulesDecision<unknown, unknown, unknown>, value: unknown): Way {
  const steps: Step[] = [];
  const distinguish = (distinction: Step["distinction"], outcome: boolean | string) => {
    steps.push({ distinction, outcome });
  };
  for (const [index, candidate] of decision.guards.entries()) {
    if (!holds(candidate.condition, value, undefined, distinguish)) {
      return { steps, exit: index };
    }
  }
  const { otherwise } = decision;
  if (typeof otherwise === "function") {
    return { steps, exit: "otherwise" };
  }
  steps.push({ distinction: otherwise, outcome: String(readOperand(otherwise.on, value)) });
  return { steps, exit: "case" };
}
