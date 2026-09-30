import { Decimal } from "decimal.js";
import type { Temporal as TemporalTypes } from "temporal-spec";
import type { ElementLabels, InvariantRule, Operator, Rule, Term, TermOf } from "./rule.js";
import {
  conjuncts,
  decimalStep,
  describeRule,
  holds,
  isDecimal,
  isTerm,
  satisfy,
  selfTerm,
  termData,
} from "./rule.js";

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
  // The name of the invariant the value breaks, where it was given one.
  readonly invariant?: string;
}

export interface InvariantOptions {
  readonly name?: string;
}

export type ValidationResult<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly issues: readonly ValidationIssue[] };

export interface Schema<T> {
  readonly kind: string;
  readonly invariants: readonly Rule[];
  // What the value means, for the people reading the specification.
  readonly description?: string;
  parse(value: unknown, path?: string): ValidationResult<T>;
  placeholder(name?: string): unknown;
  refine(rule: InvariantRule<T>, options?: InvariantOptions): this;
  describe(text: string): this;
  // Typed through `this` rather than T: naming T here would make Schema<T>
  // invariant in T, and StringSchema would stop being an AnySchema.
  optional<Self extends AnySchema>(this: Self): OptionalSchema<Infer<Self>>;
}

// Shorthands for the bounds a rule most often states; each one desugars to the
// same rule refine() would take, so the analysis reads them alike.
interface ValueBounds<T> {
  min(bound: T, options?: InvariantOptions): this;
  max(bound: T, options?: InvariantOptions): this;
  gt(bound: T, options?: InvariantOptions): this;
  lt(bound: T, options?: InvariantOptions): this;
}

interface LengthBounds {
  min(length: number, options?: InvariantOptions): this;
  max(length: number, options?: InvariantOptions): this;
  length(length: number, options?: InvariantOptions): this;
}

export type AnySchema = Schema<unknown>;
export type Infer<S> = S extends Schema<infer T> ? T : never;

export interface StringSchema extends Schema<string>, LengthBounds {
  readonly kind: "string";
}

export interface NumberSchema extends Schema<number>, ValueBounds<number> {
  readonly kind: "number";
}

export interface IntSchema extends Schema<number>, ValueBounds<number> {
  readonly kind: "integer";
}

export interface DecimalSchema extends Schema<Decimal>, ValueBounds<Decimal> {
  readonly kind: "decimal";
  // How many digits a value may have after the decimal point.
  readonly scale: number;
}

export interface BooleanSchema extends Schema<boolean> {
  readonly kind: "boolean";
}

export interface InstantSchema extends Schema<TemporalTypes.Instant>, ValueBounds<TemporalTypes.Instant> {
  readonly kind: "instant";
}

export interface DateSchema extends Schema<TemporalTypes.PlainDate>, ValueBounds<TemporalTypes.PlainDate> {
  readonly kind: "date";
}

export interface TimeSchema extends Schema<TemporalTypes.PlainTime>, ValueBounds<TemporalTypes.PlainTime> {
  readonly kind: "time";
}

export interface DateTimeSchema extends Schema<TemporalTypes.PlainDateTime>, ValueBounds<TemporalTypes.PlainDateTime> {
  readonly kind: "datetime";
}

