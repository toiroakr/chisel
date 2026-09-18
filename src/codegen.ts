import type { Temporal as TemporalTypes } from "temporal-spec";

export function formatTypeScriptValue(value: unknown): string {
  return format(value, 0);
}

function format(value: unknown, level: number): string {
  if (value instanceof temporalInstant()) {
    return `Temporal.Instant.from(${JSON.stringify(value.toString())})`;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const items = value
      .map(item => `${indent(level + 1)}${format(item, level + 1)}`)
      .join(",\n");
    return `[\n${items}\n${indent(level)}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return "{}";
    }
    const fields = entries
      .map(
        ([key, field]) =>
          `${indent(level + 1)}${JSON.stringify(key)}: ${format(field, level + 1)}`,
      )
      .join(",\n");
    return `{\n${fields}\n${indent(level)}}`;
  }
  throw new TypeError(`Cannot format ${typeof value} as TypeScript`);
}

function indent(level: number): string {
  return "  ".repeat(level);
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
