import type {
  AnySchema,
  AnySumSchema,
  ArraySchema,
  ObjectSchema,
  ObjectShape,
  OptionalSchema,
  RecordSchema,
} from "./schema.js";
import type { Border, Carrier } from "./border.js";
import {
  bordersOf,
  instantCarrier,
  integerCarrier,
  lengthCarrier,
  numberCarrier,
  stringCarrier,
} from "./border.js";
import type { Rule } from "./rule.js";
import { boundTermPath, conjuncts, holds, resize, sizeOf, stepInto } from "./rule.js";
import { isSumSchema, tagOf } from "./schema.js";

export type Position = DividedPosition | UndividedPosition;

export interface DividedPosition {
  readonly kind: "divided";
  readonly path: string;
  readonly classes: readonly string[];
  readonly excluded: readonly string[];
  readonly borders: readonly Border[];
  valuesIn(given: unknown): readonly unknown[];
  write(given: unknown, measure: Border["measure"], coordinate: unknown): unknown;
  classify(given: unknown): readonly string[];
  place(given: unknown, className: string): unknown;
}

export function coordinatesIn(
  position: Position,
  measure: Border["measure"],
  given: unknown,
): readonly unknown[] {
  return position
    .valuesIn(given)
    .filter(value => value !== undefined)
    .map(value => (measure === "length" ? sizeOf(value) : value));
}

export interface UndividedPosition {
  readonly kind: "not-derivable" | "bounded";
  readonly path: string;
  readonly borders: readonly Border[];
  valuesIn(given: unknown): readonly unknown[];
  write(given: unknown, measure: Border["measure"], coordinate: unknown): unknown;
}

interface Focus {
  reach(given: unknown): readonly unknown[];
  update(given: unknown, change: (value: unknown) => unknown): unknown;
}

interface Reading {
  readonly containers: boolean;
}

export function positionsOf(
  input: AnySumSchema,
  reading: Reading = { containers: false },
): readonly Position[] {
  return underCases(
    input,
    "",
    {
      reach: given => [given],
      update: (given, change) => change(given),
    },
    reading,
  );
}

function underCases(
  schema: AnySumSchema,
  path: string,
  focus: Focus,
  reading: Reading,
): Position[] {
  return schema.variantTags.flatMap(tag =>
    fieldsOf(schema.variants[tag] as ObjectSchema<ObjectShape>, `${path}@${tag}`, {
      reach: given => focus.reach(given).filter(value => tagOf(schema, value) === tag),
      update: (given, change) =>
        focus.update(given, value =>
          change(tagOf(schema, value) === tag ? value : schema.placeholderFor(tag)),
        ),
    }, reading),
  );
}

