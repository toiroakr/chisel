import type { Temporal as TemporalTypes } from "temporal-spec";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly issues: readonly ValidationIssue[] };

export interface Schema<T> {
  readonly kind: string;
  parse(value: unknown, path?: string): ValidationResult<T>;
  placeholder(): unknown;
}

export type AnySchema = Schema<unknown>;
export type Infer<S> = S extends Schema<infer T> ? T : never;

export interface StringSchema extends Schema<string> {
  readonly kind: "string";
  readonly name: string;
}

export interface NumberSchema extends Schema<number> {
  readonly kind: "number";
}

export interface BooleanSchema extends Schema<boolean> {
  readonly kind: "boolean";
}

export interface InstantSchema extends Schema<TemporalTypes.Instant> {
  readonly kind: "instant";
}

export interface LiteralSchema<T extends string | number | boolean | null>
  extends Schema<T> {
  readonly kind: "literal";
  readonly value: T;
}

export interface ArraySchema<T> extends Schema<readonly T[]> {
  readonly kind: "array";
  readonly element: Schema<T>;
}

export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly kind: "optional";
  readonly schema: Schema<T>;
}

export interface RecordSchema<T> extends Schema<Readonly<Record<string, T>>> {
  readonly kind: "record";
  readonly value: Schema<T>;
}

export type ObjectShape = Readonly<Record<string, AnySchema>>;

type OptionalShapeKeys<Shape extends ObjectShape> = {
  readonly [K in keyof Shape]: Shape[K] extends OptionalSchema<unknown>
    ? K
    : never;
}[keyof Shape];

type RequiredShapeKeys<Shape extends ObjectShape> = Exclude<
  keyof Shape,
  OptionalShapeKeys<Shape>
>;

export type InferShape<Shape extends ObjectShape> = {
  readonly [K in RequiredShapeKeys<Shape>]: Infer<Shape[K]>;
} & {
  readonly [K in OptionalShapeKeys<Shape>]?: Exclude<Infer<Shape[K]>, undefined>;
};

export interface ObjectSchema<Shape extends ObjectShape>
  extends Schema<InferShape<Shape>> {
  readonly kind: "object";
  readonly shape: Shape;
}

export type SumVariants = Readonly<Record<string, ObjectSchema<ObjectShape>>>;

export type SumValue<
  Discriminant extends string,
  Variants extends SumVariants,
> = {
  [K in keyof Variants & string]: Readonly<Record<Discriminant, K>> &
    Infer<Variants[K]>;
}[keyof Variants & string];

export type SumVariant<
  Discriminant extends string,
  Variants extends SumVariants,
  Tag extends keyof Variants & string,
> = Readonly<Record<Discriminant, Tag>> & Infer<Variants[Tag]>;

export interface SumSchema<
  Discriminant extends string,
  Variants extends SumVariants,
> extends Schema<SumValue<Discriminant, Variants>> {
  readonly kind: "sum";
  readonly discriminant: Discriminant;
  readonly variants: Variants;
  readonly variantTags: readonly (keyof Variants & string)[];
  placeholderFor<Tag extends keyof Variants & string>(
    tag: Tag,
  ): SumVariant<Discriminant, Variants, Tag>;
}

export type AnySumSchema = SumSchema<any, any>;
export type Tags<S> = S extends SumSchema<string, infer Variants>
  ? keyof Variants & string
  : never;
export type VariantOf<S, Tag extends Tags<S>> = S extends SumSchema<
  infer Discriminant,
  infer Variants
>
  ? Tag extends keyof Variants & string
    ? SumVariant<Discriminant, Variants, Tag>
    : never
  : never;

function valid<T>(value: T): ValidationResult<T> {
  return { success: true, value };
}

function invalid(path: string, message: string): ValidationResult<never> {
  return { success: false, issues: [{ path, message }] };
}

export function string(name = "string"): StringSchema {
  return {
    kind: "string",
    name,
    parse,
    placeholder: () => `<${name}>`,
  };

  function parse(value: unknown, path = "$"): ValidationResult<string> {
    return typeof value === "string"
      ? valid(value)
      : invalid(path, `Expected ${name}`);
  }
}

export function number(): NumberSchema {
  return {
    kind: "number",
    parse,
    placeholder: () => 0,
  };

  function parse(value: unknown, path = "$"): ValidationResult<number> {
    return typeof value === "number" && Number.isFinite(value)
      ? valid(value)
      : invalid(path, "Expected a finite number");
  }
}

export function boolean(): BooleanSchema {
  return {
    kind: "boolean",
    parse,
    placeholder: () => false,
  };

  function parse(value: unknown, path = "$"): ValidationResult<boolean> {
    return typeof value === "boolean"
      ? valid(value)
      : invalid(path, "Expected a boolean");
  }
}

export function instant(): InstantSchema {
  return {
    kind: "instant",
    parse,
    placeholder: () =>
      temporalInstant().from("2000-01-01T00:00:00Z"),
  };

  function parse(
    value: unknown,
    path = "$",
  ): ValidationResult<TemporalTypes.Instant> {
    return value instanceof temporalInstant()
      ? valid(value)
      : invalid(path, "Expected a Temporal.Instant");
  }
}

