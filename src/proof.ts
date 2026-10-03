import { EvaluationLimit } from "./exact.js";
import { provesNumeric } from "./interval.js";
import type { AnyBehavior, AnyImplementation } from "./behavior.js";
import { brokenEnsures } from "./behavior.js";
import { constantsOf, domainOf } from "./domain.js";
import { feasibilityOf } from "./feasibility.js";
import { feasibilityScope } from "./guard-borders.js";
import { childrenOf, dependencyName, interpret, modelPaths, nodeOf, replaceChildren } from "./model.js";
import type { Rule } from "./rule.js";
import { conjuncts, holds, isTerm, positionData, positionTerm, sizeOf, termPaths, withDeps } from "./rule.js";
import type { AnySchema, DecimalSchema, ArraySchema, ObjectSchema, ObjectShape, OptionalSchema, RecordSchema, EnumSchema, LiteralSchema } from "./schema.js";
import { isVariantsSchema, schemaAtPath, tagOf, object } from "./schema.js";
import type { Step } from "./ways.js";
import { outcomesOf } from "./ways.js";

export interface ConstructionProof {
  readonly decision: string;
  readonly status: "verified" | "refuted" | "undetermined";
  readonly reason: string;
  readonly counterexample?: unknown;
}
export interface ProofReport {
  readonly status: "verified" | "refuted" | "undetermined";
  readonly decisions: readonly ConstructionProof[];
}
export function verify(implementation: AnyImplementation, options: { readonly candidates?: number; readonly ways?: number } = {}): ProofReport {
  const candidates = options.candidates ?? 4096, ways = options.ways ?? 10000;
  for (const limit of [candidates, ways]) if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Proof budgets must be positive safe integers");
  if (implementation.pipeline) {
    const [first, second] = implementation.pipeline;
    const boundary = pipelineBoundary(first, second, candidates);
    return summarize([...implementation.pipeline.flatMap(stage => verify(stage, options).decisions), boundary]);
  }
  if (implementation.external) return summarize([{ decision: implementation.behavior.name, status: "undetermined", reason: "External implementation has no inspectable body" }]);
  const definition = implementation.behavior;
  const decisions: ConstructionProof[] = [];
  for (const [tag, decision] of Object.entries(implementation.cases)) {
    if (decision.kind !== "rules" || decision.expression === undefined) {
      decisions.push({ decision: decision.kind === "todo" ? tag : decision.id, status: "undetermined", reason: "Use model() to make all constructions and decisions inspectable" });
      continue;
    }
    const base = { decision: decision.id };
    const calls = containsCalls(decision.expression);
    const domain = domainOf(object({ input: definition.input, deps: object(Object.fromEntries(Object.entries(definition.requires).filter(([, dependency]) => dependency.takes === "nothing").map(([name, dependency]) => [name, dependency.output]))) }), candidates, constantsOf(decision.guards.map(guard => guard.condition)));
    let failed: ConstructionProof | undefined;
    for (const candidate of calls ? [] : domain.values) {
      const { input, deps } = candidate as { input: unknown; deps: unknown };
      if (tagOf(definition.input, input) !== tag) continue;
      try {
        const execution = interpret(decision.expression, withDeps(input, Object.keys(definition.requires).length ? deps : undefined)) as { result: unknown; effects: readonly unknown[] };
        const result = definition.result.parse(execution.result);
        if (!result.success) throw new Error(result.issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
        if (!Array.isArray(execution.effects)) throw new Error("Effects must be an array");
        for (const effect of execution.effects) {
          const parsed = definition.effects.parse(effect);
          if (!parsed.success) throw new Error(parsed.issues[0]!.message);
        }
        const broken = brokenEnsures(definition, input, result.value);
        if (broken) throw new Error(`Ensures ${broken.name} does not hold`);
      } catch (error) {
        failed = { ...base, status: error instanceof EvaluationLimit ? "undetermined" : "refuted", reason: error instanceof Error ? error.message : String(error), ...(error instanceof EvaluationLimit ? {} : { counterexample: Object.keys(definition.requires).length ? { input, deps } : input }) };
        break;
      }
    }
    if (failed) { decisions.push(failed); continue; }
    if (!calls && domain.exhaustive) { decisions.push({ ...base, status: "verified", reason: "Every valid input was checked, including intermediate constructions" }); continue; }
    const scope = feasibilityScope(definition, tag);
    let remaining = ways;
    let proven = true;
    for (const path of modelPaths(decision.expression)) {
      if (--remaining < 0) { proven = false; break; }
      if (feasibilityOf(path, scope, undefined, candidates).kind === "infeasible") continue;
      const prepared = prepareExpression(path.value, definition, tag, scope, path.steps, candidates);
      if (!prepared) { proven = false; break; }
      const execution = prepared.value as { result?: unknown; effects?: unknown };
      const prove = (schema: AnySchema, value: unknown): boolean => provesValue(schema, value, prepared.scope, path.steps, candidates);
      if (!intermediates(prepared.value, prove) || !prove(definition.result, execution.result) || !Array.isArray(execution.effects) || !execution.effects.every(effect => prove(definition.effects, effect))) { proven = false; break; }
      for (const clause of definition.ensures) {
        const resultTag = isVariantsSchema(definition.result) ? tagOf(definition.result, execution.result) : undefined;
        if (clause.cases && resultTag !== undefined && !clause.cases.includes(resultTag)) continue;
        const rule = substitute(clause.rule, { input: positionTerm([], "value"), value: execution.result });
        if (!rule || !provesRule(rule, prepared.scope, path.steps, candidates)) { proven = false; break; }
      }
      if (!proven) break;
    }
    decisions.push({ ...base, status: proven ? "verified" : "undetermined", reason: proven ? "Every construction and postcondition follows from the input, path conditions, and dependency contracts" : remaining < 0 ? `Proof exceeds ${ways} paths` : "Universal construction safety could not be proved from the available contracts and conditions" });
  }
  return summarize(decisions);
}
function containsCalls(value: unknown): boolean {
  return nodeOf(value)?.kind === "call" || childrenOf(value).some(containsCalls);
}
function prepareExpression(template: unknown, definition: AnyBehavior, tag: string, originalScope: AnySchema, steps: readonly Step[], limit: number): { value: unknown; scope: AnySchema } | undefined {
  let scope = originalScope as ObjectSchema<ObjectShape>;
  let index = 0;
  let valid = true;
  function lower(value: unknown): unknown {
    const position = isTerm(value) ? positionData(value) : undefined;
    if (position?.path.length === 0 && position.measure === "value") {
      return { ...Object.fromEntries(Object.keys(definition.input.variants[tag]!.shape).map(key => [key, positionTerm([key], "value")])), [definition.input.discriminant]: tag };
    }
    const children = childrenOf(value);
    const lowered = children.length ? replaceChildren(value, children.map(lower)) : value;
    const node = nodeOf(lowered);
    if (node?.kind !== "call") return lowered;
    const declared = definition.requires[dependencyName(node.dependency)];
    const prove = (schema: AnySchema, value: unknown) => provesValue(schema, value, scope, steps, limit);
    if (declared?.takes !== "input" || !intermediates(node.input, prove) || !prove(declared.input, node.input)) {
      valid = false;
      return undefined;
    }
    let name: string;
    do { name = `#call${index++}`; } while (Object.hasOwn(scope.shape, name));
    const result = positionTerm([name], "value");
    const assumptions = (declared.injected?.behavior.ensures ?? []).flatMap(clause => {
      if (clause.cases !== undefined) return [];
      const rule = substitute(clause.rule, { input: node.input, value: result });
      return rule ? [rule] : [];
    });
    scope = { ...scope, shape: { ...scope.shape, [name]: declared.output }, invariants: [...scope.invariants, ...assumptions] };
    return result;
  }
  const value = lower(template);
  return valid ? { value, scope } : undefined;
}
function pipelineBoundary(first: AnyImplementation, second: AnyImplementation, limit: number): ConstructionProof {
  const source = first.behavior.result;
  const target = second.behavior.input;
  const departed = (first.behavior as { readonly departed?: readonly string[] }).departed ?? [];
  const verified = isVariantsSchema(source) && source.variantTags.every(tag => {
    if (departed.includes(tag) || !Object.hasOwn(target.variants, tag)) return true;
    const from = source.invariants.reduce((schema, rule) => schema.refine(rule), source.variants[tag]!);
    const to = target.invariants.reduce((schema, rule) => schema.refine(rule), target.variants[tag]!);
    if (includesSchema(to, from, limit)) return true;
    const domain = domainOf(from, limit);
    return domain.exhaustive && domain.values.every(value => target.parse({ ...(value as object), [target.discriminant]: tag }).success);
  });
  return {
    decision: `${first.behavior.name} → ${second.behavior.name}`,
    status: verified ? "verified" : "undetermined",
    reason: verified ? "Every forwarded result satisfies the next stage's input" : "The next stage's input is not proved for every forwarded result",
  };
}
function summarize(decisions: readonly ConstructionProof[]): ProofReport {
  return { status: decisions.some(item => item.status === "refuted") ? "refuted" : decisions.every(item => item.status === "verified") ? "verified" : "undetermined", decisions };
}
function intermediates(value: unknown, prove: (schema: AnySchema, value: unknown) => boolean): boolean {
  const node = nodeOf(value);
  return (node?.kind !== "construct" || prove(node.schema, node.value)) && childrenOf(value).every(child => intermediates(child, prove));
}
function provesValue(schema: AnySchema, original: unknown, scope: AnySchema, steps: readonly Step[], limit: number): boolean {
  const node = nodeOf(original);
  const value = node?.kind === "construct" ? node.value : original;
  if (!containsSymbolic(value)) return schema.parse(value).success;
  if (provesNumeric(schema, original, scope, steps)) return true;
  if (node?.kind === "operation") return false;
  if (schema.kind === "optional") return value === undefined || provesValue((schema as OptionalSchema<unknown>).schema, value, scope, steps, limit);
  if (isTerm(value)) {
    const position = positionData(value);
    if (!position || mayBeAbsent(scope, position.path)) return false;
    const source = schemaAtPath(scope, position.path);
    if (!source || position.measure !== "value" || !sameShape(schema, source, limit)) return false;
  } else if (schema.kind === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const shape = (schema as ObjectSchema<ObjectShape>).shape;
    if (Object.keys(value).some(key => !Object.hasOwn(shape, key))) return false;
    if (!Object.entries(shape).every(([key, field]) => provesValue(field, (value as Record<string, unknown>)[key], scope, steps, limit))) return false;
  } else if (isVariantsSchema(schema)) {
    const tag = tagOf(schema, value);
    if (tag === undefined) return false;
    const { [schema.discriminant]: _, ...fields } = value as Record<string, unknown>;
    const shape = schema.variants[tag]!;
    if (!provesValue(shape, Object.hasOwn(shape.shape, schema.discriminant) ? value : fields, scope, steps, limit)) return false;
  } else if (schema.kind === "array") {
    if (!Array.isArray(value) || !value.every(item => provesValue((schema as ArraySchema<unknown>).element, item, scope, steps, limit))) return false;
  } else {
    if (containsSymbolic(value)) return false;
    return schema.parse(value).success;
  }
  return schema.invariants.every(invariant => {
    const rule = substitute(invariant, value);
    return rule !== undefined && provesRule(rule, scope, steps, limit);
  });
}
function includesSchema(target: AnySchema, source: AnySchema, limit: number): boolean {
  return provesValue(target, positionTerm(["value"], "value"), object({ value: source }), [], limit);
}
function sameShape(target: AnySchema, source: AnySchema, limit: number): boolean {
  if (target === source) return true;
  if (target.kind !== source.kind) return false;
  if (target.kind === "array") return includesSchema((target as ArraySchema<unknown>).element, (source as ArraySchema<unknown>).element, limit);
  if (target.kind === "record") return includesSchema((target as RecordSchema<unknown>).value, (source as RecordSchema<unknown>).value, limit);
  if (target.kind === "object") {
    const to = (target as ObjectSchema<ObjectShape>).shape;
    const from = (source as ObjectSchema<ObjectShape>).shape;
    return Object.keys(from).every(key => Object.hasOwn(to, key)) && Object.entries(to).every(([key, field]) =>
      Object.hasOwn(from, key) ? includesSchema(field, from[key]!, limit) : field.parse(undefined).success);
  }
  if (isVariantsSchema(target) && isVariantsSchema(source)) return target.discriminant === source.discriminant && source.variantTags.every(tag =>
    Object.hasOwn(target.variants, tag) && includesSchema(target.variants[tag]!, source.variants[tag]!, limit));
  if (target.kind === "literal") return (target as LiteralSchema<any>).value === (source as LiteralSchema<any>).value;
  if (target.kind === "enum") return (source as EnumSchema<string>).values.every(value => (target as EnumSchema<string>).values.includes(value));
  if (target.kind === "decimal") return (source as DecimalSchema).scale <= (target as DecimalSchema).scale;
  if (["string", "number", "integer", "boolean", "instant", "date", "time", "datetime", "int64", "rational"].includes(target.kind)) return true;
  return false;
}
function mayBeAbsent(schema: AnySchema, path: readonly string[]): boolean {
  if (schema.kind === "optional") return true;
  if (path.length === 0) return false;
  if (schema.kind !== "object") return true;
  const child = (schema as ObjectSchema<ObjectShape>).shape[path[0]!];
  return !child || mayBeAbsent(child, path.slice(1));
}
function containsSymbolic(value: unknown): boolean {
  return isTerm(value) || nodeOf(value) !== undefined || childrenOf(value).some(containsSymbolic);
}
function provesRule(rule: Rule, scope: AnySchema, steps: readonly Step[], limit: number): boolean {
  if (termPaths(rule).length === 0) return holds(rule, {});
  const facts = scopeFacts(scope);
  let remaining = limit;
  for (const outcome of outcomesOf(rule)) {
    if (--remaining < 0) return false;
    if (!outcome.result && feasibilityOf({ steps: [...facts, ...steps, ...outcome.steps] }, scope, undefined, limit).kind !== "infeasible") return false;
  }
  return true;
}
function scopeFacts(scope: AnySchema): Step[] {
  const facts: Step[] = [];
  const add = (rule: Rule, outcome = true): void => {
    if (rule.kind === "not") add(rule.rule, !outcome);
    else if (rule.kind === "and" && outcome || rule.kind === "or" && !outcome) rule.rules.forEach(part => add(part, outcome));
    else if (rule.kind === "compare" || rule.kind === "all" || rule.kind === "any") facts.push({ distinction: rule, outcome });
  };
  const visit = (schema: AnySchema, path: readonly string[], ancestors: ReadonlySet<AnySchema>): void => {
    if (ancestors.has(schema)) return;
    for (const invariant of schema.invariants.flatMap(conjuncts)) {
      const rule = substitute(invariant, positionTerm(path, "value"));
      if (rule) add(rule);
    }
    if (schema.kind === "object") {
      const parents = new Set([...ancestors, schema]);
      for (const [key, child] of Object.entries((schema as ObjectSchema<ObjectShape>).shape)) {
        if (child.kind !== "optional") visit(child, [...path, key], parents);
      }
    }
  };
  visit(scope, [], new Set());
  return facts;
}
function substitute(rule: Rule, template: unknown, bound: ReadonlySet<string> = new Set()): Rule | undefined {
  const missing = Symbol();
  function operand(value: unknown): unknown {
    if (!isTerm(value)) return value;
    const position = positionData(value);
    if (!position) return missing;
    if (position.path.length && bound.has(position.path[0]!)) return value;
    let resolved = template;
    for (let index = 0; index < position.path.length; index++) {
      if (isTerm(resolved)) {
        const source = positionData(resolved);
        return source && source.measure === "value" ? positionTerm([...source.path, ...position.path.slice(index)], position.measure) : missing;
      }
      const node = nodeOf(resolved);
      if (node?.kind === "construct") resolved = node.value;
      if (resolved === null || typeof resolved !== "object") return missing;
      resolved = (resolved as Record<string, unknown>)[position.path[index]!];
    }
    if (position.measure === "length") {
      if (isTerm(resolved)) {
        const source = positionData(resolved);
        return source && source.measure === "value" ? positionTerm(source.path, "length") : missing;
      }
      return resolved !== undefined && resolved !== null && !containsSymbolic(resolved) ? sizeOf(resolved) : missing;
    }
    return nodeOf(resolved) ? missing : resolved;
  }
  if (rule.kind === "compare") {
    const left = operand(rule.left), right = operand(rule.right);
    return left === missing || right === missing || left === undefined || right === undefined ? undefined : { ...rule, left, right };
  }
  if (rule.kind === "all" || rule.kind === "any") {
    const of = operand(rule.of);
    if (!isTerm(of)) return undefined;
    const each = substitute(rule.each, template, new Set([...bound, rule.element]));
    return each ? { ...rule, of: of as typeof rule.of, each } : undefined;
  }
  if (rule.kind === "not") { const part = substitute(rule.rule, template, bound); return part ? { ...rule, rule: part } : undefined; }
  if (rule.kind === "and" || rule.kind === "or") {
    const parts = rule.rules.map(part => substitute(part, template, bound));
    return parts.every((part): part is Rule => part !== undefined) ? { ...rule, rules: parts } : undefined;
  }
  return undefined;
}
