import type { Rule } from "./rule.js";
import { childrenOf, nodeOf } from "./model.js";
import { isTerm, termData } from "./rule.js";
import type { AnySchema, ArraySchema, ObjectSchema, ObjectShape, OptionalSchema, VariantTable } from "./schema.js";

// A comparison reading a value that may be left out would hold whenever it is,
// so it is refused where it is written: an absence is a case of a sum, and a
// field of some cases of a sum is read under a test of its discriminant.

interface Fact {
  readonly rule: Rule;
  readonly outcome: boolean;
}

export interface Roots {
  readonly scope: AnySchema;
  readonly locals?: ReadonlyMap<string, AnySchema>;
}

// What a rule settled with the outcome tells of the comparisons in it.
export function factsOf(rule: Rule, outcome: boolean): readonly Fact[] {
  switch (rule.kind) {
    case "compare":
      return [{ rule, outcome }];
    case "and":
      return outcome ? rule.rules.flatMap(part => factsOf(part, true)) : [];
    case "or":
      return outcome ? [] : rule.rules.flatMap(part => factsOf(part, false));
    case "not":
      return factsOf(rule.rule, !outcome);
    default:
      return [];
  }
}

// The first read of the rule that may be left out, described, or undefined.
export function leftOutReadIn(rule: Rule, roots: Roots, facts: readonly Fact[] = [], label = "$"): string | undefined {
  switch (rule.kind) {
    case "and":
    case "or": {
      const known = [...facts];
      for (const part of rule.rules) {
        const found = leftOutReadIn(part, roots, known, label);
        if (found !== undefined) return found;
        known.push(...factsOf(part, rule.kind === "and"));
      }
      return undefined;
    }
    case "not":
      return leftOutReadIn(rule.rule, roots, facts, label);
    case "all":
    case "any": {
      const found = leftOutOperand(rule.of, roots, facts, label);
      if (found !== undefined) return found;
      const of = termData(rule.of);
      const array = of.kind === "position" ? resolve(of.path, roots, facts) : undefined;
      const element = array?.kind === "array" ? (array as ArraySchema<unknown>).element as AnySchema : undefined;
      if (element === undefined) return undefined;
      const locals = new Map(roots.locals ?? []);
      locals.set(rule.element, element);
      return leftOutReadIn(rule.each, { ...roots, locals }, facts, label);
    }
    case "compare":
      if (!isTerm(rule.left) && !isTerm(rule.right)) return undefined;
      for (const side of [rule.left, rule.right]) {
        if (side === undefined) return "compares with undefined, which no value is: write the absence as a case of a sum";
        const found = leftOutOperand(side, roots, facts, label);
        if (found !== undefined) return found;
      }
      return undefined;
  }
}

function leftOutOperand(operand: unknown, roots: Roots, facts: readonly Fact[], label: string): string | undefined {
  if (!isTerm(operand)) return undefined;
  const data = termData(operand);
  const paths = data.kind === "position" ? [data.path] : data.parts.map(part => part.path);
  for (const path of paths) {
    const at = leftOutAt(path, roots, facts);
    if (at !== undefined) {
      const read = render(path, label);
      const where = render(path.slice(0, at), label);
      return read === where
        ? `reads ${read}, which may be left out: write its absence as a case of a sum`
        : `reads ${read}, which may be left out at ${where}: write its absence as a case of a sum`;
    }
  }
  return undefined;
}

function render(path: readonly string[], label: string): string {
  return path.length === 0 ? label : path[0]!.startsWith("#") || label === "" ? path.join(".") : [label, ...path].join(".");
}

// How many keys of the path lead to where it may be left out, or undefined
// where the value it reads is always there.
function leftOutAt(path: readonly string[], roots: Roots, facts: readonly Fact[]): number | undefined {
  const local = path.length > 0 ? roots.locals?.get(path[0]!) : undefined;
  let current: AnySchema | undefined = local ?? roots.scope;
  for (let index = local === undefined ? 0 : 1; index <= path.length; index++) {
    if (current === undefined) return undefined;
    if (current.kind === "optional") return index;
    if (index === path.length) return undefined;
    const key = path[index]!;
    if (current.kind === "record") return index + 1;
    if (current.kind === "object") {
      const { shape } = current as ObjectSchema<ObjectShape>;
      current = Object.hasOwn(shape, key) ? shape[key] : undefined;
      continue;
    }
    if (current.kind === "variants") {
      const sum = current as AnySchema & { readonly discriminant: string; readonly variants: VariantTable };
      if (key === sum.discriminant) return undefined;
      const cases = casesLeft(sum, path.slice(0, index), facts).map(tag => sum.variants[tag]!.shape);
      const declaring = cases.filter(shape => Object.hasOwn(shape, key));
      if (declaring.length < cases.length) return index;
      const fields = declaring.map(shape => shape[key]!);
      if (fields.some(field => field.kind === "optional")) return index + 1;
      current = fields[0];
      continue;
    }
    return undefined;
  }
  return undefined;
}

