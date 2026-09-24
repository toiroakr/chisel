import type { AnyImplementation, ComparisonReached } from "./behavior.js";
import type { Border } from "./border.js";
import { bordersOf } from "./border.js";
import { carrierOf } from "./partition.js";
import type { CompareRule, Rule } from "./rule.js";
import { describeRule, isTerm, readOperand, sizeOf, termData } from "./rule.js";
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
}

export function guardBordersOf(implementation: AnyImplementation): readonly GuardBorder[] {
  const input = implementation.behavior.input;
  return Object.entries(implementation.cases).flatMap(([tag, decision]) =>
    decision.kind !== "rules"
      ? []
      : decision.guards.flatMap(candidate =>
          walk(candidate.condition, input.variants[tag] as AnySchema, `@${tag}`, "$"),
        ),
  );
}

function walk(rule: Rule, scope: AnySchema, path: string, label: string): GuardBorder[] {
  if (rule.kind === "all") {
    const of = termData(rule.of).path;
    const collection = schemaAt(scope, of);
    const element =
      collection?.kind === "array" ? (collection as ArraySchema<unknown>).element : undefined;
    const suffix = of.map(key => `.${key}`).join("");
    return element === undefined
      ? []
      : walk(rule.each, element, `${path}${suffix}[]`, `${label}${suffix}[]`);
  }
  const term = isTerm(rule.left) && !isTerm(rule.right) ? rule.left : isTerm(rule.right) && !isTerm(rule.left) ? rule.right : undefined;
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
  return borders.map(border => ({
    path: `${path}${keys.map(key => `.${key}`).join("")}`,
    comparison: rule,
    border,
    coordinateOf: reached => {
      const value = readOperand(term, reached.scope);
      return measure === "length" && value !== undefined ? sizeOf(value) : value;
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
