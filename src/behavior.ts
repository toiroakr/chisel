import type { Requirements, Resolved } from "./dependency.js";
import type {
  AnyVariantsSchema,
  Infer,
  ObjectSchema,
  ObjectShape,
  OptionalSchema,
  Schema,
  Tags,
  VariantOf,
} from "./schema.js";
import type {
  CompareRule,
  ComparisonObserver,
  Distinction,
  Rule,
  Term,
  TermOf,
} from "./rule.js";
import {
  describeRule,
  holds,
  readOperand,
  rootTerm,
  selfTerm,
  depsTerm,
  withDeps,
  termData,
  rootsRead,
} from "./rule.js";
import { isVariantsSchema, schemaAtPath, tagOf } from "./schema.js";

export interface Execution<Result, Effect> {
  readonly result: Result;
  readonly effects: readonly Effect[];
}

export interface Todo {
  readonly kind: "todo";
  readonly reason: string;
}

export interface Decision<Input, Result, Effect, Deps = unknown> {
  readonly kind: "decision";
  readonly id: string;
  run(input: Input, deps: Deps): Execution<Result, Effect> | Promise<Execution<Result, Effect>>;
}

export interface Guard<Input, Result, Effect, Deps = unknown> {
  readonly kind: "guard";
  readonly condition: Rule;
  orElse(input: Input, deps: Deps): Execution<Result, Effect>;
}

export type Handler<Input, Result, Effect, Deps = unknown> = {
  bivariant(input: Input, deps: Deps): Execution<Result, Effect>;
}["bivariant"];

export interface Match<Input, Result, Effect, Deps = unknown> {
  readonly kind: "match";
  readonly on: Term<string>;
  readonly cases: Readonly<Record<string, Handler<Input, Result, Effect, Deps>>>;
}

export type Otherwise<Input, Result, Effect, Deps = unknown> =
  | Handler<Input, Result, Effect, Deps>
  | Match<Input, Result, Effect, Deps>;

export interface RulesDecision<Input, Result, Effect, Deps = unknown> {
  readonly kind: "rules";
  readonly id: string;
  readonly guards: readonly Guard<Input, Result, Effect, Deps>[];
  readonly otherwise: Otherwise<Input, Result, Effect, Deps>;
}

export type Branch = Distinction | Match<unknown, unknown, unknown>;

export interface ControlPolicy {
  readonly execution: "direct" | "outbox" | "queue";
  readonly idempotency: "required" | "not-required";
  readonly compensation: "automatic" | "manual" | "none";
  readonly exposure?: "normal" | "shadow" | "canary";
}

export type ControlTable<Effects extends AnyVariantsSchema> = Readonly<
  Partial<Record<Tags<Effects>, ControlPolicy | Todo>>
>;

export interface EnsuresClause {
  readonly name: string;
  readonly cases: readonly string[] | undefined;
  readonly rule: Rule;
}

export interface EnsuresBuilder<Input, ResultSchema extends Schema<unknown>> {
  when<Tag extends Tags<ResultSchema>>(
    name: string,
    cases: readonly Tag[],
    rule: (input: TermOf<Input>, value: TermOf<VariantOf<ResultSchema, Tag>>) => Rule,
  ): EnsuresClause;
  always(
    name: string,
    rule: (input: TermOf<Input>, value: TermOf<Infer<ResultSchema>>) => Rule,
  ): EnsuresClause;
}

export interface Behavior<
  InputSchema extends AnyVariantsSchema,
  ResultSchema extends Schema<unknown>,
  EffectSchema extends AnyVariantsSchema,
  Requires extends Requirements = {},
> {
  readonly kind: "behavior";
  readonly name: string;
  // What the behavior does, for the people reading the specification.
  readonly description?: string;
  readonly input: InputSchema;
  readonly result: ResultSchema;
  readonly effects: EffectSchema;
  readonly requires: Requires;
  readonly ensures: readonly EnsuresClause[];
  readonly disregards: Readonly<Record<string, readonly (readonly string[])[]>>;
}

type KeysOfEvery<T> = T extends unknown ? keyof T : never;

type ValueAt<T, K> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;

type Merged<T, Keys extends PropertyKey> = { readonly [K in Keys]: ValueAt<T, K> };

type Fielded<T> = Merged<T, KeysOfEvery<T>>;

