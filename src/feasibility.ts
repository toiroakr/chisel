import { onTimeline, temporalKindOf } from "./temporal.js";
import { deepEqual } from "./equal.js";
import type { Carrier } from "./border.js";
import { integerCarrier, normalize, numberCarrier } from "./border.js";
import { inheritedAt } from "./guard-borders.js";
import { carrierOf } from "./partition.js";
import type { CompareRule, LinearTermData, Measure, Operator, Rule, Term } from "./rule.js";
import { DEPS, boundTermPath, conjuncts, describeRule, differenceOf, holds, isTerm, positionData, positionOf, readOperand, termData, termPaths, counts, partsOfMeasure, positionTerm } from "./rule.js";
import type { AnySchema, AnyVariantsSchema, EnumSchema, ObjectSchema, ObjectShape, OptionalSchema } from "./schema.js";
import { isVariantsSchema, schemaAtPath } from "./schema.js";
import type { RulesDecision } from "./behavior.js";
import type { Step, Way } from "./ways.js";

export type Feasibility =
  | { readonly kind: "feasible" }
  | { readonly kind: "infeasible"; readonly reason: string }
  | { readonly kind: "undecided"; readonly reason: string };


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
  const outcomes = new Map<string, { identity: unknown; outcome: boolean | string }[]>();
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
    onlyKnown = false,
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
    if (onlyKnown && !forms.has(key)) {
      return;
    }
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
  const constrainForm = (form: LinearTermData, operator: Operator, bound: number, onlyKnown = false): void =>
    constrain(
      form.parts.map(part => ({ key: groupFor(part.path, part.measure), coefficient: part.coefficient })),
      operator,
      bound - (form.constant as number),
      onlyKnown,
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
    const identity = stepIdentity(step);
    const key = step.distinction.kind === "match" ? JSON.stringify(["match", positionData(step.distinction.on)?.path]) : describeRule(step.distinction);
    const bucket = outcomes.get(key) ?? [];
    const seen = bucket.find(previous => deepEqual(previous.identity, identity));
    if (seen !== undefined) {
      if (seen.outcome !== step.outcome) {
        return { kind: "infeasible", reason: contradicts };
      }
      continue;
    }
    bucket.push({ identity, outcome: step.outcome });
    outcomes.set(key, bucket);
    const placed = placedConstraintOf(step, scope);
    if (placed !== undefined) {
      groups.get(groupFor(placed.path, placed.measure))!.constraints.push(...placed.constraints);
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

  // An input invariant ordering numbers holds on every way, so it bounds a form
  // the way constrains. Not added to a form of its own: one more form sharing
  // the way's positions would leave forms that are settled now undecided.
  for (const { prefix, rule } of scopedInvariants(scope, [])) {
    const form = numericFormOf(rule, scope, prefix);
    if (form !== undefined && form.parts.every(part => groups.has(JSON.stringify([part.path, part.measure])))) {
      constrainForm(form, (rule as CompareRule).operator, 0, true);
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
    const alone = form.parts.every(
      part => related.filter(other => other === part.key).length === 1 && intervals.get(part.key) !== undefined,
    );
    // A pair shared with another form is still settled on its intervals below,
    // as a relation, so only one it alone constrains is read on its range here.
    if (isPair(form)) {
      if (alone && ordered([...form.constraints, ...rangeOf(form, intervals, carrier)], carrier) === false) {
        return { kind: "infeasible", reason: contradicts };
      }
      continue;
    }
    const free = form.parts.every(
      part => intervals.get(part.key)?.lower === undefined && intervals.get(part.key)?.upper === undefined,
    );
    if (alone && free) {
      unsettled ||= carrier === integerCarrier && !form.parts.some(part => Math.abs(part.coefficient) === 1);
      continue;
    }
    // Integers weighed by more than one leave gaps in the values their sum takes,
    // so only a sum of whole steps is read as the one interval it fills.
    const range =
      alone && (carrier !== integerCarrier || form.parts.every(part => Math.abs(part.coefficient) === 1))
        ? rangeOf(form, intervals, carrier)
        : undefined;
    if (range === undefined) {
      unsettled = true;
      continue;
    }
    if (ordered([...form.constraints, ...range], carrier) === false) {
      return { kind: "infeasible", reason: contradicts };
    }
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

// The constraints a step puts on one coordinate: a match, or a comparison with a constant.
function placedConstraintOf(
  step: Step,
  scope: AnySchema,
): { readonly path: readonly string[]; readonly measure: Measure; readonly constraints: readonly Constraint[] } | undefined {
  const { distinction, outcome } = step;
  if (distinction.kind === "match") {
    return { path: positionOf(distinction.on).path, measure: "value", constraints: [{ operator: "==", bound: outcome }] };
  }
  if (distinction.kind !== "compare") {
    return undefined;
  }
  const normalized = normalize(distinction);
  if (normalized === undefined) {
    return undefined;
  }
  const path = positionOf((isTerm(distinction.left) ? distinction.left : distinction.right) as Term<unknown>).path;
  const constraint: Constraint = {
    operator: outcome === true ? normalized.operator : negated[normalized.operator],
    bound: normalized.bound,
  };
  // A transformed read of a finite position, `lowercase($.level)` of an enum,
  // is read off each of its values: the step refuses the values whose reading
  // the constraint does not keep, so it is settled with the value's own steps.
  const { transforms, reading } = partsOfMeasure(normalized.measure);
  const domain = transforms.length > 0 && reading === "value" ? finiteDomainAt(scope, path) : undefined;
  if (domain !== undefined) {
    const kept: Rule = { kind: "compare", left: positionTerm([], normalized.measure), operator: constraint.operator, right: constraint.bound };
    return {
      path,
      measure: "value",
      constraints: domain.filter(value => !holds(kept, value)).map(value => ({ operator: "!=", bound: value })),
    };
  }
  return { path, measure: normalized.measure, constraints: [constraint] };
}

function stepIdentity(step: Step): unknown {
  return step.distinction.kind === "match"
    ? ["match", termData(step.distinction.on)]
    : ruleIdentity(step.distinction);
}
function ruleIdentity(rule: Rule): unknown {
  const operand = (value: unknown): unknown => isTerm(value) ? ["term", termData(value)] : ["constant", value];
  switch (rule.kind) {
    case "compare": return [rule.kind, rule.operator, operand(rule.left), operand(rule.right)];
    case "all":
    case "any": return [rule.kind, operand(rule.of), rule.element, ruleIdentity(rule.each)];
    case "not": return [rule.kind, ruleIdentity(rule.rule)];
    case "and":
    case "or": return [rule.kind, rule.rules.map(ruleIdentity)];
  }
}

// The values a form takes as each of its parts ranges over its own interval,
// as the constraints that bound it.
function rangeOf(
  form: Form,
  intervals: ReadonlyMap<string, Interval | undefined>,
  carrier: Carrier,
): readonly Constraint[] {
  const whole = (edge: Edge | undefined, direction: 1 | -1): Edge | undefined =>
    edge === undefined || edge.inclusive || carrier !== integerCarrier
      ? edge
      : { value: (edge.value as number) + direction, inclusive: true };
  const end = (side: "lower" | "upper"): Edge | undefined =>
    form.parts.reduce<Edge | undefined>(
      (total, { key, coefficient }) => {
        const interval = intervals.get(key)!;
        const taken = (coefficient > 0) === (side === "lower") ? "lower" : "upper";
        const edge = whole(interval[taken], taken === "lower" ? 1 : -1);
        return total === undefined || edge === undefined
          ? undefined
          : {
              value: (total.value as number) + coefficient * (edge.value as number),
              inclusive: total.inclusive && edge.inclusive,
            };
      },
      { value: 0, inclusive: true },
    );
  const lower = end("lower");
  const upper = end("upper");
  return [
    ...(lower === undefined ? [] : [{ operator: lower.inclusive ? ">=" : ">", bound: lower.value } as Constraint]),
    ...(upper === undefined ? [] : [{ operator: upper.inclusive ? "<=" : "<", bound: upper.value } as Constraint]),
  ];
}

function isPair(form: Form): boolean {
  return form.parts.length === 2 && form.parts[0]!.coefficient === 1 && form.parts[1]!.coefficient === -1;
}

// An invariant comparing two or more integer or number positions that are never
// left out, read as one form over paths from the scope's root.
function numericFormOf(rule: Rule, scope: AnySchema, prefix: readonly string[]): LinearTermData | undefined {
  if (
    rule.kind !== "compare" ||
    rule.operator === "==" ||
    rule.operator === "!=" ||
    ![rule.left, rule.right].every(operand => isTerm(operand) || typeof operand === "number")
  ) {
    return undefined;
  }
  const form = differenceOf(rule);
  const parts = form.parts.map(part => ({ ...part, path: [...prefix, ...part.path] }));
  const kept = parts.every(
    part =>
      part.measure === "value" &&
      !leftOutAlong(scope, part.path) &&
      ["integer", "number"].includes(schemaAtPath(scope, part.path)?.kind ?? ""),
  );
  return parts.length >= 2 && kept && typeof form.constant === "number" ? { ...form, parts } : undefined;
}

function leftOutAlong(scope: AnySchema, path: readonly string[]): boolean {
  return path.some((_, index) => {
    const parent = schemaAtPath(scope, path.slice(0, index));
    const field = parent?.kind === "object" ? (parent as ObjectSchema<ObjectShape>).shape[path[index]!] : undefined;
    return field?.kind === "optional";
  });
}

// An expression of integer or number positions, read as the left side less the
// right; a decimal or another kind of part leaves the comparison unread.
function readableFormOf(rule: CompareRule, scope: AnySchema): LinearTermData | undefined {
  if (![rule.left, rule.right].some(operand => isTerm(operand) && positionData(operand as Term<unknown>) === undefined)) {
    return undefined;
  }
  const form = differenceOf(rule);
  const kinds = form.parts.map(part =>
    counts(part.measure) ? "integer" : schemaAtPath(scope, part.path)?.kind,
  );
  // A part that may be left out is not one: the comparison holds without it.
  return typeof form.constant === "number" &&
    kinds.every(kind => kind === "integer" || kind === "number") &&
    !form.parts.some(part => leftOutAlong(scope, part.path))
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
    counts(side.measure) ? "integer" : schemaAtPath(scope, side.path)?.kind,
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
  const constraints = [...group.constraints, ...invariants];
  if (measure === "value" && onTimeline(schema.kind) && constraints.some(item => temporalKindOf(item.bound) !== schema.kind)) return undefined;
  return ordered(constraints, carrier);
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

// Strings lying between two bounds, nearest the lower first: the lower bound with
// the lowest code point after it ("a" to "a!" holds "a\u0000"), and the bounds'
// common prefix followed by each code point between theirs where they part ("Z"
// to "a" holds "[" and "_"), so a range holding a transformed value is found.
const BETWEEN_LIMIT = 256;
function stringsBetween(lower: unknown, upper: unknown): string[] {
  if (typeof lower !== "string" || typeof upper !== "string") {
    return [];
  }
  const low = [...lower.normalize("NFC")];
  const high = [...upper.normalize("NFC")];
  let common = 0;
  while (common < Math.min(low.length, high.length) && low[common] === high[common]) {
    common += 1;
  }
  const prefix = low.slice(0, common).join("");
  const from = common < low.length ? low[common]!.codePointAt(0)! + 1 : 0;
  const to = common < high.length ? high[common]!.codePointAt(0)! : 0;
  const parted: string[] = [];
  for (let point = from; point < Math.min(to, from + BETWEEN_LIMIT); point += 1) {
    if (point < 0xd800 || point > 0xdfff) {
      parted.push(prefix + String.fromCodePoint(point));
    }
  }
  return [`${lower}\u0000`, ...parted];
}

function ordered(constraints: readonly Constraint[], carrier: Carrier): Interval | false | undefined {
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
  // A value nothing reads as is never held: lowercase($) == "ABC" never holds.
  const within = (value: unknown) =>
    carrier.produces?.(value) !== false &&
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
    if (!(order < 0 || (order === 0 && within(lower.value)))) {
      return false;
    }
    if (carrier.produces === undefined) {
      return interval;
    }
    // A transformed string reads only as what its transforms give back, and a
    // range may hold none of them (no lowercased string lies from "A" to "Z"):
    // it is settled only where a value is found in it.
    const found = [
      lower.inclusive ? lower.value : undefined,
      carrier.past?.(lower.value, 1),
      upper.inclusive ? upper.value : undefined,
      carrier.past?.(upper.value, -1),
      ...stringsBetween(lower.value, upper.value),
    ].some(value => value !== undefined && within(value));
    return found ? interval : undefined;
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
    const placed = placedConstraintOf(step, scope);
    if (
      placed === undefined ||
      placed.measure !== "value" ||
      placed.constraints.some(constraint => constraint.operator !== "==" && constraint.operator !== "!=") ||
      finiteDomainAt(scope, placed.path) === undefined
    ) {
      return undefined;
    }
    for (const constraint of placed.constraints) {
      constrain(placed.path, constraint);
    }
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
      .filter(rule => deepEqual(boundTermPath(rule), [discriminant]));
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

// A rule over finite positions: each comparison reads one of them, or what
// its transforms make of it, against a constant with == or !=, combined with and/or/not. Its positions, or
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
          sides.every(side => !counts(side!.measure)) &&
          paths.every(path => finiteDomainAt(scope, path) !== undefined)
          ? paths
          : undefined;
      }
      const normalized = normalize(rule);
      // A transformed value, `lowercase($.level)`, is read off each value the
      // combinations try, as the invariant is held with `holds`.
      if (normalized === undefined || counts(normalized.measure)) {
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
      constraints: deepEqual(readAt(before, path), readAt(after, path))
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

// The value `after` becomes when each invariant ordering two or more integer or
// number positions that it breaks is kept by moving one of its positions weighed
// by one, and one `after` did not move away from `before`, to the nearest value
// that keeps it; undefined when an invariant is left broken.
export function keepingOrderings(scope: AnySchema, before: unknown, after: unknown): unknown {
  const orderings = scopedInvariants(scope, []).flatMap(({ prefix, rule }) => {
    if (rule.kind !== "compare" || ![rule.left, rule.right].every(operand => isTerm(operand) || typeof operand === "number")) {
      return [];
    }
    const form = differenceOf(rule as CompareRule);
    const parts = form.parts.map(part => ({ ...part, path: [...prefix, ...part.path] }));
    const numeric = parts.every(
      part => part.measure === "value" && ["integer", "number"].includes(schemaAtPath(scope, part.path)?.kind ?? ""),
    );
    return parts.length >= 2 && numeric && typeof form.constant === "number"
      ? [{ rule: rule as CompareRule, parts, constant: form.constant }]
      : [];
  });
  let kept = after;
  // A part moved once stays: moving it again to keep a later ordering would
  // break the one it was moved for, so a chain is kept by moving its next part.
  const moved = new Set<string>();
  for (let round = 0; round <= orderings.length; round++) {
    const broken = orderings.find(({ rule, parts, constant }) => {
      const values = parts.map(part => readAt(kept, part.path));
      return (
        values.every(value => typeof value === "number") &&
        !holds({ ...rule, left: parts.reduce((total, part, index) => total + part.coefficient * (values[index] as number), constant), right: 0 } as Rule, undefined)
      );
    });
    if (broken === undefined) {
      return kept;
    }
    const moving = broken.parts.find(
      part =>
        Math.abs(part.coefficient) === 1 &&
        !moved.has(JSON.stringify(part.path)) &&
        deepEqual(readAt(before, part.path), readAt(after, part.path)),
    );
    if (moving === undefined) {
      return undefined;
    }
    const rest = broken.parts.reduce(
      (total, part) => (part === moving ? total : total + part.coefficient * (readAt(kept, part.path) as number)),
      broken.constant,
    );
    // coefficient * x + rest <operator> 0, read as a bound on x itself.
    const operator = moving.coefficient === 1 ? broken.rule.operator : mirrored[broken.rule.operator];
    const bound = -rest * moving.coefficient;
    const current = readAt(kept, moving.path) as number;
    const nearest =
      operator === "!=" ? current + 1 : nearestKeeping(scope, moving.path, operator, bound);
    if (nearest === undefined) {
      return undefined;
    }
    kept = writeAt(kept, moving.path, nearest);
    moved.add(JSON.stringify(moving.path));
  }
  return undefined;
}

// The value nearest `bound` on the side `operator` keeps that the position's
// own bounds admit: an integer steps by one, and a number, which has no step,
// takes the middle of what is left when less than one is.
function nearestKeeping(
  scope: AnySchema,
  path: readonly string[],
  operator: Operator,
  bound: number,
): number | undefined {
  const settled = settle({ path, measure: "value", constraints: [{ operator, bound }] }, scope);
  if (typeof settled !== "object") {
    return settled === false ? undefined : bound;
  }
  const lower = settled.lower?.value as number | undefined;
  const upper = settled.upper?.value as number | undefined;
  if (operator === ">" || operator === ">=") {
    const from = lower ?? bound;
    if (settled.carrier === integerCarrier || settled.lower?.inclusive !== false) {
      return settled.lower?.inclusive === false ? from + 1 : from;
    }
    return upper !== undefined && upper - from <= 1 ? (from + upper) / 2 : from + 1;
  }
  if (operator === "<" || operator === "<=") {
    const from = upper ?? bound;
    if (settled.carrier === integerCarrier || settled.upper?.inclusive !== false) {
      return settled.upper?.inclusive === false ? from - 1 : from;
    }
    return lower !== undefined && from - lower <= 1 ? (from + lower) / 2 : from - 1;
  }
  return bound;
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
  const has = (path: readonly string[]) => positions.some(other => deepEqual(other, path));
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
          // A transformed value is read off each value of the domain as the guard
          // reads it (`lowercase($.level)` of each case of an enum); a string
          // has no domain, so its transformed read stays out of the plan.
          return !counts(data.measure);
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
