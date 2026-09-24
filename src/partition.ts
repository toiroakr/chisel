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
}

export interface UndividedPosition {
  readonly kind: "not-derivable";
  readonly path: string;
}

type Reach = (given: unknown) => readonly unknown[];

export function positionsOf(input: AnySumSchema): readonly Position[] {
  return underCases(input, "", given => [given]);
}

function underCases(schema: AnySumSchema, path: string, reach: Reach): Position[] {
  return schema.variantTags.flatMap(tag =>
    fieldsOf(
      schema.variants[tag] as ObjectSchema<ObjectShape>,
      `${path}@${tag}`,
      given => reach(given).filter(value => tagOf(schema, value) === tag),
    ),
  );
}

function fieldsOf(
  schema: ObjectSchema<ObjectShape>,
  path: string,
  reach: Reach,
): Position[] {
  return Object.entries(schema.shape).flatMap(([key, field]) =>
    positionAt(field, `${path}.${key}`, given =>
      reach(given).map(value => (value as Readonly<Record<string, unknown>>)[key]),
    ),
  );
}

function positionAt(schema: AnySchema, path: string, reach: Reach): Position[] {
  if (schema.kind === "optional") {
    return [
      divided(path, ["なし", "あり"], reach, value =>
        value === undefined ? "なし" : "あり",
      ),
      ...positionAt((schema as OptionalSchema<unknown>).schema, `${path}?`, given =>
        reach(given).filter(value => value !== undefined),
      ),
    ];
  }
  if (schema.kind === "boolean") {
    return [divided(path, ["true", "false"], reach, String)];
  }
  if (schema.kind === "array") {
    return positionAt((schema as ArraySchema<unknown>).element, `${path}[]`, given =>
      reach(given).flatMap(value => (Array.isArray(value) ? value : [])),
    );
  }
  if (schema.kind === "object") {
    return fieldsOf(schema as ObjectSchema<ObjectShape>, path, reach);
  }
  if (isSumSchema(schema)) {
    return [
      divided(path, schema.variantTags, reach, value => tagOf(schema, value)),
      ...underCases(schema, path, reach),
    ];
  }
  return [{ kind: "not-derivable", path }];
}

function divided(
  path: string,
  classes: readonly string[],
  reach: Reach,
  classOf: (value: unknown) => string | undefined,
): DividedPosition {
  return {
    kind: "divided",
    path,
    classes: [...classes],
    classify: given =>
      reach(given)
        .map(classOf)
        .filter((value): value is string => value !== undefined),
  };
}