function casesLeft(sum: { readonly discriminant: string; readonly variants: VariantTable }, at: readonly string[], facts: readonly Fact[]): readonly string[] {
  let tags = Object.keys(sum.variants);
  for (const { rule, outcome } of facts) {
    if (rule.kind !== "compare" || (rule.operator !== "==" && rule.operator !== "!=")) continue;
    for (const [term, bound] of [[rule.left, rule.right], [rule.right, rule.left]] as const) {
      if (!isTerm(term) || typeof bound !== "string") continue;
      const data = termData(term);
      if (data.kind !== "position" || data.measure !== "value" || data.path.length !== at.length + 1) continue;
      if (!at.every((key, index) => data.path[index] === key) || data.path[at.length] !== sum.discriminant) continue;
      const equal = (rule.operator === "==") === outcome;
      tags = tags.filter(tag => (tag === bound) === equal);
    }
  }
  return tags;
}

function resolve(path: readonly string[], roots: Roots, facts: readonly Fact[]): AnySchema | undefined {
  const local = path.length > 0 ? roots.locals?.get(path[0]!) : undefined;
  let current: AnySchema | undefined = local ?? roots.scope;
  for (const [index, key] of path.entries()) {
    if (local !== undefined && index === 0) continue;
    if (current?.kind === "optional") current = (current as OptionalSchema<unknown>).schema as AnySchema;
    if (current?.kind === "object") {
      const { shape }: { shape: ObjectShape } = current as ObjectSchema<ObjectShape>;
      current = Object.hasOwn(shape, key) ? shape[key] : undefined;
    } else if (current?.kind === "variants") {
      const sum = current as AnySchema & { readonly discriminant: string; readonly variants: VariantTable };
      const tag = casesLeft(sum, path.slice(0, index), facts).find(candidate => Object.hasOwn(sum.variants[candidate]!.shape, key));
      current = tag === undefined ? undefined : sum.variants[tag]!.shape[key];
    } else {
      return undefined;
    }
  }
  return current?.kind === "optional" ? (current as OptionalSchema<unknown>).schema as AnySchema : current;
}

// The same over a model: each choice is read under what the choices around it
// settled, and a local is read as the schema it was bound under.
export function leftOutReadInModel(template: unknown, roots: Roots, facts: readonly Fact[] = []): string | undefined {
  const node = nodeOf(template);
  const within = (name: string, schema: AnySchema) => ({ ...roots, locals: new Map([...(roots.locals ?? []), [name, schema]]) });
  switch (node?.kind) {
    case "choose":
      return leftOutReadIn(node.condition, roots, facts)
        ?? leftOutReadInModel(node.yes, roots, [...facts, ...factsOf(node.condition, true)])
        ?? leftOutReadInModel(node.no, roots, [...facts, ...factsOf(node.condition, false)]);
    case "bind":
      return leftOutReadInModel(node.value, roots, facts) ?? leftOutReadInModel(node.body, within(node.name, node.schema as AnySchema), facts);
    case "map":
      return leftOutReadInModel(node.values, roots, facts) ?? leftOutReadInModel(node.body, within(node.name, node.element as AnySchema), facts);
    case "fold": {
      const body = { ...within(node.name, node.element as AnySchema) };
      return leftOutReadInModel(node.values, roots, facts) ?? leftOutReadInModel(node.initial, roots, facts)
        ?? leftOutReadInModel(node.body, { ...body, locals: new Map([...(body.locals ?? []), [node.accumulator, node.output as AnySchema]]) }, facts);
    }
    default:
      for (const child of childrenOf(template)) {
        const found = leftOutReadInModel(child, roots, facts);
        if (found !== undefined) return found;
      }
      return undefined;
  }
}
