import { compatibleBound } from "./bounds.js";
import { isRational } from "./exact.js";
import { answersOf, iterationsOf, localsOf } from "./model.js";
import { casesLeft, factsOf } from "./absence.js";
import type { AnyBehavior, RulesDecision } from "./behavior.js";
import type { CompareRule, ElementLabels, Rule, Term } from "./rule.js";
import { DEPS, conjuncts, describeRule, holds, isTerm, normalize, stepInto, pathsRead, positionData, positionOf, positionTerm, localLabel, rebaseRule } from "./rule.js";
import { enumOf, holdsNoDecimal, isVariantsSchema, object, offGridEquality, schemaAtPath, tagOf, variants } from "./schema.js";
import type { AnySchema, ArraySchema, DecimalSchema, AnyVariantsSchema, ObjectSchema, ObjectShape, OptionalSchema } from "./schema.js";

// The case a decision reads: its fields, the value dependencies under #deps, and
// each dependency's answer a model binds under its local's name. No row writes an
// answer; it may be any value the dependency declares it answers, and its ensures
// relate it to the argument the call is made with.
export function guardScope(
  definition: AnyBehavior,
  tag: string,
  decision?: { readonly expression?: unknown },
  steps: readonly { readonly distinction: unknown; readonly outcome: boolean | string }[] = [],
): AnySchema {
  const variant = definition.input.variants[tag] as ObjectSchema<ObjectShape>;
  const values = Object.entries(definition.dependencies).flatMap(([name, declared]) =>
    declared.takes === "nothing" ? [[name, declared.output as AnySchema] as const] : [],
  );
  const answers = decision?.expression === undefined ? [] : answersOf(decision.expression);
  const locals = decision?.expression === undefined ? [] : localsOf(decision.expression);
  if (values.length === 0 && answers.length === 0 && locals.length === 0) {
    return variant;
  }
  const deps = values.length === 0 ? {} : { [DEPS]: { ...object(Object.fromEntries(values)) } as AnySchema };
  const answered = answers.map(answer => {
    const declared = Object.hasOwn(definition.dependencies, answer.dependency) ? definition.dependencies[answer.dependency] : undefined;
    return [answer.name, declared?.takes === "input" ? answerSchema(declared.output as AnySchema, answer.schema as AnySchema) : answer.schema as AnySchema] as const;
  });
  const ensured = answers.flatMap(answer => {
    const declared = Object.hasOwn(definition.dependencies, answer.dependency) ? definition.dependencies[answer.dependency] : undefined;
    const output = declared?.takes === "input" ? declared.output as AnySchema : undefined;
    const facts = steps.flatMap(step =>
      typeof step.outcome === "boolean" && isRule(step.distinction) ? factsOf(step.distinction, step.outcome) : []);
    const left = output !== undefined && isVariantsSchema(output) ? casesLeft(output, [answer.name], facts) : undefined;
    return (declared?.takes === "input" ? declared.injected?.behavior.ensures ?? [] : []).flatMap(clause =>
      clause.cases !== undefined && left !== undefined && left.every(tag => !clause.cases!.includes(tag))
        ? []
        : answeredEnsures(clause.rule, clause.cases !== undefined && left !== undefined && left.every(tag => clause.cases!.includes(tag)) ? undefined : clause.cases, answer.name, answer.input, output));
  });
  return {
    ...variant,
    shape: { ...variant.shape, ...deps, ...Object.fromEntries(locals.map(local => [local.name, local.schema])), ...Object.fromEntries(answered) },
    invariants: [...variant.invariants, ...ensured],
  } as AnySchema;
}

