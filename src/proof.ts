import { EvaluationLimit } from "./exact.js";
import { provesNumeric, provesTemporal } from "./interval.js";
import type { AnyBehavior, AnyImplementation } from "./behavior.js";
import { brokenEnsures } from "./behavior.js";
import { constantsOf, domainOf } from "./domain.js";
import { feasibilityOf } from "./feasibility.js";
import { feasibilityScope } from "./guard-borders.js";
import { childrenOf, localRoots, dependencyName, interpret, modelDependencyIssue, modelPaths, nodeOf, replaceChildren } from "./model.js";
import type { Rule } from "./rule.js";
import { conjuncts, describeRule, holds, isTerm, positionData, positionOf, positionTerm, termPaths, rootsRead, withDeps, measured } from "./rule.js";
import type { AnySchema, AnyVariantsSchema, DecimalSchema, ArraySchema, ObjectSchema, ObjectShape, OptionalSchema, RecordSchema, EnumSchema, LiteralSchema } from "./schema.js";
import { isVariantsSchema, schemaAtPath, tagOf, object, literal, array } from "./schema.js";
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
    const written = decision.runs ?? decision.expression;
    const dependencyIssue = modelDependencyIssue(written, definition, [tag]);
    if (dependencyIssue) { decisions.push({ ...base, status: "undetermined", reason: dependencyIssue }); continue; }
    const calls = containsCalls(written);
    const domain = domainOf(object({ input: definition.input, deps: object(Object.fromEntries(Object.entries(definition.dependencies).filter(([, dependency]) => dependency.takes === "nothing").map(([name, dependency]) => [name, dependency.output]))) }), candidates, constantsOf(decision.guards.map(guard => guard.condition)));
    let failed: ConstructionProof | undefined;
    for (const candidate of calls ? [] : domain.values) {
      const { input, deps } = candidate as { input: unknown; deps: unknown };
      if (tagOf(definition.input, input) !== tag) continue;
      try {
        const execution = interpret(written, withDeps(input, Object.keys(definition.dependencies).length ? deps : undefined)) as { result: unknown; effects: readonly unknown[] };
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
        failed = { ...base, status: error instanceof EvaluationLimit ? "undetermined" : "refuted", reason: error instanceof Error ? error.message : String(error), ...(error instanceof EvaluationLimit ? {} : { counterexample: Object.keys(definition.dependencies).length ? { input, deps } : input }) };
        break;
      }
    }
    if (failed) { decisions.push(failed); continue; }
    if (!calls && domain.exhaustive) { decisions.push({ ...base, status: "verified", reason: "Every valid input was checked, including intermediate constructions" }); continue; }
    const scope = feasibilityScope(definition, tag);
    const budget = { remaining: ways };
    let proven = true;
    for (const path of modelPaths(written)) {
      if (--budget.remaining < 0) { proven = false; break; }
      if (feasibilityOf({ steps: availableSteps(path.steps, scope) }, scope, undefined, candidates).kind === "infeasible") continue;
      const prepared = prepareExpression(path.value, definition, tag, scope, path.steps, candidates, budget);
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
    decisions.push({ ...base, status: proven ? "verified" : "undetermined", reason: proven ? "Every construction and postcondition follows from the input, path conditions, and dependency contracts" : budget.remaining < 0 ? `Proof exceeds ${ways} paths` : "Universal construction safety could not be proved from the available contracts and conditions" });
  }
  return summarize(decisions);
}
function containsCalls(value: unknown): boolean {
  return nodeOf(value)?.kind === "call" || childrenOf(value).some(containsCalls);
}
function prepareExpression(template: unknown, definition: AnyBehavior, tag: string, originalScope: AnySchema, steps: readonly Step[], limit: number, budget: { remaining: number }): { value: unknown; scope: AnySchema } | undefined {
  let scope = originalScope as ObjectSchema<ObjectShape>;
  let index = 0;
  let valid = true;
  const conditional: { root: string; cases: readonly string[]; rule: Rule; output: AnyVariantsSchema }[] = [];
  const usable = () => availableSteps(steps, scope);
  const prove = (schema: AnySchema, value: unknown) => intermediates(value, (inner, child) => provesValue(inner, child, scope, usable(), limit)) && provesValue(schema, value, scope, usable(), limit);
  function fresh(schema: AnySchema): ReturnType<typeof positionTerm> {
    let name: string;
    do { name = `#call${index++}`; } while (Object.hasOwn(scope.shape, name));
    scope = { ...scope, shape: { ...scope.shape, [name]: schema } };
    return positionTerm([name], "value");
  }
  function activate(): void {
    for (const item of conditional) {
      const selected = selectedTag(item.output, [item.root], usable());
      if (selected !== undefined && item.cases.includes(selected) && !scope.invariants.includes(item.rule)) scope = { ...scope, invariants: [...scope.invariants, item.rule] };
    }
  }
  function lower(value: unknown): unknown {
    if (!valid) return undefined;
    const position = isTerm(value) ? positionData(value) : undefined;
    if (position?.path.length === 0 && position.measure === "value") {
      return { ...Object.fromEntries(Object.keys(definition.input.variants[tag]!.shape).map(key => [key, positionTerm([key], "value")])), [definition.input.discriminant]: tag };
    }
    const original = nodeOf(value);
    if (original?.kind === "bind") {
      const bound = lower(original.value);
      if (!prove(original.schema, bound)) { valid = false; return undefined; }
      const source = isTerm(bound) ? positionData(bound) : undefined;
      const aliases = Object.fromEntries(Object.keys(scope.shape).map(key => [key, positionTerm([key], "value")]));
      if (source?.path.length === 1) aliases[source.path[0]!] = positionTerm([original.name], "value");
      const assumptions = source?.path.length === 1 ? scope.invariants.filter(rule => rootsRead(rule).has(source.path[0])).flatMap(rule => { const copy = substitute(rule, aliases); return copy ? [copy] : []; }) : [];
      scope = { ...scope, shape: { ...scope.shape, [original.name]: selectedCase(original.schema, [original.name], steps) }, invariants: [...scope.invariants, ...assumptions] };
      if (source?.path.length === 1) for (const item of [...conditional]) {
        if (item.root !== source.path[0]) continue;
        const rule = substitute(item.rule, aliases);
        if (rule) conditional.push({ ...item, root: original.name, rule });
      }
      activate();
      return lower(original.body);
    }
    if (original?.kind === "map" || original?.kind === "fold") {
      const values = lower(original.values);
      if (!prove(array(original.element), values)) { valid = false; return undefined; }
      if (original.kind === "fold" && !prove(original.output, lower(original.initial))) { valid = false; return undefined; }
      const bodyScope = { ...scope, shape: { ...scope.shape, [original.name]: original.element, ...(original.kind === "fold" ? { [original.accumulator]: original.output } : {}) } };
      for (const path of modelPaths(original.body)) {
        if (--budget.remaining < 0) { valid = false; return undefined; }
        const bodySteps = [...usable(), ...path.steps];
        if (feasibilityOf({ steps: availableSteps(bodySteps, bodyScope) }, bodyScope, undefined, limit).kind === "infeasible") continue;
        const prepared = prepareExpression(path.value, definition, tag, bodyScope, bodySteps, limit, budget);
        if (!prepared || !intermediates(prepared.value, (schema, child) => provesValue(schema, child, prepared.scope, bodySteps, limit)) || !provesValue(original.output, prepared.value, prepared.scope, bodySteps, limit)) { valid = false; return undefined; }
      }
      return fresh(original.kind === "map" ? array(original.output) : original.output);
    }
    const children = childrenOf(value);
    const lowered = children.length ? replaceChildren(value, children.map(lower)) : value;
    const node = nodeOf(lowered);
    if (node?.kind !== "call") return lowered;
    const name = dependencyName(node.dependency);
    const declared = Object.hasOwn(definition.dependencies, name) ? definition.dependencies[name] : undefined;
    if (declared?.takes !== "input" || !prove(declared.input, node.input)) {
      valid = false;
      return undefined;
    }
    const result = fresh(declared.output);
    const resultName = positionData(result)!.path[0]!;
    for (const clause of declared.injected?.behavior.ensures ?? []) {
      const rule = substitute(clause.rule, { input: node.input, value: result });
      if (!rule) continue;
      if (clause.cases === undefined) scope = { ...scope, invariants: [...scope.invariants, rule] };
      else if (isVariantsSchema(declared.output)) conditional.push({ root: resultName, cases: clause.cases, rule, output: declared.output });
    }
    return result;
  }
  const value = lower(template);
  return valid ? { value, scope } : undefined;
}
function availableSteps(steps: readonly Step[], scope: AnySchema): readonly Step[] {
  return steps.filter(step => localRoots(step.distinction).every(name => schemaAtPath(scope, [name]) !== undefined));
}
function selectedCase(schema: AnySchema, path: readonly string[], steps: readonly Step[]): AnySchema {
  if (!isVariantsSchema(schema)) return schema;
  const selected = selectedTag(schema, path, steps);
  return selected === undefined ? schema : taggedCase(schema, selected);
}
export function selectedTag(schema: AnyVariantsSchema, path: readonly string[], steps: readonly Step[]): string | undefined {
  let candidates = schema.variantTags as readonly string[];
  for (const step of steps) {
    const rule = step.distinction;
    if (rule.kind !== "compare" || rule.operator !== "==" && rule.operator !== "!=") continue;
    for (const [left, right] of [[rule.left, rule.right], [rule.right, rule.left]]) {
      const position = isTerm(left) ? positionData(left) : undefined;
      if (position?.measure !== "value" || position.path.length !== path.length + 1 || !path.every((key, index) => key === position.path[index]) || position.path.at(-1) !== schema.discriminant || typeof right !== "string") continue;
      const equal = (rule.operator === "==") === (step.outcome === true);
      candidates = candidates.filter(tag => (tag === right) === equal);
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function pipelineBoundary(first: AnyImplementation, second: AnyImplementation, limit: number): ConstructionProof {
  const source = first.behavior.result;
  const target = second.behavior.input;
  const departed = (first.behavior as { readonly departed?: readonly string[] }).departed ?? [];
  const verified = isVariantsSchema(source) && source.variantTags.every(tag => {
    if (departed.includes(tag) || !Object.hasOwn(target.variants, tag)) return true;
    const from = taggedCase(source, tag);
    const to = taggedCase(target, tag);
    if (includesSchema(to, from, limit)) return true;
    const domain = domainOf(from, limit);
    return domain.exhaustive && domain.values.every(value => target.parse(value).success);
  });
  return {
    decision: `${first.behavior.name} → ${second.behavior.name}`,
    status: verified ? "verified" : "undetermined",
    reason: verified ? "Every forwarded result satisfies the next stage's input" : "The next stage's input is not proved for every forwarded result",
  };
}
export function taggedCase(sum: AnyVariantsSchema, tag: string): ObjectSchema<ObjectShape> {
  const variant = sum.variants[tag] as ObjectSchema<ObjectShape>;
  const own = Object.hasOwn(variant.shape, sum.discriminant) ? variant.shape[sum.discriminant] : undefined;
  // The sum always carries its tag, so a discriminant a case declares as optional is read as present.
  const declared = own?.kind === "optional" ? presentSchema(own as OptionalSchema<unknown>) : own;
  const discriminant = declared ? declared.refine(value => ({ kind: "compare", left: value, operator: "==", right: tag })) : literal(tag);
  const schema = object({ ...variant.shape, [sum.discriminant]: discriminant });
  const invariants = [...variant.invariants, ...sum.invariants];
  try {
    return invariants.reduce((current, rule) => current.refine(() => rule), schema);
  } catch {
    // An invariant reading a field only another case declares was checked against the whole sum; declaring it again on this case would refuse the read.
    return { ...schema, invariants } as ObjectSchema<ObjectShape>;
  }
}
function summarize(decisions: readonly ConstructionProof[]): ProofReport {
  return { status: decisions.some(item => item.status === "refuted") ? "refuted" : decisions.every(item => item.status === "verified") ? "verified" : "undetermined", decisions };
}
function intermediates(value: unknown, prove: (schema: AnySchema, value: unknown) => boolean): boolean {
  const node = nodeOf(value);
  return (node?.kind !== "construct" || prove(node.schema, node.value)) && childrenOf(value).every(child => intermediates(child, prove));
}
// The scope with each sum field the steps settle to one case read as that case,
// so a field of the case is reached under a choice on its discriminant.
function narrowedBy(scope: AnySchema, steps: readonly Step[], path: readonly string[] = []): AnySchema {
  if (scope.kind !== "object") return scope;
  const { shape } = scope as ObjectSchema<ObjectShape>;
  let changed = false;
  const narrowed = Object.fromEntries(Object.entries(shape).map(([key, field]) => {
    const at = [...path, key];
    const selected = isVariantsSchema(field) ? selectedTag(field, at, steps) : undefined;
    const next = selected !== undefined ? narrowedBy(taggedCase(field as AnyVariantsSchema, selected), steps, at) : narrowedBy(field, steps, at);
    if (next !== field) changed = true;
    return [key, next];
  }));
  if (!changed) return scope;
  // The invariants were checked against the whole sum; declaring them again on the narrowed shape would refuse a read the case leaves out.
  return { ...scope, shape: narrowed } as AnySchema;
}
function provesValue(schema: AnySchema, original: unknown, unnarrowed: AnySchema, steps: readonly Step[], limit: number): boolean {
  const scope = narrowedBy(unnarrowed, steps);
  const node = nodeOf(original);
  const value = node?.kind === "construct" ? node.value : original;
  if (!containsSymbolic(value)) return schema.parse(value).success;
  if (provesNumeric(schema, original, scope, steps) || provesTemporal(schema, original, scope, steps)) return true;
  if (node?.kind === "operation" || node?.kind === "temporal") return false;
  if (schema.kind === "optional") return provesValue(presentSchema(schema as OptionalSchema<unknown>), value, scope, steps, limit);
  let held: ReadonlySet<string> = new Set();
  let invariants = schema.invariants;
  if (isTerm(value)) {
    const position = positionData(value);
    if (!position || mayBeAbsent(scope, position.path)) return false;
    const read = schemaAtPath(scope, position.path);
    // A sum the steps settled reads as its case; the target is held to that case.
    const settled = read !== undefined && isVariantsSchema(schema) && read.kind === "object" ? settledTag(schema, read) : undefined;
    const target = settled === undefined ? schema : taggedCase(schema as AnyVariantsSchema, settled);
    const source = read;
    if (!source || position.measure !== "value" || !sameShape(target, source, limit)) return false;
    invariants = target.invariants;
    // An invariant the source declares as well holds of the value read from it.
    held = new Set(source.invariants.map(identityOf));
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
  return invariants.every(invariant => {
    if (held.has(identityOf(invariant))) return true;
    const rule = substitute(invariant, value);
    return rule !== undefined && provesRule(rule, scope, steps, limit);
  });
}
// The rendered text alone cannot tell the key "a.b" from the path a.b, so the paths read are part of the identity.
export function identityOf(rule: Rule): string {
  return `${describeRule(rule, "$")} ${JSON.stringify(pathsWithin(rule))} ${constantsWithin(rule).join(",")}`;
}
// The constants a rule compares with, each with the type that carries it: 1n and a rational one render alike but accept different values.
function constantsWithin(rule: Rule): readonly string[] {
  switch (rule.kind) {
    case "compare": return [rule.left, rule.right].filter(operand => !isTerm(operand)).map(value => `${typeof value}:${(value as { constructor?: { name?: string } } | null)?.constructor?.name ?? ""}:${String(value)}`);
    case "relation": return isTerm(rule.other) ? [] : [`${typeof rule.other}:${JSON.stringify(rule.other, (_key, value) => typeof value === "bigint" ? `${value}n` : value)}`];
    case "all":
    case "any": return constantsWithin(rule.each);
    case "and":
    case "or": return rule.rules.flatMap(constantsWithin);
    case "not": return constantsWithin(rule.rule);
  }
}
// Every path the rule reads, those under a quantifier's element too, which pathsRead leaves out.
function pathsWithin(rule: Rule): readonly (readonly string[])[] {
  switch (rule.kind) {
    case "compare":
    case "relation": return termPaths(rule);
    case "all":
    case "any": return [positionOf(rule.of).path, ...pathsWithin(rule.each)];
    case "and":
    case "or": return rule.rules.flatMap(pathsWithin);
    case "not": return pathsWithin(rule.rule);
  }
}
function includesSchema(target: AnySchema, source: AnySchema, limit: number): boolean {
  if (source.kind === "optional") {
    if (source.parse(undefined).success && !target.parse(undefined).success) return false;
    return includesSchema(target, presentSchema(source as OptionalSchema<unknown>), limit);
  }
  if (target.kind === "optional") return includesSchema(presentSchema(target as OptionalSchema<unknown>), source, limit);
  if (source.kind === "literal" || source.kind === "enum") {
    const domain = domainOf(source, limit);
    if (domain.exhaustive) return domain.values.every(value => target.parse(value).success);
  }
  return provesValue(target, positionTerm(["value"], "value"), object({ value: source }), [], limit);
}
function settledTag(sum: AnyVariantsSchema, read: AnySchema): string | undefined {
  const discriminant = (read as ObjectSchema<ObjectShape>).shape[sum.discriminant];
  return sum.variantTags.find(tag => discriminant?.parse(tag).success && Object.hasOwn(sum.variants, tag) &&
    sum.variantTags.filter(other => discriminant.parse(other).success).length === 1);
}
function presentSchema(schema: OptionalSchema<unknown>): AnySchema {
  return schema.invariants.reduce((present, rule) => present.refine(() => rule), schema.schema);
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
  if (target.kind === "decimal") {
    const [from, into] = [(source as DecimalSchema).scale, (target as DecimalSchema).scale];
    return into === undefined || (from !== undefined && from <= into);
  }
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
    // A length, or a transformed value, is read off what the template holds, never taken for it.
    if (position.measure !== "value") {
      if (isTerm(resolved)) {
        const source = positionData(resolved);
        return source && source.measure === "value" ? positionTerm(source.path, position.measure) : missing;
      }
      return resolved !== undefined && resolved !== null && !containsSymbolic(resolved) ? measured(resolved, position.measure) : missing;
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
