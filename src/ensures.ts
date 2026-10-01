import type { AnyBehavior, EnsuresClause } from "./behavior.js";
import type { Rule, Term } from "./rule.js";
import { conjuncts, describeRule, holds, isTerm, termData } from "./rule.js";
import type { AnySchema } from "./schema.js";
import { isVariantsSchema, schemaAtPath } from "./schema.js";

export type EnsuresClassification =
  | "derivable"
  | "exact match"
  | "always holds"
  | "never holds"
  | "runtime only";

export interface EnsuresReading {
  readonly clause: string;
  readonly cases?: readonly string[];
  readonly conjunct: string;
  readonly classification: EnsuresClassification;
}

export interface EnsuresReport {
  readonly rules: readonly EnsuresReading[];
  readonly unstated: readonly string[];
}

export function readEnsures(definition: AnyBehavior): EnsuresReport {
  const rules = definition.ensures.flatMap(clause =>
    conjuncts(clause.rule).map(
      (conjunct): EnsuresReading => ({
        clause: clause.name,
        ...(clause.cases === undefined ? {} : { cases: clause.cases }),
        conjunct: describeRule(conjunct, ""),
        classification: classify(conjunct, clause, definition),
      }),
    ),
  );
  const stated = new Set(definition.ensures.flatMap(clause => clause.cases ?? []));
  const everyCase = definition.ensures.some(clause => clause.cases === undefined);
  const unstated =
    definition.ensures.length === 0 || everyCase || !isVariantsSchema(definition.result)
      ? []
      : definition.result.variantTags.filter(tag => !stated.has(tag));
  return { rules, unstated };
}

const numeric = new Set(["integer", "number", "decimal", "instant", "date", "time", "datetime"]);
const named = new Set(["string", "boolean", "literal", "enum"]);

function classify(
  rule: Rule,
  clause: EnsuresClause,
  definition: AnyBehavior,
): EnsuresClassification {
  if (rule.kind !== "compare") {
    return "runtime only";
  }
  const terms = [rule.left, rule.right].filter(isTerm) as Term<unknown>[];
  if (terms.length === 0) {
    return holds(rule, {}) ? "always holds" : "never holds";
  }
  if (terms.length === 2 && sameTerm(terms[0]!, terms[1]!)) {
    return rule.operator === "==" || rule.operator === "<=" || rule.operator === ">="
      ? "always holds"
      : "never holds";
  }
  const kinds = terms.map(term => kindOf(term, clause, definition));
  if (kinds.every(kind => kind !== undefined && numeric.has(kind))) {
    return "derivable";
  }
  if (
    (rule.operator === "==" || rule.operator === "!=") &&
    kinds.every(kind => kind !== undefined && (named.has(kind) || kind === "discriminant"))
  ) {
    return "exact match";
  }
  return "runtime only";
}

function sameTerm(left: Term<unknown>, right: Term<unknown>): boolean {
  return JSON.stringify(termData(left)) === JSON.stringify(termData(right));
}

function kindOf(term: Term<unknown>, clause: EnsuresClause, definition: AnyBehavior): string | undefined {
  const data = termData(term);
  if (data.kind === "linear") {
    const kinds = data.parts.map(part => kindAt(part.path, part.measure, clause, definition));
    return kinds.every(kind => kind !== undefined && numeric.has(kind)) ? "number" : undefined;
  }
  return kindAt(data.path, data.measure, clause, definition);
}

function kindAt(
  path: readonly string[],
  measure: "value" | "length",
  clause: EnsuresClause,
  definition: AnyBehavior,
): string | undefined {
  if (measure === "length") {
    return "integer";
  }
  const [root, ...keys] = path;
  for (const scope of scopesOf(root, clause, definition)) {
    const owner = schemaAtPath(scope, keys.slice(0, -1));
    if (owner !== undefined && isVariantsSchema(owner) && owner.discriminant === keys[keys.length - 1]) {
      return "discriminant";
    }
    const schema = schemaAtPath(scope, keys);
    if (schema !== undefined) {
      return schema.kind;
    }
  }
  return undefined;
}

// The schemas a clause's root reads: every input case for `input`, and the result
// cases the clause names for `value`.
export function scopesOf(
  root: string | undefined,
  clause: EnsuresClause,
  definition: Pick<AnyBehavior, "input" | "result">,
): readonly AnySchema[] {
  return root === "input"
    ? (Object.values(definition.input.variants) as AnySchema[])
    : root === "value"
      ? valueScopes(clause, definition)
      : [];
}

function valueScopes(clause: EnsuresClause, definition: Pick<AnyBehavior, "result">): readonly AnySchema[] {
  const { result } = definition;
  if (!isVariantsSchema(result)) {
    return [result as AnySchema];
  }
  const cases = clause.cases ?? result.variantTags;
  return cases.flatMap(tag => {
    const variant = result.variants[tag] as AnySchema | undefined;
    return variant === undefined ? [] : [variant];
  });
}