// What a call's answer may be once bound: a value the dependency declares it
// answers that the schema it is bound under also takes. A sum keeps the cases
// both declare, each as the binding declares it; anything else is the declared
// output held to the binding's own invariants too.
export function answerSchema(output: AnySchema, bound: AnySchema): AnySchema {
  if (output === bound) return output;
  if (isVariantsSchema(output) && isVariantsSchema(bound) && output.discriminant === bound.discriminant) {
    const tags = (bound.variantTags as readonly string[]).filter(tag => (output.variantTags as readonly string[]).includes(tag));
    if (tags.length === 0) return output;
    try {
      const both = variants(bound.discriminant, Object.fromEntries(tags.map(tag => [tag, bound.variants[tag]!])));
      return [...output.invariants, ...bound.invariants].reduce<AnySchema>((schema, rule) => schema.refine(() => rule) as AnySchema, both as AnySchema);
    } catch {
      return bound;
    }
  }
  return output.kind === bound.kind ? bound.invariants.reduce<AnySchema>((schema, rule) => schema.refine(() => rule) as AnySchema, output) : output;
}

export function isRule(value: unknown): value is Rule {
  const kind = (value as { readonly kind?: unknown } | null)?.kind;
  return ["compare", "and", "or", "not", "all", "any"].includes(kind as string);
}

// A dependency's ensures read of one call: `value` is the answer's local, and
// `input` the input fields the argument is written with. A clause naming cases
// holds where the answer is of another case. A clause reading a part of the
// argument that is not an input field is left out.
export function answeredEnsures(rule: Rule, cases: readonly string[] | undefined, local: string, argument: unknown, output: AnySchema | undefined): readonly Rule[] {
  const argumentAt = (keys: readonly string[]): readonly string[] | undefined => {
    let at: unknown = argument;
    for (const [index, key] of keys.entries()) {
      if (isTerm(at)) {
        const data = positionData(at);
        return data?.measure === "value" ? [...data.path, ...keys.slice(index)] : undefined;
      }
      if (at === null || typeof at !== "object" || !Object.hasOwn(at, key)) return undefined;
      at = (at as Record<string, unknown>)[key];
    }
    const data = isTerm(at) ? positionData(at) : undefined;
    return data?.measure === "value" ? data.path : undefined;
  };
  const move = (path: readonly string[]): readonly string[] | undefined =>
    path[0] === "value" ? [local, ...path.slice(1)] : path[0] === "input" ? argumentAt(path.slice(1)) : undefined;
  if (pathsRead(rule).some(path => move(path) === undefined)) return [];
  const read = rebaseRule(rule, path => move(path)!);
  if (cases === undefined || output === undefined || !isVariantsSchema(output)) return [read];
  const otherCase: Rule = {
    kind: "and",
    rules: cases.map(tag => ({ kind: "compare", left: positionTerm([local, output.discriminant], "value"), operator: "!=", right: tag })),
  };
  return [{ kind: "or", rules: [otherCase, read] }];
}

