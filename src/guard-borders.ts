import { isDeepStrictEqual } from "node:util";
import type { AnyBehavior, AnyImplementation, ComparisonReached, RulesDecision } from "./behavior.js";
import type { Border } from "./border.js";
import type { Carrier } from "./border.js";
import {
  bordersOf,
  decimalUnitsCarrier,
  integerCarrier,
  nanosecondCarrier,
  normalize,
  numberCarrier,
} from "./border.js";
import type { Decimal } from "decimal.js";
import type { Position } from "./partition.js";
import { carrierOf, positionsOf, writeExactly } from "./partition.js";
import type { CompareRule, ElementLabels, Rule, Term } from "./rule.js";
import {
  DEPS,
  boundTermPath,
  conjuncts,
  describeRule,
  holds,
  isDecimal,
  isTerm,
  readOperand,
  selfTerm,
  shiftTerms,
  stepInto,
  termData,
  termPaths,
  positionData,
  positionOf,
  positionTerm,
  differenceOf,
  withDeps,
  decimalOfUnits,
  decimalUnits,
  counts,
  measured,
} from "./rule.js";
import { enumOf, holdsNoDecimal, int, isVariantsSchema, object, offGridEquality, schemaAtPath } from "./schema.js";
import type {
  AnySchema,
  ArraySchema,
  DecimalSchema,
  ObjectSchema,
  ObjectShape,
  OptionalSchema,
} from "./schema.js";

export interface GuardBorder {
  readonly path: string;
  readonly segments: readonly string[];
  readonly reads?: readonly (readonly string[])[];
  readonly comparison: CompareRule;
  readonly border: Border;
  readonly origin?: {
    readonly decision: RulesDecision<unknown, unknown, unknown>;
    readonly scope: AnySchema;
    readonly tag: string;
  };
  readonly form?: BorderForm;
  coordinateOf(reached: ComparisonReached): unknown;
  // How many ways compose has of writing a point, tried in order as `side`.
  readonly sides?: number;
  compose(given: unknown, coordinate: unknown, deps?: unknown, side?: number): unknown;
}

// The weighed positions of a border over two or more integer or number
// positions, which the lines beside it are drawn from (src/beside.ts).
export interface BorderForm {
  readonly parts: readonly {
    readonly path: string;
    readonly coefficient: number;
    valueOf(scope: unknown): number | undefined;
    write(given: unknown, value: number): unknown;
  }[];
}

export function guardScope(definition: AnyBehavior, tag: string): AnySchema {
  const variant = definition.input.variants[tag] as ObjectSchema<ObjectShape>;
  const values = Object.entries(definition.requires).flatMap(([name, declared]) =>
    declared.takes === "nothing" ? [[name, declared.output as AnySchema] as const] : [],
  );
  if (values.length === 0) {
    return variant;
  }
  const deps = { ...object(Object.fromEntries(values)) } as AnySchema;
  return { ...variant, shape: { ...variant.shape, [DEPS]: deps } } as AnySchema;
}

// The case as feasibility reads it: the invariants written on the input sum
// hold of every case, as the partition passes them down, and read the
// discriminant as the one value it has under this case.
export function feasibilityScope(definition: AnyBehavior, tag: string): AnySchema {
  const scope = guardScope(definition, tag) as ObjectSchema<ObjectShape>;
  const { discriminant } = definition.input;
  return {
    ...scope,
    shape: Object.hasOwn(scope.shape, discriminant)
      ? scope.shape
      : { ...scope.shape, [discriminant]: enumOf([tag]) },
    invariants: [...scope.invariants, ...definition.input.invariants],
  } as AnySchema;
}

export function guardBordersOf(implementation: AnyImplementation): readonly GuardBorder[] {
  const input = implementation.behavior.input;
  const positions = positionsOf(input, { containers: true });
  const at = (segments: readonly string[]): Position | undefined =>
    positions.find(position => isDeepStrictEqual(position.segments, segments));
  return Object.entries(implementation.cases).flatMap(([tag, decision]) =>
    decision.kind !== "rules"
      ? []
      : decision.guards.flatMap(candidate =>
          walk(
            candidate.condition,
            framesAt(guardScope(implementation.behavior, tag), `@${tag}`, "$"),
            at,
            asGuard,
          ).map(
            drawn => ({
              ...drawn,
              origin: { decision, scope: feasibilityScope(implementation.behavior, tag), tag },
            }),
          ),
        ),
  );
}

type PositionAt = (segments: readonly string[]) => Position | undefined;

export function ensuresBordersOf(definition: AnyBehavior): readonly GuardBorder[] {
  const input = definition.input;
  const positions = positionsOf(input);
  const at = (segments: readonly string[]): Position | undefined =>
    positions.find(position => isDeepStrictEqual(position.segments, segments));
  return definition.ensures.flatMap(clause =>
    conjuncts(clause.rule).flatMap(part => {
      const onInput = unrooted(part);
      if (onInput === undefined) {
        return [];
      }
      return input.variantTags.flatMap(tag =>
        walk(onInput, framesAt(input.variants[tag] as AnySchema, `@${tag}`, "$"), at, {
          source: "ensures",
          describe: () => `${clause.name}: ${describeRule(part, "")}`,
        }),
      );
    }),
  );
}

