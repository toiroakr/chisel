import { deepEqual } from "./equal.js";
import { int64Carrier, rationalCarrier } from "./border.js";
import type {
  AnySchema,
  AnyVariantsSchema,
  ArraySchema,
  EnumSchema,
  DecimalSchema,
  ObjectSchema,
  ObjectShape,
  OptionalSchema,
  RecordSchema,
} from "./schema.js";
import type { Border, Carrier } from "./border.js";
import {
  bordersOf,
  dateCarrier,
  dateTimeCarrier,
  instantCarrier,
  timeCarrier,
  decimalCarrier,
  integerCarrier,
  lengthCarrier,
  numberCarrier,
  stringCarrier,
} from "./border.js";
import type { Rule } from "./rule.js";
import { boundTermPath, conjuncts, holds, stepInto, counts, measured, rewrite, partsOfMeasure, transformed } from "./rule.js";
import { isVariantsSchema, tagOf } from "./schema.js";

export type Position = DividedPosition | UndividedPosition;

export interface DividedPosition {
  readonly kind: "divided";
  readonly path: string;
  readonly segments: readonly string[];
  readonly classes: readonly string[];
  readonly excluded: readonly string[];
  readonly borders: readonly Border[];
  valuesIn(given: unknown): readonly unknown[];
  write(given: unknown, measure: Border["measure"], coordinate: unknown): unknown;
  classify(given: unknown): readonly string[];
  place(given: unknown, className: string): unknown;
  instancesIn(given: unknown): readonly DividedInstance[];
}

// One place a position's value sits in a given value: each element of an array
// and each entry of a record is its own, so one can be moved without the others.
export interface PositionInstance {
  readonly path: string;
  readonly segments: readonly string[];
  valuesIn(given: unknown): readonly unknown[];
  write(given: unknown, measure: Border["measure"], coordinate: unknown): unknown;
}

export interface DividedInstance extends PositionInstance {
  classify(given: unknown): readonly string[];
  place(given: unknown, className: string): unknown;
}

export function coordinatesIn(
  position: Position | PositionInstance,
  measure: Border["measure"],
  given: unknown,
): readonly unknown[] {
  return position
    .valuesIn(given)
    .filter(value => value !== undefined)
    .map(value => measured(value, measure));
}

export interface UndividedPosition {
  readonly kind: "not-derivable" | "bounded";
  readonly path: string;
  readonly segments: readonly string[];
  readonly borders: readonly Border[];
  valuesIn(given: unknown): readonly unknown[];
  write(given: unknown, measure: Border["measure"], coordinate: unknown): unknown;
  instancesIn(given: unknown): readonly PositionInstance[];
}

interface Focus {
  reach(given: unknown): readonly unknown[];
  update(given: unknown, change: (value: unknown) => unknown): unknown;
  instances(given: unknown): readonly Located[];
}

interface Located {
  readonly focus: Focus;
  readonly trail: readonly string[];
}

interface Step {
  reach(value: unknown): readonly unknown[];
  update(value: unknown, change: (value: unknown) => unknown): unknown;
}

function through(outer: Focus, inner: Step): Focus {
  const focus: Focus = {
    reach: given => outer.reach(given).flatMap(value => inner.reach(value)),
    update: (given, change) => outer.update(given, value => inner.update(value, change)),
    instances: () => [{ focus, trail: [] }],
  };
  return focus;
}

// `whole` reaches every value the step holds and writes as coverage needs (the
// first element, every entry); `each` names the steps that reach one of them.
function descend(
  parent: Focus,
  whole: Step,
  each: (value: unknown) => readonly (readonly [Step, string])[],
): Focus {
  return {
    ...through(parent, whole),
    instances: given =>
      parent.instances(given).flatMap(({ focus, trail }) =>
        each(focus.reach(given)[0]).map(([step, label]) => ({
          focus: through(focus, step),
          trail: [...trail, label],
        })),
      ),
  };
}

function rootFocus(): Focus {
  const focus: Focus = {
    reach: given => [given],
    update: (given, change) => change(given),
    instances: () => [{ focus, trail: [] }],
  };
  return focus;
}

// Segments rather than one rendered string, so a key holding "." or "[]" never
// reads as the nested path it happens to spell.
type Trail = readonly string[];

interface Reading {
  readonly containers: boolean;
}

export function positionsOf(
  input: AnyVariantsSchema,
  reading: Reading = { containers: false },
): readonly Position[] {
  return underCases(input, [], rootFocus(), reading);
}

