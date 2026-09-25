import type { AnyBehavior, AnyImplementation, ComparisonReached, RulesDecision } from "./behavior.js";
import type { Border } from "./border.js";
import type { Carrier } from "./border.js";
import {
  bordersOf,
  integerCarrier,
  nanosecondCarrier,
  normalize,
  numberCarrier,
} from "./border.js";
import type { Position } from "./partition.js";
import { carrierOf, positionsOf } from "./partition.js";
import type { CompareRule, ElementLabels, Rule, Term } from "./rule.js";
import {
  DEPS,
  boundTermPath,
  conjuncts,
  describeRule,
  holds,
  isTerm,
  readOperand,
  selfTerm,
  shiftTerms,
  sizeOf,
  stepInto,
  termData,
  withDeps,
} from "./rule.js";
import { object, schemaAtPath } from "./schema.js";
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
  readonly origin?: {
    readonly decision: RulesDecision<unknown, unknown, unknown>;
    readonly scope: AnySchema;
  };
  coordinateOf(reached: ComparisonReached): unknown;
  compose(given: unknown, coordinate: unknown, deps?: unknown): unknown;
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

export function guardBordersOf(implementation: AnyImplementation): readonly GuardBorder[] {
  const input = implementation.behavior.input;
  const positions = positionsOf(input, { containers: true });
  const at = (path: string): Position | undefined =>
    positions.find(position => position.path === path);
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
              origin: { decision, scope: guardScope(implementation.behavior, tag) },
            }),
          ),
        ),
  );
}

type PositionAt = (path: string) => Position | undefined;

export function ensuresBordersOf(definition: AnyBehavior): readonly GuardBorder[] {
  const input = definition.input;
  const positions = positionsOf(input);
  const at = (path: string): Position | undefined =>
    positions.find(position => position.path === path);
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

function unrooted(rule: Rule): Rule | undefined {
  if (rule.kind !== "compare") {
    return undefined;
  }
  const terms = [rule.left, rule.right].filter(isTerm) as Term<unknown>[];
  if (terms.length === 0 || terms.some(term => termData(term).path[0] !== "input")) {
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
  readonly classes: readonly GuardClass[];
  readonly excluded: readonly string[];
}

interface Threshold {
  readonly path: string;
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
  const paths = [...new Set(thresholds.map(threshold => threshold.path))];
  return paths.flatMap(path => {
    const atPath = thresholds.filter(threshold => threshold.path === path);
    const partition = partitionAt(
      path,
      atPath[0]!.schema,
      atPath[0]!.inherited,
      atPath.map(threshold => threshold.rule),
    );
    return partition === undefined ? [] : [partition];
  });
}

interface Frame {
  readonly scope: AnySchema;
  readonly path: string;
  readonly label: string;
}

interface Frames {
  readonly root: Frame;
  readonly elements: Readonly<Record<string, Frame>>;
}

function framesAt(scope: AnySchema, path: string, label: string): Frames {
  return { root: { scope, path, label }, elements: {} };
}

function locate(
  term: Term<unknown>,
  frames: Frames,
): { readonly frame: Frame; readonly keys: readonly string[] } {
  const keys = termData(term).path;
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
  return { path, classes, excluded };
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
  readonly source: "guard" | "ensures";
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
  if (isTerm(rule.left) && isTerm(rule.right)) {
    return between(rule, rule.left, rule.right, frames, at, reading);
  }
  const term = isTerm(rule.left) ? rule.left : isTerm(rule.right) ? rule.right : undefined;
  if (term === undefined) {
    return [];
  }
  const { frame, keys } = locate(term, frames);
  const { measure } = termData(term);
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
  return borders.map(border => ({
    path: positionPath,
    comparison: rule,
    border,
    coordinateOf: reached => readOperand(term, reached.scope),
    compose: (given, coordinate) => at(positionPath)?.write(given, measure, coordinate),
  }));
}

function between(
  rule: CompareRule,
  left: Term<unknown>,
  right: Term<unknown>,
  frames: Frames,
  at: PositionAt,
  reading: Reading,
): GuardBorder[] {
  const sides = [left, right].map(term => {
    const { frame, keys } = locate(term, frames);
    const { measure } = termData(term);
    const schema = schemaAt(frame.scope, keys);
    const standsIn = frame === frames.root && keys[0] === DEPS;
    return {
      term,
      measure,
      standsIn,
      path: standsIn ? ["deps", ...keys.slice(1)].join(".") : pathOf(frame, keys),
      kind: measure === "length" ? "integer" : schema?.kind,
    };
  });
  const [first, second] = sides as [(typeof sides)[number], (typeof sides)[number]];
  const carrier = differenceCarrier(first.kind, second.kind);
  if (carrier === undefined || rule.operator === "==" || rule.operator === "!=") {
    return [];
  }
  const instants = carrier === nanosecondCarrier;
  const difference: CompareRule = {
    kind: "compare",
    operator: rule.operator,
    left: selfTerm<number>(),
    right: instants ? 0n : 0,
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
    if (instants) {
      return (value as { readonly epochNanoseconds: bigint }).epochNanoseconds;
    }
    return value as number;
  };
  return borders.map(border => ({
    path: `${first.path} − ${second.path}`,
    comparison: rule,
    border,
    coordinateOf: reached => {
      const a = read(first, reached.scope);
      const b = read(second, reached.scope);
      return a === undefined || b === undefined ? undefined : (a as number) - (b as number);
    },
    compose: (given, coordinate, deps) => {
      const [moving, fixed, sign] = first.standsIn ? [second, first, -1] : [first, second, 1];
      const moved = moving.standsIn ? undefined : at(moving.path);
      const other = fixed.standsIn
        ? readOperand(fixed.term, withDeps({}, deps))
        : at(fixed.path)?.valuesIn(given)[0];
      if (moved === undefined || other === undefined) {
        return undefined;
      }
      if (instants) {
        const shifted = (other as { add(duration: object): unknown }).add({
          nanoseconds: sign * Number(coordinate as bigint),
        });
        return moved.write(given, moving.measure, shifted);
      }
      const base =
        fixed.measure === "length" && !fixed.standsIn ? sizeOf(other) : (other as number);
      return moved.write(given, moving.measure, base + sign * (coordinate as number));
    },
  }));
}

function differenceCarrier(
  first: string | undefined,
  second: string | undefined,
): Carrier | undefined {
  const numeric = (kind: string | undefined) => kind === "integer" || kind === "number";
  if (first === "integer" && second === "integer") {
    return integerCarrier;
  }
  if (numeric(first) && numeric(second)) {
    return numberCarrier;
  }
  return first === "instant" && second === "instant" ? nanosecondCarrier : undefined;
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
      const kinds = terms.map(term => {
        const { frame, keys } = locate(term, frames);
        return termData(term).measure === "length" ? "integer" : schemaAt(frame.scope, keys)?.kind;
      });
      const readable =
        terms.length === 2
          ? rule.operator === "==" ||
            rule.operator === "!=" ||
            differenceCarrier(kinds[0], kinds[1]) !== undefined
          : kinds[0] === "boolean" ||
            kinds[0] === "variants" ||
            kinds[0] === "literal" ||
            (kinds[0] !== undefined &&
              carrierOf({ kind: kinds[0] } as AnySchema, "value") !== undefined);
      return readable ? [] : [describeRule(rule, frames.root.label, labelsOf(frames))];
    }
  }
}

function schemaAt(schema: AnySchema, keys: readonly string[]): AnySchema | undefined {
  return schemaAtPath(schema, keys);
}