type Disregarded<T> = (input: TermOf<T>) => readonly Term<unknown>[];

export type Disregards<InputSchema extends AnyVariantsSchema> = {
  readonly [Key in Tags<InputSchema> | "$default"]?: Key extends Tags<InputSchema>
    ? Disregarded<VariantOf<InputSchema, Key>>
    : Disregarded<Fielded<Infer<InputSchema>>>;
};

export type AnyBehavior = Behavior<AnyVariantsSchema, Schema<unknown>, AnyVariantsSchema, Requirements>;

export type BehaviorInput<B> = B extends { readonly input: infer Input } ? Infer<Input> : never;
export type BehaviorResult<B> = B extends { readonly result: infer Result }
  ? Infer<Result>
  : never;
export type BehaviorEffect<B> = B extends { readonly effects: infer Effect }
  ? Infer<Effect>
  : never;
export type BehaviorDeps<B> = B extends { readonly requires: infer Requires }
  ? Resolved<Requires>
  : never;

export type ImplementationCases<B extends AnyBehavior> = {
  readonly [Tag in Tags<B["input"]>]:
    | Decision<VariantOf<B["input"], Tag>, BehaviorResult<B>, BehaviorEffect<B>, BehaviorDeps<B>>
    | RulesDecision<
        VariantOf<B["input"], Tag>,
        BehaviorResult<B>,
        BehaviorEffect<B>,
        BehaviorDeps<B>
      >
    | Todo;
};

export interface Implementation<B extends AnyBehavior> {
  readonly kind: "implementation";
  readonly behavior: B;
  readonly cases: ImplementationCases<B>;
  readonly controls: ControlTable<B["effects"]>;
  readonly pipeline?: readonly [Implementation<AnyBehavior>, Implementation<AnyBehavior>];
  readonly external?: { readonly reason: string };
}

export type AnyImplementation = Implementation<AnyBehavior>;

export class SpecificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecificationError";
  }
}

export class TodoDecision extends SpecificationError {
  constructor(
    readonly behavior: string,
    readonly variant: string,
    readonly reason: string,
  ) {
    super(`The decision for ${variant} of ${behavior} is still todo: ${reason}`);
    this.name = "TodoDecision";
  }
}

export function match<Input, Result, Effect, Deps = unknown, Tag extends string = string>(
  select: (input: TermOf<Input>) => Term<Tag>,
  cases: {
    readonly [Case in Tag]: (input: Input, deps: Deps) => Execution<Result, Effect>;
  },
): Match<Input, Result, Effect, Deps> {
  return { kind: "match", on: select(selfTerm<Input>()), cases };
}

export type ValueDepsOf<Deps> = {
  readonly [K in keyof Deps as Deps[K] extends (...args: never[]) => unknown ? never : K]: Deps[K];
};

export function action<Input, Result, Effect, Deps = unknown>(
  id: string,
  body: {
    readonly guards?: (
      input: TermOf<NoInfer<Input>>,
      deps: TermOf<ValueDepsOf<NoInfer<Deps>>>,
    ) => readonly Guard<NoInfer<Input>, NoInfer<Result>, NoInfer<Effect>, NoInfer<Deps>>[];
    readonly run: Otherwise<NoInfer<Input>, NoInfer<Result>, NoInfer<Effect>, NoInfer<Deps>>;
  },
): RulesDecision<Input, Result, Effect, Deps> {
  return {
    kind: "rules",
    id,
    guards:
      body.guards?.(selfTerm<NoInfer<Input>>(), depsTerm<ValueDepsOf<NoInfer<Deps>>>()) ?? [],
    otherwise: body.run,
  };
}

export function todo(reason = "まだ決めていません"): Todo {
  return { kind: "todo", reason };
}

export function isTodo(value: unknown): value is Todo {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Readonly<Record<string, unknown>>).kind === "todo"
  );
}

export function behavior<
  const InputSchema extends AnyVariantsSchema,
  const ResultSchema extends Schema<unknown>,
  const EffectSchema extends AnyVariantsSchema,
  const Requires extends Requirements = {},