function underCases(
  schema: AnyVariantsSchema,
  path: Trail,
  focus: Focus,
  reading: Reading,
  inherited: readonly Rule[] = [],
): Position[] {
  const rules = [...schema.invariants.flatMap(conjuncts), ...inherited];
  return schema.variantTags.flatMap(tag => {
    const narrowed: Step = {
      reach: value => (tagOf(schema, value) === tag ? [value] : []),
      update: (value, change) =>
        change(tagOf(schema, value) === tag ? value : schema.placeholderFor(tag)),
    };
    return fieldsOf(
      schema.variants[tag] as ObjectSchema<ObjectShape>,
      [...path, `@${tag}`],
      descend(focus, narrowed, () => [[narrowed, `@${tag}`]]),
      reading,
      rules,
    );
  });
}

export function excludedCases(schema: AnyVariantsSchema, inherited: readonly Rule[] = []): string[] {
  const rules = [...schema.invariants.flatMap(conjuncts), ...inherited].filter(rule => {
    const termPath = boundTermPath(rule);
    return termPath?.length === 1 && termPath[0] === schema.discriminant;
  });
  return schema.variantTags.filter(tag =>
    rules.some(rule => !holds(rule, { [schema.discriminant]: tag })),
  );
}

function fieldsOf(
  schema: ObjectSchema<ObjectShape>,
  path: Trail,
  focus: Focus,
  reading: Reading,
  inherited: readonly Rule[] = [],
): Position[] {
  const rules = [...schema.invariants.flatMap(conjuncts), ...inherited];
  return Object.entries(schema.shape).flatMap(([key, field]) => {
    const member: Step = {
      reach: value => [(value as Readonly<Record<string, unknown>>)[key]],
      update: (value, change) => {
        const record = value as Readonly<Record<string, unknown>>;
        const next = change(record[key]);
        if (next === undefined) {
          const { [key]: _removed, ...rest } = record;
          return rest;
        }
        return { ...record, [key]: next };
      },
    };
    return positionAt(
      field,
      [...path, `.${key}`],
      descend(focus, member, () => [[member, `.${key}`]]),
      reading,
      rules.flatMap(rule => {
        const inner = stepInto(rule, key);
        return inner === undefined ? [] : [inner];
      }),
      key,
    );
  });
}

// `field` is the key of the object field holding this position, carried down
// rather than read back from `path`, since a key may itself hold ".", "[]" or "?".
function positionAt(
  schema: AnySchema,
  path: Trail,
  focus: Focus,
  reading: Reading,
  inherited: readonly Rule[] = [],
  field?: string,
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
        className => (className === "なし" ? undefined : inner.placeholder(field)),
      ),
      ...positionAt(
        inner,
        [...path, "?"],
        descend(focus, present(inner, field), () => [[present(inner, field), "?"]]),
        reading,
        [],
        field,
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
  if (schema.kind === "enum") {
    const { values } = schema as EnumSchema<string>;
    return [
      divided(path, values, focus, String, className => className, {
        rules: rules.filter(rule => boundTermPath(rule)?.length === 0),
        sample: className => className,
      }),
    ];
  }
  if (schema.kind === "array") {
    const element = (schema as ArraySchema<unknown>).element;
    const first: Step = {
      reach: value => (Array.isArray(value) ? value : []),
      update: (value, change) => {
        const items = Array.isArray(value) && value.length > 0 ? value : [element.placeholder(field)];
        return items.map((item, index) => (index === 0 ? change(item) : item));
      },
    };
    const at = (index: number): Step => ({
      reach: value => (Array.isArray(value) && index < value.length ? [value[index]] : []),
      update: (value, change) =>
        (value as readonly unknown[]).map((item, other) => (other === index ? change(item) : item)),
    });
    const elements = positionAt(
      element,
      [...path, "[]"],
      descend(focus, first, value =>
        Array.isArray(value) && value.length > 0
          ? value.map((_, index) => [at(index), `[${index}]`] as const)
          : [[first, "[0]"]],
      ),
      reading,
      [],
      field,
    );
    return withOwnBorders(path, borders, focus, elements, reading, () => element.placeholder(field));
  }
  if (schema.kind === "record") {
    const every: Step = {
      reach: value => (typeof value === "object" && value !== null ? Object.values(value) : []),
      update: (value, change) => {
        const entries = Object.entries((value ?? {}) as Readonly<Record<string, unknown>>);
        const present =
          entries.length > 0
            ? entries
            : [["<key>", (schema as RecordSchema<unknown>).value.placeholder(field)] as const];
        return Object.fromEntries(present.map(([key, item]) => [key, change(item)]));
      },
    };
    const entry = (key: string): Step => ({
      reach: value => [(value as Readonly<Record<string, unknown>>)[key]],
      update: (value, change) => ({
        ...(value as Readonly<Record<string, unknown>>),
        [key]: change((value as Readonly<Record<string, unknown>>)[key]),
      }),
    });
    const values = positionAt(
      (schema as RecordSchema<unknown>).value,
      [...path, "{}"],
      descend(focus, every, value => {
        const keys = typeof value === "object" && value !== null ? Object.keys(value) : [];
        return keys.length > 0
          ? keys.map(key => [entry(key), `{${JSON.stringify(key)}}`] as const)
          : [[every, `{${JSON.stringify("<key>")}}`]];
      }),
      reading,
      [],
      field,
    );
    return withOwnBorders(path, borders, focus, values, reading, () =>
      (schema as RecordSchema<unknown>).value.placeholder(field),
    );
  }
  if (schema.kind === "object") {
    return fieldsOf(schema as ObjectSchema<ObjectShape>, path, focus, reading, inherited);
  }
  if (isVariantsSchema(schema)) {
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
      ...underCases(schema, path, focus, reading, inherited),
    ];
  }
  return [
    {
      kind: borders.length === 0 ? "not-derivable" : "bounded",
      path: path.join(""),
      segments: path,
      borders,
      valuesIn: focus.reach,
      write: writer(focus),
      instancesIn: given =>
        focus.instances(given).map(({ focus: located, trail }) => ({
          path: trail.join(""),
          segments: trail,
          valuesIn: located.reach,
          write: writer(located),
        })),
    },
  ];
}