// An invariant comparing one position with a constant draws its border on that
// position (src/border.ts); this one draws those comparing two positions, which
// no single position carries.
export function invariantPairBordersOf(definition: AnyBehavior): readonly GuardBorder[] {
  const positions = positionsOf(definition.input, { containers: true });
  const at = (segments: readonly string[]): Position | undefined =>
    positions.find(position => isDeepStrictEqual(position.segments, segments));
  const reading: Reading = {
    source: "invariant",
    describe: (compared, read) => describeRule(compared, read.root.label, labelsOf(read)),
  };
  const invariants = pairInvariantsOf(definition);
  return definition.input.variantTags.flatMap(tag => {
      const drawn = invariants.filter(invariant => invariant.tag === tag).flatMap(({ frame, rule }) => {
        const frames: Frames = { root: frame, elements: {} };
        if (settledAlone(rule) !== undefined) {
          return [];
        }
        const borders = [rule.left, rule.right].some(
          operand => isTerm(operand) && positionData(operand as Term<unknown>) === undefined,
        )
          ? betweenExpression(rule, frames, at, reading)
          : isTerm(rule.left) && isTerm(rule.right)
            ? between(rule, rule.left as Term<unknown>, rule.right as Term<unknown>, frames, at, reading)
            : [];
        const keys = frame.segments.slice(1).map(segment => segment.slice(1));
        return borders.map(border => ({
          ...border,
          coordinateOf: (reached: ComparisonReached) =>
            border.coordinateOf({
              ...reached,
              scope: keys.reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], reached.scope),
            }),
        }));
      });
      return drawn.map(border => withoutPairRefusedPoints(border, drawn));
    });
}

// An input invariant whose sides cancel, such as $.x < $.x, holds of no value,
// unless a field it reads may be left out: a comparison with it absent holds.
export function invariantContradictionsOf(definition: AnyBehavior): readonly string[] {
  return pairInvariantsOf(definition).flatMap(({ frame, rule }) =>
    settledAlone(rule) === false &&
    !readPathsOf(rule).some(path => mayBeLeftOut(definition, [...frame.segments, ...path.map(key => `.${key}`)]))
      ? [
          `${frame.path}: 不変条件を満たす値がありません (invariant ${rule.name === undefined ? "" : `${rule.name}: `}${describeRule(rule, frame.label)})`,
        ]
      : [],
  );
}

function readPathsOf(rule: CompareRule): readonly (readonly string[])[] {
  return [rule.left, rule.right].flatMap(operand => {
    if (!isTerm(operand)) {
      return [];
    }
    const data = termData(operand as Term<unknown>);
    return data.kind === "position" ? [data.path] : data.parts.map(part => part.path);
  });
}

// Whether a position an object invariant reads, named by segments such as
// ["@case", ".key"], is or lies under a field that may be left out.
export function mayBeLeftOut(definition: AnyBehavior, segments: readonly string[]): boolean {
  const [caseSegment, ...keys] = segments;
  return leavesOut(definition.input.variants[caseSegment!.slice(1)] as AnySchema | undefined, keys);
}

// A sum field leaves a path out when any of its cases does: the path names a
// field its cases share, and a value may be of the case that omits it.
function leavesOut(schema: AnySchema | undefined, keys: readonly string[]): boolean {
  if (schema === undefined) {
    return false;
  }
  if (schema.kind === "optional") {
    return true;
  }
  if (isVariantsSchema(schema)) {
    const [key, ...rest] = keys;
    return key?.startsWith("@") === true
      ? leavesOut(schema.variants[key.slice(1)] as AnySchema | undefined, rest)
      : schema.variantTags.some(tag => leavesOut(schema.variants[tag] as AnySchema, keys));
  }
  const [key, ...rest] = keys;
  if (key === undefined || schema.kind !== "object" || !key.startsWith(".")) {
    return false;
  }
  return leavesOut((schema as ObjectSchema<ObjectShape>).shape[key.slice(1)], rest);
}

function pairInvariantsOf(
  definition: AnyBehavior,
): readonly { readonly tag: string; readonly frame: Frame; readonly rule: CompareRule & { readonly name?: string } }[] {
  const input = definition.input;
  return input.variantTags.flatMap(tag => {
    const scope = input.variants[tag] as AnySchema;
    return objectFramesIn({ scope, path: `@${tag}`, segments: [`@${tag}`], label: "$" }).flatMap(frame =>
      [...(frame.scope === scope ? input.invariants : []), ...frame.scope.invariants]
        .flatMap(conjuncts)
        .flatMap(rule => (rule.kind === "compare" ? [{ tag, frame, rule }] : [])),
    );
  });
}

// Whether a comparison of numbers holds whatever the positions hold, when its
// positions cancel; undefined while one is left to draw a border on.
function comparesTwoPositions(drawn: GuardBorder): boolean {
  return [drawn.comparison.left, drawn.comparison.right].every(
    operand => isTerm(operand) && positionData(operand as Term<unknown>) !== undefined,
  );
}

