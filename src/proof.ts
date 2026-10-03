import { EvaluationLimit } from "./exact.js";
import { provesNumeric } from "./interval.js";
import type { AnyImplementation } from "./behavior.js";
import { brokenEnsures } from "./behavior.js";
import { constantsOf, domainOf } from "./domain.js";
import { feasibilityOf } from "./feasibility.js";
import { feasibilityScope } from "./guard-borders.js";
import { childrenOf, interpret, modelPaths, nodeOf } from "./model.js";
import type { Rule } from "./rule.js";
import { isTerm, positionData, positionTerm, sizeOf, withDeps } from "./rule.js";
import type { AnySchema, DecimalSchema, ArraySchema, ObjectSchema, ObjectShape, OptionalSchema } from "./schema.js";
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
    if (Object.values(definition.requires).some(dependency => dependency.takes === "input")) {
      decisions.push({ ...base, status: "undetermined", reason: "Dependency domains are not proven" });
      continue;
    }
    const domain = domainOf(object({ input: definition.input, deps: object(Object.fromEntries(Object.entries(definition.requires).map(([name, dependency]) => [name, dependency.output]))) }), candidates, constantsOf(decision.guards.map(guard => guard.condition)));
    let failed: ConstructionProof | undefined;
    for (const candidate of domain.values) {
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
    if (domain.exhaustive) { decisions.push({ ...base, status: "verified", reason: "Every valid input was checked, including intermediate constructions" }); continue; }
    const scope = feasibilityScope(definition, tag);
    let remaining = ways;
    let proven = true;
    for (const path of modelPaths(decision.expression)) {
      if (--remaining < 0) { proven = false; break; }
      if (feasibilityOf(path, scope, undefined, candidates).kind === "infeasible") continue;
      const execution = path.value as { result?: unknown; effects?: unknown };
      const prove = (schema: AnySchema, value: unknown): boolean => provesValue(schema, value, scope, path.steps, candidates);
      if (!intermediates(path.value, prove) || !prove(definition.result, execution.result) || !Array.isArray(execution.effects) || !execution.effects.every(effect => prove(definition.effects, effect))) { proven = false; break; }
      for (const clause of definition.ensures) {
        const resultTag = isVariantsSchema(definition.result) ? tagOf(definition.result, execution.result) : undefined;
        if (clause.cases && resultTag !== undefined && !clause.cases.includes(resultTag)) continue;
        const rule = substitute(clause.rule, { input: positionTerm([], "value"), value: execution.result });
        if (!rule || !provesRule(rule, scope, path.steps, candidates)) { proven = false; break; }
      }
      if (!proven) break;
    }
    decisions.push({ ...base, status: proven ? "verified" : "undetermined", reason: proven ? "Every construction and postcondition follows from the input and path conditions" : remaining < 0 ? `Proof exceeds ${ways} paths` : "Sampled inputs passed, but universal construction safety could not be proved" });
  }
  return summarize(decisions);
}
function pipelineBoundary(first: AnyImplementation, second: AnyImplementation, limit: number): ConstructionProof {
  const source = first.behavior.result;
  const target = second.behavior.input;
  const departed = (first.behavior as { readonly departed?: readonly string[] }).departed ?? [];
  const verified = isVariantsSchema(source) && source.variantTags.every(tag => {
    if (departed.includes(tag) || !Object.hasOwn(target.variants, tag)) return true;
    const from = source.variants[tag]!;
    const to = target.variants[tag]!;
    if (from === to && target.invariants.length === 0) return true;
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
  if (provesNumeric(schema, original, scope, steps)) return true;
  if (node?.kind === "operation") return false;
  if (schema.kind === "optional") return value === undefined || provesValue((schema as OptionalSchema<unknown>).schema, value, scope, steps, limit);
  if (isTerm(value)) {
    const position = positionData(value);
    if (!position || mayBeAbsent(scope, position.path)) return false;
    const source = schemaAtPath(scope, position.path);
    if (!source || position.measure !== "value" || !sameShape(schema, source)) return false;
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
function sameShape(target: AnySchema, source: AnySchema): boolean {
  if (target === source) return true;
  if (target.kind !== source.kind) return false;
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
  let remaining = limit;
  for (const outcome of outcomesOf(rule)) {
    if (--remaining < 0) return false;
    if (!outcome.result && feasibilityOf({ steps: [...steps, ...outcome.steps] }, scope, undefined, limit).kind !== "infeasible") return false;
  }
  return true;
}
function substitute(rule: Rule, template: unknown): Rule | undefined {
  const missing = Symbol();
  function operand(value: unknown): unknown {
    if (!isTerm(value)) return value;
    const position = positionData(value);
    if (!position) return missing;
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
  if (rule.kind === "not") { const part = substitute(rule.rule, template); return part ? { ...rule, rule: part } : undefined; }
  if (rule.kind === "and" || rule.kind === "or") {
    const parts = rule.rules.map(part => substitute(part, template));
    return parts.every((part): part is Rule => part !== undefined) ? { ...rule, rules: parts } : undefined;
  }
  return undefined;
}