>(name: string, options: {
  readonly description?: string;
  readonly input: InputSchema;
  readonly result: ResultSchema;
  readonly effects: EffectSchema;
  readonly requires?: Requires;
  readonly ensures?: (
    clause: EnsuresBuilder<Infer<InputSchema>, ResultSchema>,
  ) => readonly EnsuresClause[];
  readonly disregards?: Disregards<NoInfer<InputSchema>>;
}): Behavior<InputSchema, ResultSchema, EffectSchema, Requires> {
  if (options.input.variantTags.includes("$default")) {
    throw new SpecificationError(`${name} cannot take a case named $default`);
  }
  const clauses = options.ensures?.(ensuresBuilder()) ?? [];
  const repeated = clauses.find(
    (clause, index) => clauses.findIndex(other => other.name === clause.name) !== index,
  );
  if (repeated !== undefined) {
    throw new SpecificationError(`Ensures ${repeated.name} is declared more than once`);
  }
  for (const clause of clauses) {
    const roots = rootsRead(clause.rule);
    if (!roots.has("input") || !roots.has("value")) {
      throw new SpecificationError(
        `Ensures ${clause.name} must relate the input to the answer`,
      );
    }
  }
  return {
    kind: "behavior",
    name,
    ...(options.description === undefined ? {} : { description: options.description }),
    input: options.input,
    result: options.result,
    effects: options.effects,
    requires: options.requires ?? ({} as Requires),
    ensures: clauses,
    disregards: disregardedPaths(name, options.input, options.disregards ?? {}),
  };
}

function disregardedPaths(
  name: string,
  input: AnyVariantsSchema,
  written: Readonly<Record<string, ((input: never) => readonly Term<unknown>[]) | undefined>>,
): Readonly<Record<string, readonly (readonly string[])[]>> {
  const pathsOf = (builder: (input: never) => readonly Term<unknown>[]) =>
    builder(selfTerm() as never).map(term => termData(term).path);
  const byDefault = written.$default === undefined ? [] : pathsOf(written.$default);
  const covered = input.variantTags.filter(tag => ownAt(written, tag) === undefined);
  const declares = (tag: string, keys: readonly string[]) =>
    reachesPath(input.variants[tag] as Schema<unknown>, keys);
  const stray = byDefault.find(keys => !covered.some(tag => declares(tag, keys)));
  if (stray !== undefined) {
    throw new SpecificationError(
      `${name} disregards ${stray.join(".")}, which no case $default covers declares`,
    );
  }
  return Object.fromEntries(
    input.variantTags.flatMap(tag => {
      const builder = ownAt(written, tag);
      if (builder !== undefined) {
        return [[tag, pathsOf(builder)]];
      }
      const paths = byDefault.filter(keys => declares(tag, keys));
      return paths.length === 0 ? [] : [[tag, paths]];
    }),
  );
}

function ensuresBuilder<Input, ResultSchema extends Schema<unknown>>(): EnsuresBuilder<
  Input,
  ResultSchema
> {
  const build = (
    name: string,
    cases: readonly string[] | undefined,
    rule: (input: never, value: never) => Rule,
  ): EnsuresClause => ({
    name,
    cases,
    rule: rule(rootTerm("input") as never, rootTerm("value") as never),
  });
  return {
    when: (name, cases, rule) => build(name, cases, rule as never),
    always: (name, rule) => build(name, undefined, rule as never),
  };
}

export function brokenEnsures(
  definition: AnyBehavior,
  input: unknown,
  result: unknown,
): EnsuresClause | undefined {
  const tag = isVariantsSchema(definition.result) ? tagOf(definition.result, result) : undefined;
  return definition.ensures.find(
    clause =>
      (clause.cases === undefined || (tag !== undefined && clause.cases.includes(tag))) &&
      !holds(clause.rule, { input, value: result }),
  );
}

type CaseDecision<B extends AnyBehavior, Input> =
  | Decision<Input, BehaviorResult<B>, BehaviorEffect<B>, BehaviorDeps<B>>
  | RulesDecision<Input, BehaviorResult<B>, BehaviorEffect<B>, BehaviorDeps<B>>
  | Todo;

export type CasesWithDefault<B extends AnyBehavior> =
  | ImplementationCases<B>
  | (Partial<ImplementationCases<B>> & {
      readonly $default: CaseDecision<B, BehaviorInput<B>>;
    });