export function literal<const T extends string | number | boolean | null>(
  expected: T,
): LiteralSchema<T> {
  return {
    kind: "literal",
    value: expected,
    parse,
    placeholder: () => expected,
  };

  function parse(value: unknown, path = "$"): ValidationResult<T> {
    return value === expected
      ? valid(expected)
      : invalid(path, `Expected ${JSON.stringify(expected)}`);
  }
}

export function object<const Shape extends ObjectShape>(
  shape: Shape,
): ObjectSchema<Shape> {
  return {
    kind: "object",
    shape,
    parse,
    placeholder,
  };

  function parse(value: unknown, path = "$"): ValidationResult<InferShape<Shape>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return invalid(path, "Expected an object");
    }

    const source = value as Readonly<Record<string, unknown>>;
    const output: Record<string, unknown> = {};
    const issues: ValidationIssue[] = [];

    for (const [key, field] of Object.entries(shape)) {
      const result = field.parse(source[key], `${path}.${key}`);
      if (result.success) {
        if (result.value !== undefined) {
          output[key] = result.value;
        }
      } else {
        issues.push(...result.issues);
      }
    }

    return issues.length > 0
      ? { success: false, issues }
      : valid(output as InferShape<Shape>);
  }

  function placeholder(): unknown {
    const output: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape)) {
      const value = field.placeholder();
      if (value !== undefined) {
        output[key] = value;
      }
    }
    return output;
  }
}

export function array<T>(element: Schema<T>): ArraySchema<T> {
  return {
    kind: "array",
    element,
    parse,
    placeholder: () => [element.placeholder()],
  };

  function parse(value: unknown, path = "$"): ValidationResult<readonly T[]> {
    if (!Array.isArray(value)) {
      return invalid(path, "Expected an array");
    }

    const output: T[] = [];
    const issues: ValidationIssue[] = [];

    value.forEach((item, index) => {
      const result = element.parse(item, `${path}[${index}]`);
      if (result.success) {
        output.push(result.value);
      } else {
        issues.push(...result.issues);
      }
    });

    return issues.length > 0 ? { success: false, issues } : valid(output);
  }
}

export function optional<T>(schema: Schema<T>): OptionalSchema<T> {
  return {
    kind: "optional",
    schema,
    parse,
    placeholder: () => undefined,
  };

  function parse(value: unknown, path = "$"): ValidationResult<T | undefined> {
    return value === undefined ? valid(undefined) : schema.parse(value, path);
  }
}

export function record<T>(value: Schema<T>): RecordSchema<T> {
  return {
    kind: "record",
    value,
    parse,
    placeholder: () => ({}),
  };

  function parse(
    raw: unknown,
    path = "$",
  ): ValidationResult<Readonly<Record<string, T>>> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return invalid(path, "Expected an object");
    }

    const output: Record<string, T> = {};
    const issues: ValidationIssue[] = [];

    for (const [key, item] of Object.entries(
      raw as Readonly<Record<string, unknown>>,
    )) {
      const result = value.parse(item, `${path}.${key}`);
      if (result.success) {
        output[key] = result.value;
      } else {
        issues.push(...result.issues);
      }
    }

    return issues.length > 0 ? { success: false, issues } : valid(output);
  }
}

export function sum<
  const Discriminant extends string,
  const Variants extends SumVariants,
>(
  discriminant: Discriminant,
  variants: Variants,
): SumSchema<Discriminant, Variants> {
  const variantTags = Object.keys(variants) as (keyof Variants & string)[];

  return {
    kind: "sum",
    discriminant,
    variants,
    variantTags,
    parse,
    placeholder: () => placeholderFor(variantTags[0]!),
    placeholderFor,
  };

  function parse(
    value: unknown,
    path = "$",
  ): ValidationResult<SumValue<Discriminant, Variants>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return invalid(path, "Expected an object");
    }

    const source = value as Readonly<Record<string, unknown>>;
    const tag = source[discriminant];
    if (typeof tag !== "string" || !(tag in variants)) {
      return invalid(
        `${path}.${discriminant}`,
        `Expected one of ${variantTags.join(", ")}`,
      );
    }

    const variant = variants[tag];
    if (variant === undefined) {
      return invalid(`${path}.${discriminant}`, `Unknown variant ${tag}`);
    }

    const result = variant.parse(value, path);
    return result.success
      ? valid({ [discriminant]: tag, ...result.value } as SumValue<
          Discriminant,
          Variants
        >)
      : result;
  }

  function placeholderFor<Tag extends keyof Variants & string>(
    tag: Tag,
  ): SumVariant<Discriminant, Variants, Tag> {
    const fields = variants[tag]!.placeholder() as Record<string, unknown>;
    return { [discriminant]: tag, ...fields } as SumVariant<
      Discriminant,
      Variants,
      Tag
    >;
  }
}

export function isSumSchema(schema: AnySchema): schema is AnySumSchema {
  return schema.kind === "sum";
}

export function tagOf(schema: AnySumSchema, value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const tag = (value as Readonly<Record<string, unknown>>)[schema.discriminant];
  return typeof tag === "string" && schema.variantTags.includes(tag)
    ? tag
    : undefined;
}

function temporalInstant(): TemporalTypes.InstantConstructor {
  const temporal = (
    globalThis as unknown as {
      readonly Temporal?: {
        readonly Instant?: TemporalTypes.InstantConstructor;
      };
    }
  ).Temporal;
  if (temporal?.Instant === undefined) {
    throw new Error("Temporal is unavailable; Chisel requires Node.js 26 or later");
  }
  return temporal.Instant;
}
