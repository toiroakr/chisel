export function formatTypeScriptValue(value: unknown): string {
  return format(value, 0);
}

function format(value: unknown, level: number): string {
  if (value === undefined) {
    return "undefined";
  }
  const type = temporalTypeOf(value);
  if (type !== undefined) {
    return `Temporal.${type}.from(${JSON.stringify(String(value))})`;
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
      .map(item => `${indent(level + 1)}${format(item, level + 1)},\n`)
      .join("");
    return `[\n${items}${indent(level)}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return "{}";
    }
    const fields = entries
      .map(
        ([key, field]) => `${indent(level + 1)}${formatKey(key)}: ${format(field, level + 1)},\n`,
      )
      .join("");
    return `{\n${fields}${indent(level)}}`;
  }
  throw new TypeError(`Cannot format ${typeof value} as TypeScript`);
}

export function formatKey(key: string): string {
  return /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u.test(key) ? key : JSON.stringify(key);
}

function indent(level: number): string {
  return "  ".repeat(level);
}

const TEMPORAL_TYPES = ["Instant", "PlainDate", "PlainTime", "PlainDateTime"] as const;

function temporalTypeOf(value: unknown): (typeof TEMPORAL_TYPES)[number] | undefined {
  const temporal = (
    globalThis as unknown as {
      readonly Temporal?: Partial<Record<(typeof TEMPORAL_TYPES)[number], abstract new (...args: never[]) => unknown>>;
    }
  ).Temporal;
  if (temporal === undefined) {
    throw new Error("Temporal is unavailable; Chisel requires Node.js 26 or later");
  }
  return TEMPORAL_TYPES.find(type => {
    const constructor = temporal[type];
    return constructor !== undefined && value instanceof constructor;
  });
}
