import type {
  AnySchema,
  AnySumSchema,
  ArraySchema,
  ObjectSchema,
  ObjectShape,
  OptionalSchema,
} from "./schema.js";
import type { Border, Carrier } from "./border.js";
import {
  bordersOf,
  instantCarrier,
  integerCarrier,
  numberCarrier,
  stringCarrier,
} from "./border.js";
import type { Rule } from "./rule.js";
import { boundTermPath, stepInto } from "./rule.js";
import { isSumSchema, tagOf } from "./schema.js";

export type Position = DividedPosition | UndividedPosition;

export interface DividedPosition {
  readonly kind: "divided";
  readonly path: string;
  readonly classes: readonly string[];
  readonly borders: readonly Border[];
  valuesIn(given: unknown): readonly unknown[];
  classify(given: unknown): readonly string[];
  place(given: unknown, className: string): unknown;
}

export interface UndividedPosition {
  readonly kind: "not-derivable" | "bounded";
  readonly path: string;
  readonly borders: readonly Border[];
  valuesIn(given: unknown): readonly unknown[];
}

interface Focus {
  reach(given: unknown): readonly unknown[];
  update(given: unknown, change: (value: unknown) => unknown): unknown;
}

export function positionsOf(input: AnySumSchema): readonly Position[] {
  return underCases(input, "", {
    reach: given => [given],
    update: (given, change) => change(given),
  });
}

function underCases(schema: AnySumSchema, path: string, focus: Focus): Position[] {
  return schema.variantTags.flatMap(tag =>
    fieldsOf(schema.variants[tag] as ObjectSchema<ObjectShape>, `${path}@${tag}`, {
      reach: given => focus.reach(given).filter(value => tagOf(schema, value) === tag),
      update: (given, change) =>
        focus.update(given, value =>
          change(tagOf(schema, value) === tag ? value : schema.placeholderFor(tag)),
        ),
    }),
  );
}

function fieldsOf(
  schema: ObjectSchema<ObjectShape>,
  path: string,
  focus: Focus,
  inherited: readonly Rule[] = [],
): Position[] {
  const rules = [...schema.invariants, ...inherited];
  return Object.entries(schema.shape).flatMap(([key, field]) =>
    positionAt(
      field,
      `${path}.${key}`,
      {
        reach: given =>
          focus.reach(given).map(value => (value as Readonly<Record<string, unknown>>)[key]),
        update: (given, change) =>
          focus.update(given, value => {
            const { [key]: current, ...rest } = value as Readonly<Record<string, unknown>>;
            const next = change(current);
            return next === undefined ? rest : { ...rest, [key]: next };
          }),
      },
      rules.flatMap(rule => {
        const inner = stepInto(rule, key);
        return inner === undefined ? [] : [inner];
      }),
    ),
  );
}

function positionAt(
  schema: AnySchema,
  path: string,
  focus: Focus,
  inherited: readonly Rule[] = [],
): Position[] {
  const borders = bordersOf(
    [...schema.invariants, ...inherited].filter(rule => boundTermPath(rule)?.length === 0),
    measure => carrierOf(schema, measure),
  );
  if (schema.kind === "optional") {
    const inner = (schema as OptionalSchema<unknown>).schema;
    return [
      divided(
        path,
        ["なし", "あり"],
        focus,
        value => (value === undefined ? "なし" : "あり"),
        className => (className === "なし" ? undefined : inner.placeholder()),
      ),
      ...positionAt(inner, `${path}?`, {
        reach: given => focus.reach(given).filter(value => value !== undefined),
        update: (given, change) =>
          focus.update(given, value => change(value === undefined ? inner.placeholder() : value)),
      }),
    ];
  }
  if (schema.kind === "boolean") {
    return [divided(path, ["true", "false"], focus, String, className => className === "true")];
  }
  if (schema.kind === "array") {
    const element = (schema as ArraySchema<unknown>).element;
    return positionAt(element, `${path}[]`, {
      reach: given => focus.reach(given).flatMap(value => (Array.isArray(value) ? value : [])),
      update: (given, change) =>
        focus.update(given, value => {
          const items = Array.isArray(value) && value.length > 0 ? value : [element.placeholder()];
          return items.map(change);
        }),
    });
  }
  if (schema.kind === "object") {
    return fieldsOf(schema as ObjectSchema<ObjectShape>, path, focus, inherited);
  }
  if (isSumSchema(schema)) {
    return [
      divided(
        path,
        schema.variantTags,
        focus,
        value => tagOf(schema, value),
        className => schema.placeholderFor(className),
      ),
      ...underCases(schema, path, focus),
    ];
  }
  return [
    {
      kind: borders.length === 0 ? "not-derivable" : "bounded",
      path,
      borders,
      valuesIn: focus.reach,
    },
  ];
}

function carrierOf(schema: AnySchema, measure: Border["measure"]): Carrier | undefined {
  if (measure === "length") {
    return integerCarrier;
  }
  switch (schema.kind) {
    case "integer":
      return integerCarrier;
    case "number":
      return numberCarrier;
    case "instant":
      return instantCarrier;
    case "string":
      return stringCarrier;
    default:
      return undefined;
  }
}

function divided(
  path: string,
  classes: readonly string[],
  focus: Focus,
  classOf: (value: unknown) => string | undefined,
  witness: (className: string) => unknown,
): DividedPosition {
  return {
    kind: "divided",
    path,
    classes: [...classes],
    borders: [],
    valuesIn: focus.reach,
    classify: given =>
      focus
        .reach(given)
        .map(classOf)
        .filter((value): value is string => value !== undefined),
    place: (given, className) => focus.update(given, () => witness(className)),
  };
}