function settledAlone(rule: CompareRule): boolean | undefined {
  if (![rule.left, rule.right].every(operand => isTerm(operand) || typeof operand === "number" || isDecimal(operand))) {
    return undefined;
  }
  const form = differenceOf(rule);
  if (form.parts.length > 0) {
    return undefined;
  }
  // Compared by its sign, so a decimal constant is read as a number is.
  const sign = typeof form.constant === "number" ? Math.sign(form.constant) : (form.constant as Decimal).comparedTo(0);
  return holds({ kind: "compare", left: sign, operator: rule.operator, right: 0 } as Rule, undefined);
}

// Optionals, arrays, records and sum fields are not descended, as the invariants
// relating finite positions are not (src/feasibility.ts).
function objectFramesIn(frame: Frame): readonly Frame[] {
  if (frame.scope.kind !== "object") {
    return [];
  }
  const shape = (frame.scope as ObjectSchema<ObjectShape>).shape;
  return [
    frame,
    ...Object.entries(shape).flatMap(([key, field]) =>
      objectFramesIn({ scope: field, path: pathOf(frame, [key]), segments: segmentsOf(frame, [key]), label: "$" }),
    ),
  ];
}

// Not left to bordersOf, which excludes a point another bound on the same
// measure refuses: each comparison of two positions is drawn on a difference of
// its own, so the bounds on one difference never meet there.
function withoutPairRefusedPoints(border: GuardBorder, all: readonly GuardBorder[]): GuardBorder {
  const [first, second] = (border.reads ?? []).map(segments => JSON.stringify(segments));
  const others = all.flatMap(other => {
    const [otherFirst, otherSecond] = (other.reads ?? []).map(segments => JSON.stringify(segments));
    if (other === border || first === undefined || !comparesTwoPositions(border) || !comparesTwoPositions(other)) {
      return [];
    }
    return otherFirst === first && otherSecond === second
      ? [{ other, sign: 1 }]
      : otherFirst === second && otherSecond === first
        ? [{ other, sign: -1 }]
        : [];
  });
  const refuses = (witness: unknown): boolean =>
    others.some(({ other, sign }) => {
      const value = sign * (typeof witness === "bigint" ? Number(witness > 0n) - Number(witness < 0n) : (witness as number));
      return !holds({ ...other.comparison, left: value, right: 0 } as Rule, undefined);
    });
  return {
    ...border,
    border: {
      ...border.border,
      points: border.border.points.map(point =>
        point.status === "owed" && point.witness !== undefined && refuses(point.witness)
          ? { ...point, status: "excluded" }
          : point,
      ),
    },
  };
}

function unrooted(rule: Rule): Rule | undefined {
  if (rule.kind !== "compare") {
    return undefined;
  }
  const terms = [rule.left, rule.right].filter(isTerm) as Term<unknown>[];
  if (terms.length === 0 || termPaths(rule).some(path => path[0] !== "input")) {
    return undefined;
  }
  return shiftTerms(rule);
}

export interface GuardClass {
  readonly name: string;
  readonly witness: unknown;
  contains(value: unknown): boolean;
}

export interface GuardPartition {
  readonly path: string;
  readonly segments: readonly string[];
  readonly classes: readonly GuardClass[];
  readonly excluded: readonly string[];
}

interface Threshold {
  readonly path: string;
  readonly label: string;
  readonly described: string;
  readonly segments: readonly string[];
  readonly schema: AnySchema;
  readonly inherited: readonly Rule[];
  readonly rule: CompareRule;
}

export function guardPartitionsOf(implementation: AnyImplementation): readonly GuardPartition[] {
  const input = implementation.behavior.input;
  const thresholds = Object.entries(implementation.cases).flatMap(([tag, decision]) =>
    decision.kind !== "rules"
      ? []
      : decision.guards.flatMap(candidate =>
          thresholdsIn(
            candidate.condition,
            framesAt(guardScope(implementation.behavior, tag), `@${tag}`, "$"),
          ),
        ),
  );
  const trails = [...new Set(thresholds.map(threshold => JSON.stringify(threshold.segments)))];
  return trails.flatMap(trail => {
    const atPath = thresholds.filter(threshold => JSON.stringify(threshold.segments) === trail);
    const partition = partitionAt(
      atPath[0]!.path,
      atPath[0]!.segments,
      atPath[0]!.schema,
      atPath[0]!.inherited,
      atPath.map(threshold => threshold.rule),
    );
    return partition === undefined ? [] : [partition];
  });
}

// Guards are read here rather than through offGridEquality, since a guard's
// terms reach the dependencies and are located through the guard's frames.
export function offGridEqualityIn(
  definition: AnyBehavior,
  tag: string,
  decision: RulesDecision<unknown, unknown, unknown, unknown>,
): string | undefined {
  const frames = framesAt(guardScope(definition, tag), `@${tag}`, "$");
  for (const threshold of decision.guards.flatMap(candidate => thresholdsIn(candidate.condition, frames))) {
    const { operator, bound } = normalize(threshold.rule)!;
    if (holdsNoDecimal(threshold.schema, operator, bound)) {
      const scale = (threshold.schema as DecimalSchema).scale;
      return `compares ${threshold.label} with ${String(bound)}, which no decimal(${scale}) holds: ${threshold.described}`;
    }
  }
  const scope = guardScope(definition, tag);
  return decision.guards
    .map(candidate => offGridEquality(candidate.condition, path => schemaAtPath(scope, path), "$"))
    .find(found => found !== undefined);
}

