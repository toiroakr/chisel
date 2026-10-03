import { Rational } from "./exact.js";
import { Decimal } from "decimal.js";
import type {
  AnySchema, AnyVariantsSchema, ArraySchema, ObjectSchema, ObjectShape,
  OptionalSchema, RecordSchema, Schema, ValidationIssue, ValidationResult,
} from "./schema.js";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

type Direction = "decode" | "encode";

export function decode<T>(schema: Schema<T>, value: unknown): ValidationResult<T> {
  const issues: ValidationIssue[] = [];
  const converted = convert(schema as AnySchema, value, "decode", "$", issues);
  return issues.length > 0 ? { success: false, issues } : schema.parse(converted);
}

export function encode<T>(schema: Schema<T>, value: NoInfer<T>): ValidationResult<JsonValue> {
  const parsed = schema.parse(value);
  if (!parsed.success) {
    return parsed;
  }
  const issues: ValidationIssue[] = [];
  const converted = convert(schema as AnySchema, parsed.value, "encode", "$", issues);
  return issues.length > 0 ? { success: false, issues } : { success: true, value: converted as JsonValue };
}

function convert(schema: AnySchema, value: unknown, direction: Direction, path: string, issues: ValidationIssue[]): unknown {
  const refuse = (message: string): undefined => {
    issues.push({ path, message });
    return undefined;
  };
  if (schema.kind === "optional") {
    if (value === undefined) {
      return direction === "decode" ? undefined : refuse("An absent value has no JSON representation; omit an optional object field");
    }
    return convert((schema as OptionalSchema<unknown>).schema, value, direction, path, issues);
  }
  if (["int64", "rational", "decimal", "instant", "date", "time", "datetime"].includes(schema.kind)) {
    if (direction === "encode") {
      return String(value);
    }
    if (typeof value !== "string") {
      return refuse(`Expected a string encoding ${schema.kind}`);
    }
    try {
      switch (schema.kind) {
        case "int64": if (!/^-?(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid bigint"); return BigInt(value);
        case "rational": return new Rational(value);
        case "decimal": return new Decimal(value);
        case "instant": return Temporal.Instant.from(value);
        case "date": return Temporal.PlainDate.from(value);
        case "time": return Temporal.PlainTime.from(value);
        case "datetime": return Temporal.PlainDateTime.from(value);
      }
    } catch {
      return refuse(`Invalid ${schema.kind} string`);
    }
  }
  if (schema.kind === "array" && Array.isArray(value)) {
    const element = (schema as ArraySchema<unknown>).element;
    return value.map((item, index) => convert(element, item, direction, `${path}[${index}]`, issues));
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const source = value as Readonly<Record<string, unknown>>;
    if (schema.kind === "variants") {
      const sum = schema as AnyVariantsSchema;
      const tag = source[sum.discriminant];
      if (typeof tag !== "string" || !Object.hasOwn(sum.variants, tag)) {
        return value;
      }
      return convert(sum.variants[tag]!, source, direction, path, issues);
    }
    if (schema.kind === "object" || schema.kind === "record") {
      const shape = schema.kind === "object" ? (schema as ObjectSchema<ObjectShape>).shape : undefined;
      const itemSchema = schema.kind === "record" ? (schema as RecordSchema<unknown>).value : undefined;
      return Object.fromEntries(Object.entries(source).map(([key, item]) => {
        const field = itemSchema ?? (shape !== undefined && Object.hasOwn(shape, key) ? shape[key] : undefined);
        return [key, field === undefined ? item : convert(field, item, direction, `${path}.${key}`, issues)];
      }));
    }
  }
  if (direction === "encode" &&
      !(value === null || typeof value === "string" || typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)))) {
    return refuse("Value has no JSON representation");
  }
  return value;
}
