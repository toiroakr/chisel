import type { Requirements, Resolved } from "./dependency.js";
import type {
  AnyVariantsSchema,
  Infer,
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
  readonly dependsOn?: readonly string[];
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
  readonly dependsOn?: readonly string[];
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
  readonly input: InputSchema;
  readonly result: ResultSchema;
  readonly effects: EffectSchema;
  readonly dependsOn: readonly string[];
  readonly requires: Requires;
  readonly ensures: readonly EnsuresClause[];
}

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

export function guard<Input, Result, Effect, Deps = unknown>(
  condition: Rule,
  orElse: (input: Input, deps: Deps) => Execution<Result, Effect>,
): Guard<Input, Result, Effect, Deps> {
  return { kind: "guard", condition, orElse };
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
    readonly dependsOn?: readonly string[];
  },
): RulesDecision<Input, Result, Effect, Deps> {
  return {
    kind: "rules",
    id,
    guards:
      body.guards?.(selfTerm<NoInfer<Input>>(), depsTerm<ValueDepsOf<NoInfer<Deps>>>()) ?? [],
    otherwise: body.run,
    ...(body.dependsOn === undefined ? {} : { dependsOn: body.dependsOn }),
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
>(options: {
  readonly name: string;
  readonly input: InputSchema;
  readonly result: ResultSchema;
  readonly effects: EffectSchema;
  readonly dependsOn?: readonly string[];
  readonly requires?: Requires;
  readonly ensures?: (
    clause: EnsuresBuilder<Infer<InputSchema>, ResultSchema>,
  ) => readonly EnsuresClause[];
}): Behavior<InputSchema, ResultSchema, EffectSchema, Requires> {
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
    name: options.name,
    input: options.input,
    result: options.result,
    effects: options.effects,
    dependsOn: options.dependsOn ?? [],
    requires: options.requires ?? ({} as Requires),
    ensures: clauses,
  };
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

export function implement<B extends AnyBehavior>(
  definition: B,
  options: NoInfer<{
    readonly cases: ImplementationCases<B>;
    readonly controls?: ControlTable<B["effects"]>;
  }>,
): Implementation<NoInfer<B>> {
  for (const [tag, decision] of Object.entries(options.cases) as [string, unknown][]) {
    checkMatch(definition, tag, decision as ImplementationCases<AnyBehavior>[string]);
  }
  return {
    kind: "implementation",
    behavior: definition,
    cases: options.cases,
    controls: options.controls ?? ({} as ControlTable<B["effects"]>),
  };
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
  tag: string,
  decision: ImplementationCases<AnyBehavior>[string],
): void {
  if (decision?.kind !== "rules" || typeof decision.otherwise === "function") {
    return;
  }
  const keys = termData(decision.otherwise.on).path;
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
  const written = Object.keys(decision.otherwise.cases);
  const missing = selected.variantTags.find(caseTag => !written.includes(caseTag));
  if (missing !== undefined) {
    throw new SpecificationError(`match in ${decision.id} has no case for ${missing}`);
  }
  const unknown = written.find(caseTag => !selected.variantTags.includes(caseTag));
  if (unknown !== undefined) {
    throw new SpecificationError(`match in ${decision.id} has a case ${unknown} the sum does not`);
  }
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