export function implement<B extends AnyBehavior>(
  definition: B,
  options: NoInfer<{
    readonly cases: CasesWithDefault<B>;
    readonly controls?: ControlTable<B["effects"]>;
  }>,
): Implementation<NoInfer<B>> {
  const cases = casesWithoutDefault(definition, options.cases);
  const tagsOf = new Map<unknown, string[]>();
  for (const [tag, decision] of Object.entries(cases) as [string, unknown][]) {
    tagsOf.set(decision, [...(tagsOf.get(decision) ?? []), tag]);
  }
  for (const [decision, tags] of tagsOf) {
    checkMatch(definition, tags, decision as ImplementationCases<AnyBehavior>[string]);
  }
  return {
    kind: "implementation",
    behavior: definition,
    cases,
    controls: options.controls ?? ({} as ControlTable<B["effects"]>),
  };
}

// Not schemaAtPath: that stops at a sum so a match selects its discriminant,
// while a term reaches a field through a nested sum any of whose cases declares it.
function reachesPath(schema: Schema<unknown>, keys: readonly string[]): boolean {
  const unwrapped =
    (schema as { readonly kind?: string }).kind === "optional"
      ? (schema as OptionalSchema<unknown>).schema
      : schema;
  const [key, ...rest] = keys;
  if (key === undefined) {
    return true;
  }
  if (isVariantsSchema(unwrapped)) {
    return Object.values(unwrapped.variants).some(variant =>
      reachesPath(variant as Schema<unknown>, keys),
    );
  }
  if ((unwrapped as { readonly kind?: string }).kind !== "object") {
    return false;
  }
  const { shape } = unwrapped as ObjectSchema<ObjectShape>;
  return Object.hasOwn(shape, key) && reachesPath(shape[key]!, rest);
}

// A case may be named like an Object.prototype member, such as toString, so a
// plain index would read the inherited method as the builder or decision written.
function ownAt<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function casesWithoutDefault<B extends AnyBehavior>(
  definition: B,
  written: CasesWithDefault<B>,
): ImplementationCases<B> {
  const { $default: fallback, ...cases } = written as Readonly<Record<string, unknown>>;
  if (fallback === undefined) {
    return written as ImplementationCases<B>;
  }
  const left = definition.input.variantTags.filter(tag => ownAt(cases, tag) === undefined);
  if (left.length === 0) {
    throw new SpecificationError(`$default of ${definition.name} decides no case`);
  }
  return Object.fromEntries(
    definition.input.variantTags.map(tag => [tag, ownAt(cases, tag) ?? fallback]),
  ) as ImplementationCases<B>;
}

export function external<B extends AnyBehavior>(definition: B, reason: string): Implementation<B> {
  return {
    kind: "implementation",
    behavior: definition,
    cases: {} as ImplementationCases<B>,
    controls: {} as ControlTable<B["effects"]>,
    external: { reason },
  };
}

function checkMatch(
  definition: AnyBehavior,
  tags: readonly string[],
  decision: ImplementationCases<AnyBehavior>[string],
): void {
  if (decision?.kind !== "rules" || typeof decision.otherwise === "function") {
    return;
  }
  const keys = termData(decision.otherwise.on).path;
  const sumTags = new Set<string>();
  for (const tag of tags) {
    // A match has a case for every value it selects and none for its absence, so a
    // value that may be left out would reach no case; its absence is a case of a
    // sum instead.
    const leftOut = optionalAlong(definition.input.variants[tag] as Schema<unknown>, keys);
    if (leftOut !== undefined) {
      throw new SpecificationError(
        `match in ${decision.id} selects $.${keys.join(".")}, which may be left out at $.${leftOut.join(".")}`,
      );
    }
    const selected = schemaAtPath(
      definition.input.variants[tag] as Schema<unknown>,
      keys.slice(0, -1),
    );
    if (
      selected === undefined ||
      !isVariantsSchema(selected) ||
      selected.discriminant !== keys[keys.length - 1]
    ) {
      throw new SpecificationError(
        `match in ${decision.id} does not select the discriminant of a sum field`,
      );
    }
    selected.variantTags.forEach(caseTag => sumTags.add(caseTag));
  }
  const written = Object.keys(decision.otherwise.cases);
  const missing = [...sumTags].find(caseTag => !written.includes(caseTag));
  if (missing !== undefined) {
    throw new SpecificationError(`match in ${decision.id} has no case for ${missing}`);
  }
  const unknown = written.find(caseTag => !sumTags.has(caseTag));
  if (unknown !== undefined) {
    throw new SpecificationError(`match in ${decision.id} has a case ${unknown} the sum does not`);
  }
}

