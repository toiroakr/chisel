import { Decimal } from "decimal.js";
import type { Temporal as TemporalTypes } from "temporal-spec";
import { Rational, isRational } from "./exact.js";
import { optional } from "./schema.js";
import type { Infer, ObjectSchema, ObjectShape, Schema, ValidationResult } from "./schema.js";

export const DATA = Symbol.for("chisel.data");
declare const named: unique symbol;
export type Named<Name extends string, T> = T & { readonly [named]: Name };
export interface DataSchema<Name extends string, Shape extends ObjectShape> extends Schema<Named<Name, Infer<ObjectSchema<Shape>>>> {
  readonly kind: "object";
  readonly shape: Shape;
  readonly name: Name;
  readonly [DATA]: ObjectSchema<Shape>;
  create(value: Infer<ObjectSchema<Shape>>): Named<Name, Infer<ObjectSchema<Shape>>>;
}
export function data<const Name extends string, const Shape extends ObjectShape>(name: Name, base: ObjectSchema<Shape>): DataSchema<Name, Shape> {
  type Value = Named<Name, Infer<ObjectSchema<Shape>>>;
  const finish = (result: ValidationResult<Infer<ObjectSchema<Shape>>>): ValidationResult<Value> => result.success ? { success: true, value: snapshotValue(result.value) as Value } : result;
  const schema = {
    ...base, name, [DATA]: base,
    parse: (value: unknown, path?: string) => finish(base.parse(value, path)),
    create(value: Infer<ObjectSchema<Shape>>): Value {
      const result = finish(base.parse(value));
      if (!result.success) throw new Error(`Cannot construct ${name}: ${result.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
      return result.value;
    },
    refine(...args: [any] | [string, any]) { return data(name, args.length === 2 ? base.refine(args[0], args[1]) : base.refine(args[0])); },
    optional() { return optional(schema as unknown as DataSchema<Name, Shape>); },
    describe(text: string) { return data(name, base.describe(text)); },
  };
  return schema as unknown as DataSchema<Name, Shape>;
}
export function snapshotValue<T>(value: T): T {
  if (Decimal.isDecimal(value)) {
    const copy = new Decimal(value);
    Object.freeze(copy.d);
    return Object.freeze(copy) as T;
  }
  if (Array.isArray(value)) return Object.freeze(value.map(snapshotValue)) as T;
  if (value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, snapshotValue(child)]))) as T;
  }
  if (value !== null && typeof value === "object") {
    if (isRational(value)) return new Rational(value.numerator, value.denominator) as T;
    const temporal = (globalThis as unknown as { Temporal?: typeof TemporalTypes }).Temporal;
    if (temporal) {
      for (const Type of [temporal.Instant, temporal.PlainDate, temporal.PlainTime, temporal.PlainDateTime]) {
        if (value instanceof Type) return Object.freeze(Type.from(value as never)) as T;
      }
    }
    throw new Error("Cannot snapshot an unsupported host object");
  }
  if (typeof value === "function") throw new Error("Cannot snapshot an unsupported host object");
  return value;
}
