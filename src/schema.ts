import type { Temporal as TemporalTypes } from "temporal-spec";
import type { InvariantRule, Rule, TermOf } from "./rule.js";
import { conjuncts, describeRule, holds, satisfy, selfTerm } from "./rule.js";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly issues: readonly ValidationIssue[] };

export interface Schema<T> {
  readonly kind: string;
  readonly invariants: readonly Rule[];
  parse(value: unknown, path?: string): ValidationResult<T>;
  placeholder(name?: string): unknown;
  refine(rule: InvariantRule<T>): this;
  // Typed through `this` rather than T: naming T here would make Schema<T>
  // invariant in T, and StringSchema would stop being an AnySchema.
  optional<Self extends AnySchema>(this: Self): OptionalSchema<Infer<Self>>;
}

// Shorthands for the bounds a rule most often states; each one desugars to the
// same rule refine() would take, so the analysis reads them alike.
interface ValueBounds {
  min(bound: number): this;
  max(bound: number): this;
  gt(bound: number): this;
  lt(bound: number): this;
}

interface LengthBounds {
  min(length: number): this;
  max(length: number): this;
  length(length: number): this;
}

export type AnySchema = Schema<unknown>;
export type Infer<S> = S extends Schema<infer T> ? T : never;

export interface StringSchema extends Schema<string>, LengthBounds {
  readonly kind: "string";
}

export interface NumberSchema extends Schema<number>, ValueBounds {
  readonly kind: "number";
}

export interface IntSchema extends Schema<number>, ValueBounds {
  readonly kind: "integer";
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

export interface ArraySchema<T> extends Schema<readonly T[]>, LengthBounds {
  readonly kind: "array";
  readonly element: Schema<T>;
}

export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly kind: "optional";
  readonly schema: Schema<T>;
}

export interface RecordSchema<T> extends Schema<Readonly<Record<string, T>>>, LengthBounds {
  readonly kind: "record";
  readonly value: Schema<T>;
}

export type ObjectShape = Readonly<Record<string, AnySchema>>;

type OptionalShapeKeys<Shape extends ObjectShape> = {
  readonly [K in keyof Shape]: Shape[K] extends { readonly kind: "optional" }
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

export type VariantTable = Readonly<Record<string, ObjectSchema<ObjectShape>>>;

export type VariantsValue<
  Discriminant extends string,
  Variants extends VariantTable,
> = {
  [K in keyof Variants & string]: Readonly<Record<Discriminant, K>> &
    Infer<Variants[K]>;
}[keyof Variants & string];

export type VariantValue<
  Discriminant extends string,
  Variants extends VariantTable,
  Tag extends keyof Variants & string,
> = Readonly<Record<Discriminant, Tag>> & Infer<Variants[Tag]>;

export interface VariantsSchema<
  Discriminant extends string,
  Variants extends VariantTable,
> extends Schema<VariantsValue<Discriminant, Variants>> {
  readonly kind: "variants";
  readonly discriminant: Discriminant;
  readonly variants: Variants;
  readonly variantTags: readonly (keyof Variants & string)[];
  placeholderFor<Tag extends keyof Variants & string>(
    tag: Tag,
  ): VariantValue<Discriminant, Variants, Tag>;
}

export type AnyVariantsSchema = VariantsSchema<any, any>;
export type Tags<S> = S extends VariantsSchema<any, infer Variants>
  ? keyof Variants & string
  : never;
export type VariantOf<S, Tag extends Tags<S>> = S extends VariantsSchema<
  infer Discriminant,
  infer Variants
>
  ? Tag extends keyof Variants & string
    ? VariantValue<Discriminant, Variants, Tag>
    : never
  : never;

function valid<T>(value: T): ValidationResult<T> {
  return { success: true, value };
}

function invalid(path: string, message: string): ValidationResult<never> {
  return { success: false, issues: [{ path, message }] };
}

type SchemaCore<S extends AnySchema> = Omit<
  S,
  "invariants" | "refine" | "optional" | "min" | "max" | "gt" | "lt" | "length"
>;

function refinable<S extends AnySchema>(core: SchemaCore<S>, invariants: readonly Rule[] = []): S {
  const schema = {
    ...core,
    invariants,
    parse(value: unknown, path = "$") {
      const result = core.parse(value, path);
      if (!result.success) {
        return result;
      }
      const broken = invariants.find(rule => !holds(rule, result.value));
      return broken === undefined
        ? result
        : invalid(path, `Invariant violated: ${describeRule(broken, path)}`);
    },
    placeholder(name?: string) {
      return invariants
        .flatMap(conjuncts)
        .reduce<unknown>((value, rule) => satisfy(rule, value), core.placeholder(name));
    },
    refine(rule: (self: TermOf<unknown>) => Rule) {
      return refinable<S>(core, [...invariants, rule(selfTerm())]);
    },
    optional() {
      return optional(schema as unknown as S);
    },
  };
  const refine = (rule: (self: any) => Rule): S => schema.refine(rule);
  if (core.kind === "number" || core.kind === "integer") {
    Object.assign(schema, {
      min: (bound: number) => refine(v => v.$gte(bound)),
      max: (bound: number) => refine(v => v.$lte(bound)),
      gt: (bound: number) => refine(v => v.$gt(bound)),
      lt: (bound: number) => refine(v => v.$lt(bound)),
    });
  }
  if (core.kind === "string" || core.kind === "array" || core.kind === "record") {
    Object.assign(schema, {
      min: (length: number) => refine(v => v.$length().$gte(length)),
      max: (length: number) => refine(v => v.$length().$lte(length)),
      length: (length: number) => refine(v => v.$length().$eq(length)),
    });
  }
  return schema as unknown as S;
}

export function string(): StringSchema {
  return refinable<StringSchema>({
    kind: "string",
    parse,
    placeholder: (name = "string") => `<${name}>`,
  });

  function parse(value: unknown, path = "$"): ValidationResult<string> {
    return typeof value === "string"
      ? valid(value)
      : invalid(path, "Expected a string");
  }
}

export function number(): NumberSchema {
  return refinable<NumberSchema>({
    kind: "number",
    parse,
    placeholder: () => 0,
  });

  function parse(value: unknown, path = "$"): ValidationResult<number> {
    return typeof value === "number" && Number.isFinite(value)
      ? valid(value)
      : invalid(path, "Expected a finite number");
  }
}

export function int(): IntSchema {
  return refinable<IntSchema>({
    kind: "integer",
    parse,
    placeholder: () => 0,
  });

  function parse(value: unknown, path = "$"): ValidationResult<number> {
    return Number.isSafeInteger(value)
      ? valid(value as number)
      : invalid(path, "Expected an integer");
  }
}

export function boolean(): BooleanSchema {
  return refinable<BooleanSchema>({
    kind: "boolean",
    parse,
    placeholder: () => false,
  });

  function parse(value: unknown, path = "$"): ValidationResult<boolean> {
    return typeof value === "boolean"
      ? valid(value)
      : invalid(path, "Expected a boolean");
  }
}

export function instant(): InstantSchema {
  return refinable<InstantSchema>({
    kind: "instant",
    parse,
    placeholder: () =>
      temporalInstant().from("2000-01-01T00:00:00Z"),
  });

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
  return refinable<LiteralSchema<T>>({
    kind: "literal",
    value: expected,
    parse,
    placeholder: () => expected,
  });

  function parse(value: unknown, path = "$"): ValidationResult<T> {
    return value === expected
      ? valid(expected)
      : invalid(path, `Expected ${JSON.stringify(expected)}`);
  }
}

export function object<const Shape extends ObjectShape>(
  shape: Shape,
): ObjectSchema<Shape> {
  return refinable<ObjectSchema<Shape>>({
    kind: "object",
    shape,
    parse,
    placeholder,
  });

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
    for (const key of Object.keys(source)) {
      if (!Object.hasOwn(shape, key)) {
        issues.push({ path: `${path}.${key}`, message: "Unexpected key" });
      }
    }

    return issues.length > 0
      ? { success: false, issues }
      : valid(output as InferShape<Shape>);
  }

  function placeholder(): unknown {
    const output: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape)) {
      const value = field.placeholder(key);
      if (value !== undefined) {
        output[key] = value;
      }
    }
    return output;
  }
}