// The keys down to the first optional along a path, if any.
function optionalAlong(schema: Schema<unknown>, keys: readonly string[]): readonly string[] | undefined {
  let current: Schema<unknown> | undefined = schema;
  for (const [index, key] of keys.entries()) {
    const field: Schema<unknown> | undefined =
      current?.kind === "object" ? (current as ObjectSchema<ObjectShape>).shape[key] : undefined;
    if (field?.kind === "optional") {
      return keys.slice(0, index + 1);
    }
    current = field;
  }
  return undefined;
}

export function isBehavior(value: unknown): value is AnyBehavior {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Readonly<Record<string, unknown>>).kind === "behavior"
  );
}

export interface ComparisonReached {
  readonly rule: CompareRule;
  readonly scope: unknown;
}

export interface WayTaken {
  readonly decision: string;
  readonly steps: readonly { readonly distinction: Branch; readonly outcome: boolean | string }[];
}

export interface ArmTaken {
  readonly decision: string;
  readonly guard: number;
  readonly arm: string;
}

export async function perform<B extends AnyBehavior>(
  implementation: Implementation<B>,
  input: BehaviorInput<B>,
  deps?: BehaviorDeps<B>,
): Promise<Execution<BehaviorResult<B>, BehaviorEffect<B>>> {
  return (await runTraced(implementation, input, deps)).execution;
}

export async function runTraced<B extends AnyBehavior>(
  implementation: Implementation<B>,
  input: BehaviorInput<B>,
  deps?: BehaviorDeps<B>,
): Promise<{
  readonly execution: Execution<BehaviorResult<B>, BehaviorEffect<B>>;
  readonly arms: readonly ArmTaken[];
  readonly comparisons: readonly ComparisonReached[];
  readonly way: WayTaken | undefined;
}> {
  const definition = implementation.behavior;
  const parsedInput = definition.input.parse(input);
  if (!parsedInput.success) {
    throw new SpecificationError(formatIssues("Invalid input", parsedInput.issues));
  }

  if (implementation.external !== undefined) {
    throw new SpecificationError(
      `${definition.name} is implemented outside Chisel: ${implementation.external.reason}`,
    );
  }
  if (implementation.pipeline !== undefined) {
    const execution = await runStages(implementation.pipeline, parsedInput.value, deps);
    return {
      execution: validated(definition, parsedInput.value, execution),
      arms: [],
      comparisons: [],
      way: undefined,
    };
  }
  const tag = tagOf(definition.input, parsedInput.value);
  if (tag === undefined) {
    throw new SpecificationError("Input has no recognized variant");
  }

  const selected = implementation.cases[
    tag as keyof ImplementationCases<B>
  ];
  if (selected === undefined) {
    throw new SpecificationError(`No decision for input variant ${tag}`);
  }
  if (selected.kind === "todo") {
    throw new TodoDecision(definition.name, tag, selected.reason);
  }

  const arms: ArmTaken[] = [];
  const comparisons: ComparisonReached[] = [];
  const steps: { distinction: Branch; outcome: boolean | string }[] = [];
  const execution =
    selected.kind === "rules"
      ? decide(
          selected,
          parsedInput.value,
          deps,
          arms,
          (rule, scope) => comparisons.push({ rule, scope }),
          (distinction, outcome) => steps.push({ distinction, outcome }),
        )
      : await selected.run(parsedInput.value as never, deps as never);
  return {
    execution: validated(definition, parsedInput.value, execution),
    arms,
    comparisons,
    way: selected.kind === "rules" ? { decision: selected.id, steps } : undefined,
  };
}