function fieldsOf(
  schema: ObjectSchema<ObjectShape>,
  path: string,
  focus: Focus,
  reading: Reading,
  inherited: readonly Rule[] = [],
): Position[] {
  const rules = [...schema.invariants.flatMap(conjuncts), ...inherited];
  return Object.entries(schema.shape).flatMap(([key, field]) =>
    positionAt(
      field,
      `${path}.${key}`,
      {
        reach: given =>
          focus.reach(given).map(value => (value as Readonly<Record<string, unknown>>)[key]),
        update: (given, change) =>
          focus.update(given, value => {
            const record = value as Readonly<Record<string, unknown>>;
            const next = change(record[key]);
            if (next === undefined) {
              const { [key]: _removed, ...rest } = record;
              return rest;
            }
            return { ...record, [key]: next };
          }),
      },
      reading,
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
  reading: Reading,
  inherited: readonly Rule[] = [],
): Position[] {
  const borders = bordersOf(
    [...schema.invariants.flatMap(conjuncts), ...inherited].filter(rule => boundTermPath(rule)?.length === 0),
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
      ...positionAt(
        inner,
        `${path}?`,
        {
          reach: given => focus.reach(given).filter(value => value !== undefined),
          update: (given, change) =>
            focus.update(given, value => change(value === undefined ? inner.placeholder() : value)),
        },
        reading,
      ),
    ];
  }
  const rules = [...schema.invariants.flatMap(conjuncts), ...inherited];
  if (schema.kind === "boolean") {
    return [
      divided(path, ["true", "false"], focus, String, className => className === "true", {
        rules: rules.filter(rule => boundTermPath(rule)?.length === 0),
        sample: className => className === "true",
      }),
    ];
  }
  if (schema.kind === "array") {
    const element = (schema as ArraySchema<unknown>).element;
    const elements = positionAt(element, `${path}[]`, {
      reach: given => focus.reach(given).flatMap(value => (Array.isArray(value) ? value : [])),
      update: (given, change) =>
        focus.update(given, value => {
          const items = Array.isArray(value) && value.length > 0 ? value : [element.placeholder()];
          return items.map((item, index) => (index === 0 ? change(item) : item));
        }),
    }, reading);
    return withOwnBorders(path, borders, focus, elements, reading);
  }
  if (schema.kind === "record") {
    const values = positionAt((schema as RecordSchema<unknown>).value, `${path}{}`, {
      reach: given =>
        focus
          .reach(given)
          .flatMap(value =>
            typeof value === "object" && value !== null ? Object.values(value) : [],
          ),
      update: (given, change) =>
        focus.update(given, value => {
          const entries = Object.entries((value ?? {}) as Readonly<Record<string, unknown>>);
          const present =
            entries.length > 0
              ? entries
              : [["<key>", (schema as RecordSchema<unknown>).value.placeholder()] as const];
          return Object.fromEntries(present.map(([key, item]) => [key, change(item)]));
        }),
    }, reading);
    return withOwnBorders(path, borders, focus, values, reading);
  }
  if (schema.kind === "object") {
    return fieldsOf(schema as ObjectSchema<ObjectShape>, path, focus, reading, inherited);
  }
  if (isSumSchema(schema)) {
    return [
      divided(
        path,
        schema.variantTags,
        focus,
        value => tagOf(schema, value),
        className => schema.placeholderFor(className),
        {
          rules: rules.filter(rule => {
            const termPath = boundTermPath(rule);
            return termPath?.length === 1 && termPath[0] === schema.discriminant;
          }),
          sample: className => ({ [schema.discriminant]: className }),
        },
      ),
      ...underCases(schema, path, focus, reading),
    ];
  }
  return [
    {
      kind: borders.length === 0 ? "not-derivable" : "bounded",
      path,
      borders,
      valuesIn: focus.reach,
      write: writer(focus),
    },
  ];
}

function withOwnBorders(
  path: string,
  borders: readonly Border[],
  focus: Focus,
  inner: readonly Position[],
  reading: Reading,
): Position[] {
  if (borders.length === 0 && !reading.containers) {
    return [...inner];
  }
  return [
    {
      kind: borders.length === 0 ? "not-derivable" : "bounded",
      path,
      borders,
      valuesIn: focus.reach,
      write: writer(focus),
    },
    ...inner,
  ];
}

function writer(focus: Focus): Position["write"] {
  return (given, measure, coordinate) =>
    focus.update(given, current =>
      measure === "length" ? resize(current, coordinate as number) : coordinate,
    );
}

export function carrierOf(schema: AnySchema, measure: Border["measure"]): Carrier | undefined {
  if (measure === "length") {
    return lengthCarrier;
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
  refusal: { readonly rules: readonly Rule[]; sample(className: string): unknown } = {
    rules: [],
    sample: () => undefined,
  },
): DividedPosition {
  return {
    kind: "divided",
    path,
    classes: [...classes],
    excluded: classes.filter(className =>
      refusal.rules.some(rule => !holds(rule, refusal.sample(className))),
    ),
    borders: [],
    valuesIn: focus.reach,
    write: writer(focus),
    classify: given =>
      focus
        .reach(given)
        .map(classOf)
        .filter((value): value is string => value !== undefined),
    place: (given, className) => focus.update(given, () => witness(className)),
  };
}