function withOwnBorders(
  path: Trail,
  borders: readonly Border[],
  focus: Focus,
  inner: readonly Position[],
  reading: Reading,
  empty: () => unknown,
): Position[] {
  if (borders.length === 0 && !reading.containers) {
    return [...inner];
  }
  return [
    {
      kind: borders.length === 0 ? "not-derivable" : "bounded",
      path: path.join(""),
      segments: path,
      borders,
      valuesIn: focus.reach,
      write: writer(focus, empty),
      instancesIn: given =>
        focus.instances(given).map(({ focus: located, trail }) => ({
          path: trail.join(""),
          segments: trail,
          valuesIn: located.reach,
          write: writer(located, empty),
        })),
    },
    ...inner,
  ];
}

function writer(focus: Focus, empty?: () => unknown): Position["write"] {
  return (given, measure, coordinate) =>
    focus.update(given, current => rewrite(current, measure, coordinate, empty));
}

// A transformed string is stepped past a bound as it reads: the value the
// string carrier steps to is transformed again, and dropped where that moves it
// back across the bound, so a witness is one the transforms leave as it is.
function transformedStringCarrier(transforms: ReturnType<typeof partsOfMeasure>["transforms"]): Carrier {
  return {
    ...stringCarrier,
    past: (value, direction) => {
      const moved = stringCarrier.past?.(value, direction);
      if (moved === undefined) return undefined;
      const read = transformed(moved, transforms);
      return Math.sign(stringCarrier.compare(read, value)) === direction ? read : undefined;
    },
  };
}

// Writes a coordinate at a position, or gives undefined where a transformed
// measure cannot read back as it: no value lowercases to "ABC". A measure with
// no transform is written as before.
export function writeExactly(
  position: Pick<Position, "write" | "valuesIn">,
  given: unknown,
  measure: Border["measure"],
  coordinate: unknown,
): unknown {
  const written = position.write(given, measure, coordinate);
  return partsOfMeasure(measure).transforms.length === 0 ||
    position.valuesIn(written).some(value => value !== undefined && deepEqual(measured(value, measure), coordinate))
    ? written
    : undefined;
}

export function carrierOf(schema: AnySchema, measure: Border["measure"]): Carrier | undefined {
  // An enum's lengths are those of its few values, not a range a row can step
  // through, so a rule on one draws no border.
  if (counts(measure)) {
    return schema.kind === "enum" ? undefined : lengthCarrier;
  }
  const { transforms } = partsOfMeasure(measure);
  if (transforms.length > 0) {
    return schema.kind === "string" ? transformedStringCarrier(transforms) : undefined;
  }
  switch (schema.kind) {
    case "int64": return int64Carrier;
    case "rational": return rationalCarrier;
    case "integer":
      return integerCarrier;
    case "number":
      return numberCarrier;
    case "decimal":
      return decimalCarrier((schema as DecimalSchema).scale);
    case "instant":
      return instantCarrier;
    case "date":
      return dateCarrier;
    case "datetime":
      return dateTimeCarrier;
    case "time":
      return timeCarrier;
    case "string":
      return stringCarrier;
    default:
      return undefined;
  }
}

function divided(
  path: Trail,
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
    path: path.join(""),
    segments: path,
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
    instancesIn: given =>
      focus.instances(given).map(({ focus: located, trail }) => ({
        path: trail.join(""),
          segments: trail,
        valuesIn: located.reach,
        write: writer(located),
        classify: inner =>
          located
            .reach(inner)
            .map(classOf)
            .filter((value): value is string => value !== undefined),
        place: (inner, className) => located.update(inner, () => witness(className)),
      })),
  };
}

function present(inner: AnySchema, field: string | undefined): Step {
  return {
    reach: value => (value === undefined ? [] : [value]),
    update: (value, change) => change(value === undefined ? inner.placeholder(field) : value),
  };
}
