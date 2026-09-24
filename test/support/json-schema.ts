type Schema = {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | Schema;
  readonly items?: Schema;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly oneOf?: readonly Schema[];
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, Schema>>;
};

export function validate(schema: Schema, value: unknown): readonly string[] {
  return check(schema, value, "$", schema);
}

function check(schema: Schema, value: unknown, at: string, root: Schema): string[] {
  if (schema.$ref !== undefined) {
    const name = schema.$ref.replace("#/$defs/", "");
    return check(root.$defs![name]!, value, at, root);
  }
  if (schema.oneOf !== undefined) {
    const matching = schema.oneOf.filter(option => check(option, value, at, root).length === 0);
    return matching.length === 1 ? [] : [`${at}: matches ${matching.length} of oneOf`];
  }
  if (schema.const !== undefined && value !== schema.const) {
    return [`${at}: expected ${JSON.stringify(schema.const)}`];
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return [`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`];
  }
  if (schema.type !== undefined) {
    const types = typeof schema.type === "string" ? [schema.type] : schema.type;
    if (!types.some(type => is(type, value))) {
      return [`${at}: expected ${types.join(" | ")}`];
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    return value.flatMap((item, index) => check(schema.items!, item, `${at}[${index}]`, root));
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Readonly<Record<string, unknown>>;
    const problems = (schema.required ?? [])
      .filter(key => !(key in record))
      .map(key => `${at}: missing ${key}`);
    for (const [key, field] of Object.entries(record)) {
      const declared = schema.properties?.[key];
      if (declared !== undefined) {
        problems.push(...check(declared, field, `${at}.${key}`, root));
      } else if (schema.additionalProperties === false) {
        problems.push(`${at}: unexpected ${key}`);
      } else if (typeof schema.additionalProperties === "object") {
        problems.push(...check(schema.additionalProperties, field, `${at}.${key}`, root));
      }
    }
    return problems;
  }
  return [];
}

function is(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "null":
      return value === null;
    default:
      return typeof value === type;
  }
}
