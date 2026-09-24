import type {
  AnySchema,
  AnySumSchema,
  ArraySchema,
  ObjectSchema,
  ObjectShape,
  OptionalSchema,
} from "./schema.js";
import { isSumSchema, tagOf } from "./schema.js";

export type Position = DividedPosition | UndividedPosition;

export interface DividedPosition {
  readonly kind: "divided";
  readonly path: string;
  readonly classes: readonly string[];
  classify(given: unknown): readonly string[];
  place(given: unknown, className: string): unknown;
}

export interface UndividedPosition {
  readonly kind: "not-derivable";
  readonly path: string;
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
): Position[] {
  return Object.entries(schema.shape).flatMap(([key, field]) =>
    positionAt(field, `${path}.${key}`, {
      reach: given =>
        focus.reach(given).map(value => (value as Readonly<Record<string, unknown>>)[key]),
      update: (given, change) =>
        focus.update(given, value => {
          const { [key]: current, ...rest } = value as Readonly<Record<string, unknown>>;
          const next = change(current);
          return next === undefined ? rest : { ...rest, [key]: next };
        }),
    }),
  );
}

function positionAt(schema: AnySchema, path: string, focus: Focus): Position[] {
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
    return fieldsOf(schema as ObjectSchema<ObjectShape>, path, focus);
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
  return [{ kind: "not-derivable", path }];
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
    classify: given =>
      focus
        .reach(given)
        .map(classOf)
        .filter((value): value is string => value !== undefined),
    place: (given, className) => focus.update(given, () => witness(className)),
  };
}