interface Frame {
  readonly scope: AnySchema;
  readonly path: string;
  readonly segments: readonly string[];
  readonly label: string;
}

interface Frames {
  readonly root: Frame;
  readonly elements: Readonly<Record<string, Frame>>;
}

function framesAt(scope: AnySchema, path: string, label: string): Frames {
  return { root: { scope, path, segments: [path], label }, elements: {} };
}

function locate(
  term: Term<unknown>,
  frames: Frames,
): { readonly frame: Frame; readonly keys: readonly string[] } {
  const keys = positionOf(term).path;
  const element = keys[0] === undefined ? undefined : frames.elements[keys[0]];
  return element === undefined
    ? { frame: frames.root, keys }
    : { frame: element, keys: keys.slice(1) };
}

function enter(rule: Rule & { readonly kind: "all" | "any" }, frames: Frames): Frames | undefined {
  const { frame, keys } = locate(rule.of, frames);
  const collection = schemaAt(frame.scope, keys);
  if (collection?.kind !== "array") {
    return undefined;
  }
  const suffix = keys.map(key => `.${key}`).join("");
  return {
    root: frames.root,
    elements: {
      ...frames.elements,
      [rule.element]: {
        scope: (collection as ArraySchema<unknown>).element,
        path: `${frame.path}${suffix}[]`,
        segments: [...segmentsOf(frame, keys), "[]"],
        label: `${frame.label}${suffix}[]`,
      },
    },
  };
}

function labelsOf(frames: Frames): ElementLabels {
  return Object.fromEntries(
    Object.entries(frames.elements).map(([name, frame]) => [name, frame.label]),
  );
}

function pathOf(frame: Frame, keys: readonly string[]): string {
  return `${frame.path}${keys.map(key => `.${key}`).join("")}`;
}

// The rendered path is for reports; positions are found by segments, since a
// key holding "." renders the same as the nested path it spells.
function segmentsOf(frame: Frame, keys: readonly string[]): readonly string[] {
  return [...frame.segments, ...keys.map(key => `.${key}`)];
}

function thresholdsIn(rule: Rule, frames: Frames): Threshold[] {
  if (rule.kind === "and" || rule.kind === "or") {
    return rule.rules.flatMap(part => thresholdsIn(part, frames));
  }
  if (rule.kind === "not") {
    return thresholdsIn(rule.rule, frames);
  }
  if (rule.kind === "all" || rule.kind === "any") {
    const inner = enter(rule, frames);
    return inner === undefined ? [] : thresholdsIn(rule.each, inner);
  }
  const normalized = normalize(rule);
  if (rule.kind !== "compare" || normalized === undefined || normalized.measure !== "value") {
    return [];
  }
  const term = (isTerm(rule.left) ? rule.left : rule.right) as Term<unknown>;
  const { frame, keys } = locate(term, frames);
  const schema = schemaAt(frame.scope, keys);
  return schema === undefined
    ? []
    : [
        {
          path: pathOf(frame, keys),
          label: `${frame.label}${keys.map(key => `.${key}`).join("")}`,
          described: describeRule(rule, frames.root.label, labelsOf(frames)),
          segments: segmentsOf(frame, keys),
          schema,
          inherited: inheritedAt(frame.scope, keys),
          rule,
        },
      ];
}

interface Edge {
  readonly value: unknown;
  readonly inclusive: boolean;
}