// Guards are read here rather than through offGridEquality, since a guard's
// terms reach the dependencies and are located through the guard's frames.
export function describeConstant(value: unknown): string {
  if (isRational(value)) return `the rational ${value.toString()}`;
  if (typeof value === "bigint") return `${value}n`;
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

export function offGridEqualityIn(
  definition: AnyBehavior,
  tag: string,
  decision: RulesDecision<unknown, unknown, unknown, unknown>,
): string | undefined {
  const frames = framesFor(definition, tag, decision);
  for (const threshold of decision.guards.flatMap(candidate => thresholdsIn(candidate.condition, frames))) {
    const { operator, bound } = normalize(threshold.rule)!;
    const kind = threshold.schema.kind;
    if ((kind === "number" || kind === "integer") && typeof bound === "number" && !Number.isFinite(bound)) {
      return `compares ${threshold.label} with ${String(bound)}, which no ${kind === "integer" ? "integer" : "number"} is, so it settles without a value: ${threshold.described}`;
    }
    if (!compatibleBound(bound, kind)) {
      return `compares ${threshold.label}, a ${threshold.schema.kind}, with ${describeConstant(bound)}, which it is never compared with: ${threshold.described}`;
    }
    if (holdsNoDecimal(threshold.schema, operator, bound)) {
      const scale = (threshold.schema as DecimalSchema).scale;
      return `compares ${threshold.label} with ${String(bound)}, which no decimal(${scale}) holds: ${threshold.described}`;
    }
  }
  const scope = guardScope(definition, tag, decision);
  return decision.guards
    .map(candidate => offGridEquality(candidate.condition, path => schemaAtPath(scope, path), "$"))
    .find(found => found !== undefined);
}

export interface Frame {
  readonly scope: AnySchema;
  readonly path: string;
  readonly segments: readonly string[];
  readonly label: string;
}

export interface Frames {
  readonly root: Frame;
  readonly elements: Readonly<Record<string, Frame>>;
}

export function framesAt(scope: AnySchema, path: string, label: string): Frames {
  return { root: { scope, path, segments: [path], label }, elements: {} };
}

// The frames a decision's conditions are read in: an element of a map or a fold
// over an array the input holds stands at that array's element position, as an
// element of `$all` does, so a border on it is drawn and composed there.
export function framesFor(definition: AnyBehavior, tag: string, decision: { readonly expression?: unknown }): Frames {
  let frames = framesAt(guardScope(definition, tag, decision), `@${tag}`, "$");
  for (const iteration of decision.expression === undefined ? [] : iterationsOf(decision.expression)) {
    const values = iteration.values;
    const position = isTerm(values) ? positionData(values) : undefined;
    if (position === undefined || position.measure !== "value" || position.path[0] === DEPS) continue;
    const { frame, keys } = locate(values as Term<unknown>, frames);
    if (keys[0]?.startsWith("#local:") && frames.elements[keys[0]] === undefined) continue;
    const collection = schemaAt(frame.scope, keys);
    if (collection?.kind !== "array") continue;
    const suffix = keys.map(key => `.${key}`).join("");
    frames = {
      root: frames.root,
      elements: {
        ...frames.elements,
        [iteration.name]: {
          scope: (collection as ArraySchema<unknown>).element,
          path: `${pathOf(frame, keys)}[]`,
          segments: [...segmentsOf(frame, keys), "[]"],
          label: `${frame.label}${suffix}[]`,
        },
      },
    };
  }
  return frames;
}

export function locate(
  term: Term<unknown>,
  frames: Frames,
): { readonly frame: Frame; readonly keys: readonly string[] } {
  const keys = positionOf(term).path;
  const element = keys[0] === undefined ? undefined : frames.elements[keys[0]];
  return element === undefined
    ? { frame: frames.root, keys }
    : { frame: element, keys: keys.slice(1) };
}

export function enter(rule: Rule & { readonly kind: "all" | "any" }, frames: Frames): Frames | undefined {
  const { frame, keys } = locate(rule.of, frames);
  const collection = schemaAt(frame.scope, keys);
  if (collection?.kind !== "array") {
    return undefined;
  }
  const suffix = keys.map(key => `.${key}`).join("");
  return {
    root: frames.root,
    elements: {
      ...frames.elements,
      [rule.element]: {
        scope: (collection as ArraySchema<unknown>).element,
        path: `${frame.path}${suffix}[]`,
        segments: [...segmentsOf(frame, keys), "[]"],
        label: `${frame.label}${suffix}[]`,
      },
    },
  };
}

export function labelsOf(frames: Frames): ElementLabels {
  return Object.fromEntries(
    Object.entries(frames.elements).map(([name, frame]) => [name, frame.label]),
  );
}

export function pathOf(frame: Frame, keys: readonly string[], steps: readonly string[] = stepsOf(frame.scope, keys)): string {
  return `${frame.path}${steps.map(step => {
    if (!step.startsWith(".#local:")) return step;
    const label = localLabel(step.slice(1));
    return `.${label.startsWith("$.") ? label.slice(2) : label}`;
  }).join("")}`;
}

// The rendered path is for reports; positions are found by segments, since a
// key holding "." renders the same as the nested path it spells.
export function segmentsOf(frame: Frame, keys: readonly string[]): readonly string[] {
  return [...frame.segments, ...stepsOf(frame.scope, keys)];
}

// Every way a path can take from a scope: through each case of a sum that
// declares the next key, so a field the cases share is reached under each.
export function everyStepsOf(scope: AnySchema, keys: readonly string[]): readonly (readonly string[])[] {
  const [key, ...rest] = keys;
  if (key === undefined) return [[]];
  if (isVariantsSchema(scope) && key !== scope.discriminant) {
    const tags = (scope.variantTags as readonly string[]).filter(tag => Object.hasOwn((scope as AnyVariantsSchema).variants[tag]!.shape, key));
    if (tags.length > 0) {
      return tags.flatMap(tag => {
        const field = (scope as AnyVariantsSchema).variants[tag]!.shape[key] as AnySchema;
        return everyStepsOf(field, rest).map(more => [`@${tag}`, `.${key}`, ...more]);
      });
    }
  }
  const field = scope.kind === "object" ? (scope as ObjectSchema<ObjectShape>).shape[key] : undefined;
  return field === undefined ? [[`.${key}`, ...rest.map(next => `.${next}`)]] : everyStepsOf(field, rest).map(more => [`.${key}`, ...more]);
}

// The schema a path reaches by the steps `everyStepsOf` gave for it, so a field
// the cases of a sum share is read under the case the steps name rather than
// the first that declares it.
export function schemaAlong(scope: AnySchema, keys: readonly string[], steps: readonly string[]): AnySchema | undefined {
  let current: AnySchema | undefined = scope;
  let index = 0;
  for (const key of keys) {
    if (current?.kind === "optional") current = (current as OptionalSchema<unknown>).schema as AnySchema;
    if (current !== undefined && isVariantsSchema(current) && steps[index]?.startsWith("@")) {
      current = current.variants[steps[index]!.slice(1)] as AnySchema | undefined;
      index++;
    }
    index++;
    current = current?.kind === "object" ? (current as ObjectSchema<ObjectShape>).shape[key] : undefined;
  }
  return current;
}

// Whether a value takes the cases of the sums along a path that `steps` name.
export function onTrail(scope: AnySchema, keys: readonly string[], steps: readonly string[], value: unknown): boolean {
  let current: AnySchema | undefined = scope;
  let at: unknown = value;
  let index = 0;
  for (const key of keys) {
    if (current?.kind === "optional") current = (current as OptionalSchema<unknown>).schema as AnySchema;
    if (current !== undefined && isVariantsSchema(current) && steps[index]?.startsWith("@")) {
      const tag = steps[index]!.slice(1);
      if (tagOf(current, at) !== tag) return false;
      current = current.variants[tag] as AnySchema | undefined;
      index++;
    }
    index++;
    at = at !== null && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined;
    current = current?.kind === "object" ? (current as ObjectSchema<ObjectShape>).shape[key] : undefined;
  }
  return true;
}

// The segments a path takes from a scope, naming the case of each sum it
// passes through as the partition does (`.a`, `@given`, `.b`): the case that
// declares the next key, the first of them where several do. A sum's
// discriminant is read on the sum itself.
export function stepsOf(scope: AnySchema, keys: readonly string[]): readonly string[] {
  const steps: string[] = [];
  let current: AnySchema | undefined = scope;
  for (const key of keys) {
    if (current !== undefined && isVariantsSchema(current) && key !== current.discriminant) {
      const tag = (current.variantTags as readonly string[]).find(candidate =>
        Object.hasOwn((current as AnyVariantsSchema).variants[candidate]!.shape, key));
      if (tag !== undefined) {
        steps.push(`@${tag}`);
        current = current.variants[tag] as AnySchema;
      }
    }
    steps.push(`.${key}`);
    current = current?.kind === "object" ? (current as ObjectSchema<ObjectShape>).shape[key] : undefined;
  }
  return steps;
}

export interface Threshold {
  readonly path: string;
  readonly label: string;
  readonly described: string;
  readonly segments: readonly string[];
  readonly schema: AnySchema;
  readonly inherited: readonly Rule[];
  readonly rule: CompareRule;
}

export function thresholdsIn(rule: Rule, frames: Frames): Threshold[] {
  if (rule.kind === "and" || rule.kind === "or") {
    return rule.rules.flatMap(part => thresholdsIn(part, frames));
  }
  if (rule.kind === "not") {
    return thresholdsIn(rule.rule, frames);
  }
  if (rule.kind === "all" || rule.kind === "any") {
    const inner = enter(rule, frames);
    return inner === undefined ? [] : thresholdsIn(rule.each, inner);
  }
  const normalized = normalize(rule);
  if (rule.kind !== "compare" || normalized === undefined || normalized.measure !== "value") {
    return [];
  }
  const term = (isTerm(rule.left) ? rule.left : rule.right) as Term<unknown>;
  const { frame, keys } = locate(term, frames);
  const schema = schemaAt(frame.scope, keys);
  return schema === undefined
    ? []
    : everyStepsOf(frame.scope, keys).map(steps => ({
        path: pathOf(frame, keys, steps),
        label: keys[0]?.startsWith("#local:") ? [localLabel(keys[0]), ...keys.slice(1)].join(".") : `${frame.label}${keys.map(key => `.${key}`).join("")}`,
        described: describeRule(rule, frames.root.label, labelsOf(frames)),
        segments: [...frame.segments, ...steps],
        schema: schemaAlong(frame.scope, keys, steps) ?? schema,
        inherited: inheritedAt(frame.scope, keys),
        rule,
      }));
}

export function inheritedAt(scope: AnySchema, keys: readonly string[]): readonly Rule[] {
  const [key, ...rest] = keys;
  const unwrapped =
    scope.kind === "optional" ? (scope as OptionalSchema<unknown>).schema : scope;
  if (key === undefined || unwrapped.kind !== "object") {
    return [];
  }
  const field = (unwrapped as ObjectSchema<ObjectShape>).shape[key];
  const here = unwrapped.invariants.flatMap(conjuncts).flatMap(rule => {
    const stepped = keys.reduce<Rule | undefined>(
      (current, next) => (current === undefined ? undefined : stepInto(current, next)),
      rule,
    );
    return stepped === undefined ? [] : [stepped];
  });
  return field === undefined ? here : [...here, ...inheritedAt(field, rest)];
}

// The schema a path reaches through the case of a sum that declares the next key.
export function throughCases(schema: AnySchema, keys: readonly string[]): AnySchema | undefined {
  const unwrapped = schema.kind === "optional" ? ((schema as unknown as { schema: AnySchema }).schema) : schema;
  const [key, ...rest] = keys;
  if (key === undefined) return unwrapped;
  if (isVariantsSchema(unwrapped)) {
    const declaring = (Object.values(unwrapped.variants) as ObjectSchema<ObjectShape>[]).find(variant => Object.hasOwn(variant.shape, key));
    return declaring === undefined ? undefined : throughCases(declaring.shape[key]!, rest);
  }
  if (unwrapped.kind !== "object") return undefined;
  const { shape } = unwrapped as ObjectSchema<ObjectShape>;
  return Object.hasOwn(shape, key) ? throughCases(shape[key]!, rest) : undefined;
}

// A sum field's discriminant reads as one of its tags, as a match selects it.
export function schemaAt(schema: AnySchema, keys: readonly string[]): AnySchema | undefined {
  const found = schemaAtPath(schema, keys) ?? throughCases(schema, keys);
  if (found !== undefined || keys.length === 0) return found;
  const owner = throughCases(schema, keys.slice(0, -1));
  return owner !== undefined && isVariantsSchema(owner) && owner.discriminant === keys.at(-1)
    ? enumOf(owner.variantTags as [string, ...string[]])
    : undefined;
}