export interface EnumSchema<T extends string> extends Schema<T> {
  readonly kind: "enum";
  readonly values: readonly T[];
  // What each value means, where the specification says so.
  readonly labels?: { readonly [Value in T]?: string };
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
  "invariants" | "refine" | "describe" | "optional" | "min" | "max" | "gt" | "lt" | "length"
>;

const ORDERED_KINDS = new Set(["number", "integer", "decimal", "instant", "date", "time", "datetime"]);

function refinable<S extends AnySchema>(core: SchemaCore<S>, invariants: readonly Rule[] = []): S {
  const schema = {
    ...core,
    invariants,
    parse(value: unknown, path = "$") {
      const result = core.parse(value, path);
      if (!result.success) {
        return result;
      }
      const broken = invariants.filter(rule => !holds(rule, result.value));
      return broken.length === 0
        ? result
        : {
            success: false as const,
            issues: broken.map(rule =>
              rule.name === undefined
                ? { path, message: `Invariant violated: ${describeRule(rule, path)}` }
                : {
                    path,
                    message: `Invariant ${rule.name} violated: ${describeRule(rule, path)}`,
                    invariant: rule.name,
                  },
            ),
          };
    },
    placeholder(name?: string) {
      // An enum has no value to step to, so a rule on one, its own or one an
      // enclosing object or sum writes on it, takes the first value that rule keeps
      // among those the enum's own invariants keep; a decimal steps by the unit of
      // its last digit.
      const stepAt = (path: readonly string[]) => {
        const at = fieldOf(schema as unknown as AnySchema, path);
        if (at?.kind === "enum") {
          return { among: (at as EnumSchema<string>).values.filter(value => at.invariants.every(rule => holds(rule, value))) };
        }
        return at?.kind === "decimal" ? decimalStep((at as DecimalSchema).scale) : undefined;
      };
      return invariants
        .flatMap(conjuncts)
        .reduce<unknown>((value, rule) => satisfy(rule, value, stepAt), core.placeholder(name));
    },
    refine(rule: (self: TermOf<unknown>) => Rule, options: InvariantOptions = {}) {
      if (options.name !== undefined && invariants.some(invariant => invariant.name === options.name)) {
        throw new Error(`Invariant ${options.name} is declared more than once`);
      }
      const refined: Rule = options.name === undefined ? rule(selfTerm()) : { ...rule(selfTerm()), name: options.name };
      const offGrid = offGridEquality(refined, keys => fieldOf(schema as unknown as AnySchema, keys), "$");
      if (offGrid !== undefined) {
        throw new Error(`refine ${offGrid}`);
      }
      return refinable<S>(core, [...invariants, refined]);
    },
    describe(text: string) {
      return refinable<S>({ ...core, description: text }, invariants);
    },
    optional() {
      return optional(schema as unknown as S);
    },
  };
  const refine = (rule: (self: any) => Rule, options?: InvariantOptions): S => schema.refine(rule, options);
  if (ORDERED_KINDS.has(core.kind)) {
    Object.assign(schema, {
      min: (bound: unknown, options?: InvariantOptions) => refine(v => v.$gte(bound), options),
      max: (bound: unknown, options?: InvariantOptions) => refine(v => v.$lte(bound), options),
      gt: (bound: unknown, options?: InvariantOptions) => refine(v => v.$gt(bound), options),
      lt: (bound: unknown, options?: InvariantOptions) => refine(v => v.$lt(bound), options),
    });
  }
  if (core.kind === "string" || core.kind === "array" || core.kind === "record") {
    Object.assign(schema, {
      min: (length: number, options?: InvariantOptions) => refine(v => v.$length().$gte(length), options),
      max: (length: number, options?: InvariantOptions) => refine(v => v.$length().$lte(length), options),
      length: (length: number, options?: InvariantOptions) => refine(v => v.$length().$eq(length), options),
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

// A Decimal from decimal.js with at most `scale` digits after the point, such as
// an amount in cents (`decimal(2)`), so the value next to a bound is known and
// arithmetic on it is exact.
export function decimal(scale: number): DecimalSchema {
  if (!Number.isSafeInteger(scale) || scale < 0) {
    throw new Error(`decimal takes a whole number of digits, not ${scale}`);
  }
  return refinable<DecimalSchema>({
    kind: "decimal",
    scale,
    parse,
    placeholder: () => new Decimal(0),
  });

  function parse(value: unknown, path = "$"): ValidationResult<Decimal> {
    if (!isDecimal(value) || !value.isFinite()) {
      return invalid(path, "Expected a Decimal");
    }
    if (value.decimalPlaces() > scale) {
      return invalid(path, `Expected a Decimal with at most ${scale} decimal places`);
    }
    // -0 is 0: a Decimal keeps the sign of a zero, and a row writing 0 must match.
    return valid(value.isZero() && value.isNegative() ? value.abs() : value);
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

export function date(): DateSchema {
  return plain("date", "PlainDate", "2000-01-01") as DateSchema;
}

export function time(): TimeSchema {
  return plain("time", "PlainTime", "00:00") as TimeSchema;
}

export function datetime(): DateTimeSchema {
  return plain("datetime", "PlainDateTime", "2000-01-01T00:00") as DateTimeSchema;
}

type PlainType = "PlainDate" | "PlainTime" | "PlainDateTime";

function plain(kind: string, type: PlainType, placeholder: string): AnySchema {
  return refinable<AnySchema>({
    kind,
    parse: (value: unknown, path = "$") =>
      value instanceof temporalPlain(type) ? valid(value) : invalid(path, `Expected a Temporal.${type}`),
    placeholder: () => temporalPlain(type).from(placeholder),
  });
}

// Exported as `enum`, a word a function may not be named. Each value is a class
// of the position the enum stands at, the way a boolean is two.
// What each value means is its second argument, as zod takes its options there:
// enum(["DRAFT", "SUBMITTED"], { labels: { DRAFT: "下書き", SUBMITTED: "申請中" } }).
export function enumOf<const T extends string>(
  values: readonly [T, ...T[]],
  options: { readonly labels?: { readonly [Value in T]?: string } } = {},
): EnumSchema<T> {
  if (values.length === 0) {
    throw new Error("enum names no value");
  }
  const repeated = values.find((value, index) => values.indexOf(value) !== index);
  if (repeated !== undefined) {
    throw new Error(`enum names ${repeated} twice`);
  }
  const { labels } = options;
  const unknown = Object.keys(labels ?? {}).find(key => !(values as readonly string[]).includes(key));
  if (unknown !== undefined) {
    throw new Error(`enum labels ${unknown}, which it does not name`);
  }
  return refinable<EnumSchema<T>>({
    kind: "enum",
    values,
    ...(labels === undefined ? {} : { labels }),
    parse,
    placeholder: () => values[0],
  });

  function parse(value: unknown, path = "$"): ValidationResult<T> {
    return typeof value === "string" && (values as readonly string[]).includes(value)
      ? valid(value as T)
      : invalid(path, `Expected one of ${values.map(value => JSON.stringify(value)).join(", ")}`);
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
    // A field reads the same whether it may be left out or not.
    ...(schema.description === undefined ? {} : { description: schema.description }),
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

function temporalPlain(type: PlainType): { from(text: string): unknown; new (...args: never[]): unknown } {
  const constructor = (
    globalThis as unknown as {
      readonly Temporal?: Partial<Record<PlainType, { from(text: string): unknown; new (...args: never[]): unknown }>>;
    }
  ).Temporal?.[type];
  if (constructor === undefined) {
    throw new Error("Temporal is unavailable; Chisel requires Node.js 26 or later");
  }
  return constructor;
}

// An equality between a decimal and a value with more digits than it keeps
// settles without a row, so it is written by mistake.
export function holdsNoDecimal(schema: AnySchema, operator: Operator, bound: unknown): boolean {
  return (
    schema.kind === "decimal" &&
    (operator === "==" || operator === "!=") &&
    isDecimal(bound) &&
    bound.decimalPlaces() > (schema as DecimalSchema).scale
  );
}

// Says where a rule compares a decimal with such a value, reading each term's
// schema through `resolve` and an element of `all`/`any` through its array.
export function offGridEquality(
  rule: Rule,
  resolve: (path: readonly string[]) => AnySchema | undefined,
  label: string,
  labels: ElementLabels = {},
): string | undefined {
  switch (rule.kind) {
    case "and":
    case "or":
      return rule.rules.map(part => offGridEquality(part, resolve, label, labels)).find(Boolean);
    case "not":
      return offGridEquality(rule.rule, resolve, label, labels);
    case "all":
    case "any": {
      const of = termData(rule.of).path;
      const collection = resolve(of);
      const element = collection?.kind === "array" ? (collection as ArraySchema<unknown>).element : undefined;
      const inner = (path: readonly string[]) =>
        path[0] === rule.element ? (element === undefined ? undefined : schemaAtPath(element, path.slice(1))) : resolve(path);
      return offGridEquality(rule.each, inner, label, { ...labels, [rule.element]: `${nameOf(of, label, labels)}[]` });
    }
    case "compare": {
      const [term, bound] = isTerm(rule.left) ? [rule.left, rule.right] : [rule.right, rule.left];
      if (!isTerm(term) || isTerm(bound) || termData(term).measure !== "value") {
        return undefined;
      }
      const { path } = termData(term as Term<unknown>);
      const schema = resolve(path);
      return schema !== undefined && holdsNoDecimal(schema, rule.operator, bound)
        ? `compares ${nameOf(path, label, labels)} with ${String(bound)}, which no decimal(${(schema as DecimalSchema).scale}) holds: ${describeRule(rule, label, labels)}`
        : undefined;
    }
  }
}

function nameOf(path: readonly string[], label: string, labels: ElementLabels): string {
  const [first, ...rest] = path;
  const [base, keys] = first !== undefined && labels[first] !== undefined ? [labels[first]!, rest] : [label, path];
  return [base, ...keys].filter(part => part !== "").join(".");
}

// The schema a path reads, looked up through the cases of a sum as well, since a
// rule written on the sum names a field its cases hold.
function fieldOf(schema: AnySchema, keys: readonly string[]): AnySchema | undefined {
  if (!isVariantsSchema(schema)) {
    return schemaAtPath(schema, keys);
  }
  for (const each of Object.values(schema.variants) as AnySchema[]) {
    const found = schemaAtPath(each, keys);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
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
  const { shape } = unwrapped as ObjectSchema<ObjectShape>;
  return Object.hasOwn(shape, key) ? schemaAtPath(shape[key]!, rest) : undefined;
}