function validated<B extends AnyBehavior>(
  definition: B,
  input: unknown,
  execution: Execution<unknown, unknown>,
): Execution<BehaviorResult<B>, BehaviorEffect<B>> {
  const parsedResult = definition.result.parse(execution.result);
  if (!parsedResult.success) {
    throw new SpecificationError(formatIssues("Invalid result", parsedResult.issues));
  }
  const broken = brokenEnsures(definition, input, parsedResult.value);
  if (broken !== undefined) {
    throw new SpecificationError(
      `Ensures ${broken.name} does not hold: ${describeRule(broken.rule, "")}`,
    );
  }
  const parsedEffects: unknown[] = [];
  for (const [index, effect] of execution.effects.entries()) {
    const parsedEffect = definition.effects.parse(effect, `$.effects[${index}]`);
    if (!parsedEffect.success) {
      throw new SpecificationError(formatIssues("Invalid effect", parsedEffect.issues));
    }
    parsedEffects.push(parsedEffect.value);
  }
  return {
    result: parsedResult.value as BehaviorResult<B>,
    effects: parsedEffects as BehaviorEffect<B>[],
  };
}

async function runStages(
  [first, second]: readonly [AnyImplementation, AnyImplementation],
  input: unknown,
  deps: unknown,
): Promise<Execution<unknown, unknown>> {
  const answered = (await runTraced(first, input as never, deps as never)).execution;
  const departed = (first.behavior as { readonly departed?: readonly string[] }).departed ?? [];
  const firstResult = first.behavior.result;
  const tag = isVariantsSchema(firstResult) ? tagOf(firstResult, answered.result) : undefined;
  if (
    tag === undefined ||
    departed.includes(tag) ||
    !second.behavior.input.variantTags.includes(tag)
  ) {
    return answered;
  }
  const continued = (await runTraced(second, answered.result as never, deps as never)).execution;
  return { result: continued.result, effects: [...answered.effects, ...continued.effects] };
}

export function traceSync(
  implementation: AnyImplementation,
  input: unknown,
  deps?: unknown,
): { readonly comparisons: readonly ComparisonReached[]; readonly way: WayTaken | undefined } {
  const parsed = implementation.behavior.input.parse(input);
  const tag = parsed.success ? tagOf(implementation.behavior.input, parsed.value) : undefined;
  const decision = tag === undefined ? undefined : implementation.cases[tag];
  if (!parsed.success || decision?.kind !== "rules") {
    return { comparisons: [], way: undefined };
  }
  const comparisons: ComparisonReached[] = [];
  const steps: { distinction: Branch; outcome: boolean | string }[] = [];
  try {
    decide(
      decision,
      parsed.value,
      deps,
      [],
      (rule, scope) => comparisons.push({ rule, scope }),
      (distinction, outcome) => steps.push({ distinction, outcome }),
    );
  } catch {
    // Not undefined: the way is settled before a handler runs, so a handler
    // that needs a stand-in generate does not have leaves the way intact.
    return { comparisons, way: { decision: decision.id, steps } };
  }
  return { comparisons, way: { decision: decision.id, steps } };
}

export function comparisonsReached(
  implementation: AnyImplementation,
  input: unknown,
  deps?: unknown,
): readonly ComparisonReached[] {
  return traceSync(implementation, input, deps).comparisons;
}

function decide<Result, Effect>(
  decision: RulesDecision<unknown, Result, Effect>,
  input: unknown,
  deps: unknown,
  arms: ArmTaken[],
  observe: ComparisonObserver,
  distinguish: (distinction: Branch, outcome: boolean | string) => void,
): Execution<Result, Effect> {
  const scope = withDeps(input, deps);
  for (const [index, candidate] of decision.guards.entries()) {
    if (!holds(candidate.condition, scope, observe, distinguish)) {
      arms.push({ decision: decision.id, guard: index, arm: "else" });
      return candidate.orElse(input, deps);
    }
    arms.push({ decision: decision.id, guard: index, arm: "holds" });
  }
  const { otherwise } = decision;
  if (typeof otherwise === "function") {
    return otherwise(input, deps);
  }
  const tag = readOperand(otherwise.on, input);
  const selected = typeof tag === "string" ? otherwise.cases[tag] : undefined;
  if (selected === undefined) {
    throw new SpecificationError(`No case of ${decision.id} for ${String(tag)}`);
  }
  arms.push({ decision: decision.id, guard: decision.guards.length, arm: tag as string });
  distinguish(otherwise as Match<unknown, unknown, unknown>, tag as string);
  return selected(input, deps);
}

function formatIssues(
  prefix: string,
  issues: readonly { readonly path: string; readonly message: string }[],
): string {
  return `${prefix}: ${issues
    .map(issue => `${issue.path}: ${issue.message}`)
    .join("; ")}`;
}