function partitionAt(
  path: string,
  segments: readonly string[],
  schema: AnySchema,
  inherited: readonly Rule[],
  rules: readonly CompareRule[],
): GuardPartition | undefined {
  const carrier = carrierOf(schema, "value");
  if (carrier === undefined) {
    return undefined;
  }
  const cuts = rules.flatMap(rule => {
    const { operator, bound } = normalize(rule)!;
    return operator === "==" || operator === "!="
      ? [
          { value: bound, lowerHoldsIt: false },
          { value: bound, lowerHoldsIt: true },
        ]
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
  const { lower, upper } = admittedRange([...schema.invariants, ...inherited], carrier);
  const edges: (Edge | undefined)[] = [
    lower,
    ...unique.flatMap(cut => [
      { value: cut.value, inclusive: cut.lowerHoldsIt },
      { value: cut.value, inclusive: !cut.lowerHoldsIt },
    ]),
    upper,
  ];
  const classes: GuardClass[] = [];
  const excluded: string[] = [];
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
    const single =
      from !== undefined &&
      to !== undefined &&
      from.inclusive &&
      to.inclusive &&
      carrier.compare(from.value, to.value) === 0;
    const name = single
      ? `v = ${carrier.format(from.value)}`
      : [
          from === undefined ? "" : `${carrier.format(from.value)} ${from.inclusive ? "<=" : "<"} `,
          "v",
          to === undefined ? "" : ` ${to.inclusive ? "<=" : "<"} ${carrier.format(to.value)}`,
        ].join("");
    if (witness === undefined || !contains(witness)) {
      excluded.push(name);
      continue;
    }
    classes.push({ name, witness, contains });
  }
  return { path, segments, classes, excluded };
}

export function inheritedAt(scope: AnySchema, keys: readonly string[]): readonly Rule[] {
  const [key, ...rest] = keys;
  const unwrapped =
    scope.kind === "optional" ? (scope as OptionalSchema<unknown>).schema : scope;
  if (key === undefined || unwrapped.kind !== "object") {
    return [];
  }
  const field = (unwrapped as ObjectSchema<ObjectShape>).shape[key];
  const here = unwrapped.invariants.flatMap(conjuncts).flatMap(rule => {
    const stepped = keys.reduce<Rule | undefined>(
      (current, next) => (current === undefined ? undefined : stepInto(current, next)),
      rule,
    );
    return stepped === undefined ? [] : [stepped];
  });
  return field === undefined ? here : [...here, ...inheritedAt(field, rest)];
}

function admittedRange(
  invariants: readonly Rule[],
  carrier: Carrier,
): { readonly lower: Edge | undefined; readonly upper: Edge | undefined } {
  let lower: Edge | undefined;
  let upper: Edge | undefined;
  for (const rule of invariants.flatMap(conjuncts)) {
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

interface Reading {
  readonly source: "guard" | "ensures" | "invariant";
  describe(rule: CompareRule, frames: Frames): string;
}

const asGuard: Reading = {
  source: "guard",
  describe: (rule, frames) => describeRule(rule, frames.root.label, labelsOf(frames)),
};

function walk(rule: Rule, frames: Frames, at: PositionAt, reading: Reading): GuardBorder[] {
  if (rule.kind === "and" || rule.kind === "or") {
    return rule.rules.flatMap(part => walk(part, frames, at, reading));
  }
  if (rule.kind === "not") {
    return walk(rule.rule, frames, at, reading);
  }
  if (rule.kind === "all" || rule.kind === "any") {
    const inner = enter(rule, frames);
    return inner === undefined ? [] : walk(rule.each, inner, at, reading);
  }
  if ([rule.left, rule.right].some(operand => isTerm(operand) && positionData(operand as Term<unknown>) === undefined)) {
    return betweenExpression(rule, frames, at, reading);
  }
  if (isTerm(rule.left) && isTerm(rule.right)) {
    return between(rule, rule.left, rule.right, frames, at, reading);
  }
  const term = isTerm(rule.left) ? rule.left : isTerm(rule.right) ? rule.right : undefined;
  if (term === undefined) {
    return [];
  }
  const { frame, keys } = locate(term, frames);
  const { measure } = positionOf(term);
  const schema = schemaAt(frame.scope, keys);
  if (schema === undefined) {
    return [];
  }
  const borders = bordersOf([rule], found => carrierOf(schema, found), {
    source: reading.source,
    describe: () => reading.describe(rule, frames),
    admits: coordinate =>
      measure !== "value" ||
      (schema.parse(coordinate).success &&
        inheritedAt(frame.scope, keys).every(inherited => holds(inherited, coordinate))),
  });
  const positionPath = pathOf(frame, keys);
  const positionSegments = segmentsOf(frame, keys);
  return borders.map(border => ({
    path: positionPath,
    segments: positionSegments,
    comparison: rule,
    border,
    coordinateOf: reached => readOperand(term, reached.scope),
    compose: (given, coordinate) => {
      const position = at(positionSegments);
      return position === undefined ? undefined : writeExactly(position, given, measure, coordinate);
    },
  }));
}

function betweenExpression(
  rule: CompareRule & { readonly name?: string },
  frames: Frames,
  at: PositionAt,
  reading: Reading,
): GuardBorder[] {
  const form = differenceOf(rule);
  if (rule.operator === "==" || rule.operator === "!=" || typeof form.constant !== "number") {
    return [];
  }
  const parts = form.parts.map(part => {
    const term = positionTerm(part.path, part.measure);
    const { frame, keys } = locate(term, frames);
    const schema = schemaAt(frame.scope, keys);
    const standsIn = frame === frames.root && keys[0] === DEPS;
    return {
      term,
      coefficient: part.coefficient,
      measure: part.measure,
      standsIn,
      path: standsIn ? ["deps", ...keys.slice(1)].join(".") : pathOf(frame, keys),
      segments: segmentsOf(frame, keys),
      kind: counts(part.measure) ? "integer" : schema?.kind,
    };
  });
  const carrier = parts.every(part => part.kind === "integer")
    ? integerCarrier
    : parts.every(part => part.kind === "integer" || part.kind === "number")
      ? numberCarrier
      : undefined;
  if (carrier === undefined || parts.length === 0) {
    return [];
  }
  const constant = form.constant;
  const difference: Rule = {
    ...(rule.name === undefined ? {} : { name: rule.name }),
    kind: "compare",
    operator: rule.operator,
    left: selfTerm<number>(),
    right: 0,
  };
  const borders = bordersOf([difference], () => carrier, {
    source: reading.source,
    describe: () => reading.describe(rule, frames),
    admits: () => true,
  });
  const valueOf = (part: (typeof parts)[number], scope: unknown): number | undefined => {
    const value = readOperand(part.term, scope);
    return value === undefined ? undefined : (value as number);
  };
  const written = parts
    .map((part, index) => {
      const size = Math.abs(part.coefficient);
      const body = size === 1 ? part.path : `${size} * ${part.path}`;
      return index === 0 ? (part.coefficient < 0 ? `−${body}` : body) : `${part.coefficient < 0 ? "−" : "+"} ${body}`;
    })
    .join(" ");
  const path = constant === 0 ? written : `${written} ${constant < 0 ? "−" : "+"} ${Math.abs(constant)}`;
  // Each part weighed by one can be moved onto any value, and the first the input
  // takes is written: an earlier one may be held to a bound of its own.
  const movable = parts.filter(part => !part.standsIn && Math.abs(part.coefficient) === 1);
  const weighed: BorderForm | undefined =
    parts.length > 1 && parts.every(part => !part.standsIn)
      ? {
          parts: parts.map(part => ({
            path: part.path,
            coefficient: part.coefficient,
            valueOf: scope => valueOf(part, scope),
            write: (given, value) => at(part.segments)?.write(given, part.measure, value),
          })),
        }
      : undefined;
  return borders.map(border => ({
    path,
    segments: (parts.find(part => !part.standsIn) ?? parts[0]!).segments,
    reads: parts.filter(part => !part.standsIn).map(part => part.segments),
    comparison: rule,
    border,
    ...(weighed === undefined ? {} : { form: weighed }),
    coordinateOf: reached => {
      let total = constant;
      for (const part of parts) {
        const value = valueOf(part, reached.scope);
        if (value === undefined) {
          return undefined;
        }
        total += part.coefficient * value;
      }
      return total;
    },
    sides: movable.length,
    compose: (given, coordinate, deps, side) => {
      const moving = movable[side ?? 0];
      const moved = moving === undefined ? undefined : at(moving.segments);
      if (moving === undefined || moved === undefined) {
        return undefined;
      }
      const partValue = (part: (typeof parts)[number], scope: unknown): number | undefined => {
        const value = part.standsIn
          ? (readOperand(part.term, withDeps({}, deps)) as number | undefined)
          : (at(part.segments)?.valuesIn(scope)[0] as number | undefined);
        return value === undefined || part.standsIn || !counts(part.measure) ? value : (measured(value, part.measure) as number);
      };
      let rest = constant;
      for (const part of parts) {
        if (part === moving) {
          continue;
        }
        const value = partValue(part, given);
        if (value === undefined) {
          return undefined;
        }
        rest += part.coefficient * value;
      }
      const written = moved.write(given, moving.measure, ((coordinate as number) - rest) / moving.coefficient);
      // Moving a part that another reads too, as `length(trim($.code))` reads
      // `$.code`, moves both, so the row is kept only where it stands at the point.
      const shared = parts.some(
        part => part !== moving && !part.standsIn && isDeepStrictEqual(part.segments, moving.segments),
      );
      return !shared ||
        parts.reduce<number | undefined>((total, part) => {
          const value = partValue(part, written);
          return total === undefined || value === undefined ? undefined : total + part.coefficient * value;
        }, constant) === coordinate
        ? written
        : undefined;
    },
  }));
}

function between(
  rule: CompareRule & { readonly name?: string },
  left: Term<unknown>,
  right: Term<unknown>,
  frames: Frames,
  at: PositionAt,
  reading: Reading,
): GuardBorder[] {
  const sides = [left, right].map(term => {
    const { frame, keys } = locate(term, frames);
    const { measure } = positionOf(term);
    const schema = schemaAt(frame.scope, keys);
    const standsIn = frame === frames.root && keys[0] === DEPS;
    return {
      term,
      measure,
      standsIn,
      path: standsIn ? ["deps", ...keys.slice(1)].join(".") : pathOf(frame, keys),
      segments: segmentsOf(frame, keys),
      kind: counts(measure) ? "integer" : schema?.kind,
      scale: measure === "value" && schema?.kind === "decimal" ? (schema as DecimalSchema).scale : 0,
    };
  });
  const [first, second] = sides as [(typeof sides)[number], (typeof sides)[number]];
  const carrier = differenceCarrier(first, second);
  if (carrier === undefined || rule.operator === "==" || rule.operator === "!=") {
    return [];
  }
  const moment =
    first.kind === "decimal" || second.kind === "decimal"
      ? decimalMoment(first, second)
      : first.kind === second.kind
        ? MOMENTS[first.kind ?? ""]
        : undefined;
  const difference: Rule = {
    ...(rule.name === undefined ? {} : { name: rule.name }),
    kind: "compare",
    operator: rule.operator,
    left: selfTerm<number>(),
    right: carrier === nanosecondCarrier || first.kind === "decimal" || second.kind === "decimal" ? 0n : 0,
  };
  const borders = bordersOf([difference], () => carrier, {
    source: reading.source,
    describe: () => reading.describe(rule, frames),
    admits: () => true,
  });
  const read = (side: (typeof sides)[number], scopeValue: unknown): number | bigint | undefined => {
    const value = readOperand(side.term, scopeValue);
    if (value === undefined) {
      return undefined;
    }
    return moment === undefined ? (value as number) : moment.read(value, side);
  };
  const form: BorderForm | undefined = sides.every(
    side => !side.standsIn && (side.kind === "integer" || side.kind === "number"),
  )
    ? {
        parts: sides.map((side, index) => ({
          path: side.path,
          coefficient: index === 0 ? 1 : -1,
          valueOf: scope => read(side, scope) as number | undefined,
          write: (given, value) => at(side.segments)?.write(given, side.measure, value),
        })),
      }
    : undefined;
  return borders.map(border => ({
    path: `${first.path} − ${second.path}`,
    segments: (first.standsIn ? second : first).segments,
    reads: sides.filter(side => !side.standsIn).map(side => side.segments),
    comparison: rule,
    border,
    ...(form === undefined ? {} : { form }),
    coordinateOf: reached => {
      const a = read(first, reached.scope);
      const b = read(second, reached.scope);
      return a === undefined || b === undefined ? undefined : (a as number) - (b as number);
    },
    compose: (given, coordinate, deps, side) => {
      const otherSide = side === 1;
      // Move the side that can take every value of the difference: the finer of
      // a decimal and an integer, and never a stand-in, which a row writes as given.
      const preferred = first.standsIn || (!second.standsIn && second.scale > first.scale);
      const swappable = !first.standsIn && !second.standsIn && first.scale === second.scale;
      const moveSecond = otherSide === true && swappable ? !preferred : preferred;
      const [moving, fixed, sign] = moveSecond ? [second, first, -1] : [first, second, 1];
      const moved = moving.standsIn ? undefined : at(moving.segments);
      const other = fixed.standsIn
        ? readOperand(fixed.term, withDeps({}, deps))
        : at(fixed.segments)?.valuesIn(given)[0];
      if (moved === undefined || other === undefined) {
        return undefined;
      }
      if (moment?.write !== undefined) {
        const units = (moment.read(other, fixed) as bigint) + BigInt(sign) * (coordinate as bigint);
        const written = moment.write(units, moving, other);
        return written === undefined ? undefined : moved.write(given, moving.measure, written);
      }
      if (moment !== undefined) {
        const amount = sign * Number(coordinate as number | bigint);
        const shifted = moment.shift(other, amount);
        if (shifted !== undefined) {
          return moved.write(given, moving.measure, shifted);
        }
        // Moving this side would carry it past an end of the day, so the other
        // side is moved against the value this one already holds instead.
        const held = fixed.standsIn ? undefined : at(fixed.segments);
        const current = moved.valuesIn(given)[0];
        const counter = current === undefined ? undefined : moment.shift(current, -amount);
        return held === undefined || counter === undefined
          ? undefined
          : held.write(given, fixed.measure, counter);
      }
      const base =
        counts(fixed.measure) && !fixed.standsIn ? (measured(other, fixed.measure) as number) : (other as number);
      const written = moved.write(given, moving.measure, base + sign * (coordinate as number));
      // Moving one side of `length(trim($.code)) < length($.code)` moves the
      // other too, so the row is kept only where it stands at the point.
      if (fixed.standsIn || !isDeepStrictEqual(fixed.segments, moving.segments)) {
        return written;
      }
      const [a, b] = [first, second].map(side => measured(at(side.segments)?.valuesIn(written)[0], side.measure));
      return typeof a === "number" && typeof b === "number" && a - b === coordinate ? written : undefined;
    },
  }));
}

interface Moment {
  read(value: unknown, side?: Side): number | bigint;
  shift(value: unknown, amount: number): unknown;
  // Writes a coordinate back as the value of a side, where the moment counts in
  // units rather than shifting one value by another.
  write?(units: bigint, side: Side, like: unknown): unknown;
}

// Reads two decimals as whole numbers of units of the finer scale of the two, so
// their difference is exact, and writes one back where the other side's value
// plus the difference lands on its own scale.
function decimalMoment(first: Side, second: Side): Moment {
  const scale = Math.max(first.scale, second.scale);
  return {
    read: value => decimalUnits(value as Decimal, scale, "floor"),
    shift: () => undefined,
    write: (units, side, like) => {
      const coarser = 10n ** BigInt(scale - side.scale);
      return units % coarser === 0n ? decimalOfUnits(like as Decimal, units / coarser, side.scale) : undefined;
    },
  };
}

interface Temporalish {
  add(duration: object): Temporalish;
  until(other: unknown, options: object): { total(unit: string): number };
  readonly epochNanoseconds?: bigint;
  toZonedDateTime?(timeZone: string): { readonly epochNanoseconds: bigint };
  withCalendar?(calendar: string): Temporalish;
  readonly constructor: { compare(left: unknown, right: unknown): number; from(text: string): Temporalish };
}

const MOMENTS: Readonly<Record<string, Moment>> = {
  instant: {
    read: value => (value as Temporalish).epochNanoseconds!,
    shift: (value, amount) => (value as Temporalish).add({ nanoseconds: amount }),
  },
  date: {
    // Counted in the ISO calendar, since until refuses two dates in different
    // calendars and a date in any calendar is one the schema accepts.
    read: value =>
      (value as Temporalish).constructor
        .from("1970-01-01")
        .until((value as Temporalish).withCalendar!("iso8601"), { largestUnit: "days" })
        .total("days"),
    shift: (value, amount) => (value as Temporalish).add({ days: amount }),
  },
  datetime: {
    // Read through UTC as an exact bigint: a total in nanoseconds since 1970 is
    // past what a number holds exactly, and would round a one-nanosecond gap away.
    read: value => (value as Temporalish).toZonedDateTime!("UTC").epochNanoseconds,
    shift: (value, amount) => (value as Temporalish).add({ nanoseconds: amount }),
  },
  time: {
    read: value =>
      BigInt((value as Temporalish).constructor.from("00:00").until(value, { largestUnit: "hours" }).total("nanoseconds")),
    shift: (value, amount) => {
      const shifted = (value as Temporalish).add({ nanoseconds: amount });
      const order = (value as Temporalish).constructor.compare(shifted, value);
      return Math.sign(order) === Math.sign(amount) ? shifted : undefined;
    },
  },
};

interface Side {
  readonly kind: string | undefined;
  // Digits after the decimal point, for a decimal; 0 for anything else.
  readonly scale: number;
}

function differenceCarrier({ kind: first, scale: firstScale }: Side, { kind: second, scale: secondScale }: Side): Carrier | undefined {
  const numeric = (kind: string | undefined) => kind === "integer" || kind === "number";
  if (first === "integer" && second === "integer") {
    return integerCarrier;
  }
  // Two decimals count their difference in units of the finer scale; a decimal
  // is not ordered against any other kind.
  if (first === "decimal" && second === "decimal") {
    return decimalUnitsCarrier(Math.max(firstScale, secondScale));
  }
  if (first === "decimal" || second === "decimal") {
    return undefined;
  }
  if (numeric(first) && numeric(second)) {
    return numberCarrier;
  }
  if (first !== second) {
    return undefined;
  }
  return first === "date" ? integerCarrier : first === "instant" || first === "datetime" || first === "time" ? nanosecondCarrier : undefined;
}

export function comparisonsNotReadOf(implementation: AnyImplementation): readonly string[] {
  const input = implementation.behavior.input;
  return Object.entries(implementation.cases).flatMap(([tag, decision]) =>
    decision.kind !== "rules"
      ? []
      : decision.guards.flatMap(candidate =>
          unreadIn(candidate.condition, framesAt(guardScope(implementation.behavior, tag), `@${tag}`, "$")).map(
            text => `${decision.id}: ${text}`,
          ),
        ),
  );
}

function unreadIn(rule: Rule, frames: Frames): string[] {
  switch (rule.kind) {
    case "and":
    case "or":
      return rule.rules.flatMap(part => unreadIn(part, frames));
    case "not":
      return unreadIn(rule.rule, frames);
    case "all":
    case "any": {
      const inner = enter(rule, frames);
      return inner === undefined
        ? [describeRule(rule, frames.root.label, labelsOf(frames))]
        : unreadIn(rule.each, inner);
    }
    case "compare": {
      const terms = [rule.left, rule.right].filter(isTerm) as Term<unknown>[];
      if (terms.some(term => positionData(term) === undefined)) {
        const kinds = differenceOf(rule).parts.map(part => {
          const { frame, keys } = locate(positionTerm(part.path, part.measure), frames);
          return counts(part.measure) ? "integer" : schemaAt(frame.scope, keys)?.kind;
        });
        return kinds.every(kind => kind === "integer" || kind === "number")
          ? []
          : [describeRule(rule, frames.root.label, labelsOf(frames))];
      }
      const schemas = terms.map(term => {
        const { frame, keys } = locate(term, frames);
        const schema = schemaAt(frame.scope, keys);
        // The length of an enum is not read: see carrierOf.
        return counts(positionOf(term).measure) ? (schema?.kind === "enum" ? undefined : int()) : schema;
      });
      const sides = schemas.map(
        (schema): Side => ({
          kind: schema?.kind,
          scale: schema?.kind === "decimal" ? (schema as DecimalSchema).scale : 0,
        }),
      );
      const kind = schemas[0]?.kind;
      const readable =
        terms.length === 2
          ? rule.operator === "==" ||
            rule.operator === "!=" ||
            differenceCarrier(sides[0]!, sides[1]!) !== undefined
          : kind === "boolean" ||
            // An enum's values are ordered by their text, not as they were named,
            // so only an equality with one of them is read.
            (kind === "enum" && (rule.operator === "==" || rule.operator === "!=")) ||
            kind === "variants" ||
            kind === "literal" ||
            (schemas[0] !== undefined && carrierOf(schemas[0], "value") !== undefined);
      return readable ? [] : [describeRule(rule, frames.root.label, labelsOf(frames))];
    }
  }
}

function schemaAt(schema: AnySchema, keys: readonly string[]): AnySchema | undefined {
  return schemaAtPath(schema, keys);
}