export function array<T>(element: Schema<T>): ArraySchema<T> {
  return refinable<ArraySchema<T>>({
    kind: "array",
    element,
    parse,
    placeholder: (name?: string) => [element.placeholder(name)],
  });

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

function optional<T>(schema: Schema<T>): OptionalSchema<T> {
  return refinable<OptionalSchema<T>>({
    kind: "optional",
    schema,
    parse,
    placeholder: () => undefined,
  });

  function parse(value: unknown, path = "$"): ValidationResult<T | undefined> {
    return value === undefined ? valid(undefined) : schema.parse(value, path);
  }
}

export function record<T>(value: Schema<T>): RecordSchema<T> {
  return refinable<RecordSchema<T>>({
    kind: "record",
    value,
    parse,
    placeholder: (name?: string) => ({ "<key>": value.placeholder(name) }),
  });

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

export function variants<
  const Discriminant extends string,
  const Variants extends VariantTable,
>(
  discriminant: Discriminant,
  variants: Variants,
): VariantsSchema<Discriminant, Variants> {
  const variantTags = Object.keys(variants) as (keyof Variants & string)[];

  return refinable<VariantsSchema<Discriminant, Variants>>({
    kind: "variants",
    discriminant,
    variants,
    variantTags,
    parse,
    placeholder: () => placeholderFor(variantTags[0]!),
    placeholderFor,
  });

  function parse(
    value: unknown,
    path = "$",
  ): ValidationResult<VariantsValue<Discriminant, Variants>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return invalid(path, "Expected an object");
    }

    const source = value as Readonly<Record<string, unknown>>;
    const tag = source[discriminant];
    if (typeof tag !== "string" || !Object.hasOwn(variants, tag)) {
      return invalid(
        `${path}.${discriminant}`,
        `Expected one of ${variantTags.join(", ")}`,
      );
    }

    const variant = variants[tag];
    if (variant === undefined) {
      return invalid(`${path}.${discriminant}`, `Unknown variant ${tag}`);
    }

    const { [discriminant]: _tag, ...fields } = source;
    const result = variant.parse(Object.hasOwn(variant.shape, discriminant) ? source : fields, path);
    return result.success
      ? valid({ [discriminant]: tag, ...result.value } as VariantsValue<
          Discriminant,
          Variants
        >)
      : result;
  }

  function placeholderFor<Tag extends keyof Variants & string>(
    tag: Tag,
  ): VariantValue<Discriminant, Variants, Tag> {
    const fields = variants[tag]!.placeholder() as Record<string, unknown>;
    return { [discriminant]: tag, ...fields } as VariantValue<
      Discriminant,
      Variants,
      Tag
    >;
  }
}

export function isVariantsSchema(schema: AnySchema): schema is AnyVariantsSchema {
  return schema.kind === "variants";
}

export function tagOf(schema: AnyVariantsSchema, value: unknown): string | undefined {
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

export function schemaAtPath(schema: AnySchema, keys: readonly string[]): AnySchema | undefined {
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
  return field === undefined ? undefined : schemaAtPath(field, rest);
}
