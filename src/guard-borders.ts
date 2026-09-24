import type { AnyBehavior, AnyImplementation, ComparisonReached } from "./behavior.js";
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
import type { CompareRule, Rule, Term } from "./rule.js";
import {
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
} from "./rule.js";
import { schemaAtPath } from "./schema.js";
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
          walk(candidate.condition, input.variants[tag] as AnySchema, `@${tag}`, "$", at, asGuard),
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
        walk(onInput, input.variants[tag] as AnySchema, `@${tag}`, "$", at, {
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
          thresholdsIn(candidate.condition, input.variants[tag] as AnySchema, `@${tag}`),
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

function thresholdsIn(rule: Rule, scope: AnySchema, path: string): Threshold[] {
  if (rule.kind === "and" || rule.kind === "or") {
    return rule.rules.flatMap(part => thresholdsIn(part, scope, path));
  }
  if (rule.kind === "not") {
    return thresholdsIn(rule.rule, scope, path);
  }
  if (rule.kind === "all" || rule.kind === "any") {
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
  if (rule.kind !== "compare" || normalized === undefined || normalized.measure !== "value") {
    return [];
  }
  const term = (isTerm(rule.left) ? rule.left : rule.right) as Term<unknown>;
  const keys = termData(term).path;
  const schema = schemaAt(scope, keys);
  return schema === undefined
    ? []
    : [
        {
          path: `${path}${keys.map(key => `.${key}`).join("")}`,
          schema,
          inherited: inheritedAt(scope, keys),
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
    classes.push({ name, witness, contains });
  }
  return { path, classes };
}

function inheritedAt(scope: AnySchema, keys: readonly string[]): readonly Rule[] {
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
  describe(rule: CompareRule, label: string): string;
}

const asGuard: Reading = { source: "guard", describe: (rule, label) => describeRule(rule, label) };

function walk(
  rule: Rule,
  scope: AnySchema,
  path: string,
  label: string,
  at: PositionAt,
  reading: Reading,
): GuardBorder[] {
  if (rule.kind === "and" || rule.kind === "or") {
    return rule.rules.flatMap(part => walk(part, scope, path, label, at, reading));
  }
  if (rule.kind === "not") {
    return walk(rule.rule, scope, path, label, at, reading);
  }
  if (rule.kind === "all" || rule.kind === "any") {
    const of = termData(rule.of).path;
    const collection = schemaAt(scope, of);
    const element =
      collection?.kind === "array" ? (collection as ArraySchema<unknown>).element : undefined;
    const suffix = of.map(key => `.${key}`).join("");
    return element === undefined
      ? []
      : walk(rule.each, element, `${path}${suffix}[]`, `${label}${suffix}[]`, at, reading);
  }
  if (isTerm(rule.left) && isTerm(rule.right)) {
    return between(rule, rule.left, rule.right, scope, path, label, at, reading);
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
    source: reading.source,
    describe: () => reading.describe(rule, label),
    admits: coordinate =>
      measure !== "value" ||
      (schema.parse(coordinate).success &&
        inheritedAt(scope, keys).every(inherited => holds(inherited, coordinate))),
  });
  const positionPath = `${path}${keys.map(key => `.${key}`).join("")}`;
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
  scope: AnySchema,
  path: string,
  label: string,
  at: PositionAt,
  reading: Reading,
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
    describe: () => reading.describe(rule, label),
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
    compose: (given, coordinate) => {
      const moved = at(first.path);
      const other = at(second.path)?.valuesIn(given)[0];
      if (moved === undefined || other === undefined) {
        return undefined;
      }
      if (instants) {
        const shifted = (other as { add(duration: object): unknown }).add({
          nanoseconds: Number(coordinate as bigint),
        });
        return moved.write(given, first.measure, shifted);
      }
      const base = second.measure === "length" ? sizeOf(other) : (other as number);
      return moved.write(given, first.measure, base + (coordinate as number));
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
          unreadIn(candidate.condition, input.variants[tag] as AnySchema, "$").map(
            text => `${decision.id}: ${text}`,
          ),
        ),
  );
}

function unreadIn(rule: Rule, scope: AnySchema, label: string): string[] {
  switch (rule.kind) {
    case "and":
    case "or":
      return rule.rules.flatMap(part => unreadIn(part, scope, label));
    case "not":
      return unreadIn(rule.rule, scope, label);
    case "all":
    case "any": {
      const of = termData(rule.of).path;
      const collection = schemaAt(scope, of);
      return collection?.kind === "array"
        ? unreadIn(
            rule.each,
            (collection as ArraySchema<unknown>).element,
            `${label}${of.map(key => `.${key}`).join("")}[]`,
          )
        : [describeRule(rule, label)];
    }
    case "compare": {
      const terms = [rule.left, rule.right].filter(isTerm) as Term<unknown>[];
      const kinds = terms.map(term => {
        const { path, measure } = termData(term);
        return measure === "length" ? "integer" : schemaAt(scope, path)?.kind;
      });
      const readable =
        terms.length === 2
          ? rule.operator === "==" ||
            rule.operator === "!=" ||
            differenceCarrier(kinds[0], kinds[1]) !== undefined
          : kinds[0] === "boolean" ||
            kinds[0] === "sum" ||
            kinds[0] === "literal" ||
            (kinds[0] !== undefined &&
              carrierOf({ kind: kinds[0] } as AnySchema, "value") !== undefined);
      return readable ? [] : [describeRule(rule, label)];
    }
  }
}

function schemaAt(schema: AnySchema, keys: readonly string[]): AnySchema | undefined {
  return schemaAtPath(schema, keys);
}
