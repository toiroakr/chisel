import type {
  AnySumSchema,
  Infer,
  Schema,
  Tags,
  VariantOf,
} from "./schema.js";
import type { Rule, TermOf } from "./rule.js";
import { holds, selfTerm } from "./rule.js";
import { tagOf } from "./schema.js";

export interface Execution<Result, Effect> {
  readonly result: Result;
  readonly effects: readonly Effect[];
}

export interface Pending {
  readonly kind: "pending";
  readonly reason: string;
}

export interface Decision<Input, Result, Effect> {
  readonly kind: "decision";
  readonly id: string;
  readonly dependsOn?: readonly string[];
  run(input: Input): Execution<Result, Effect> | Promise<Execution<Result, Effect>>;
}

export interface Guard<Input, Result, Effect> {
  readonly kind: "guard";
  readonly condition: Rule;
  orElse(input: Input): Execution<Result, Effect>;
}

export interface RulesDecision<Input, Result, Effect> {
  readonly kind: "rules";
  readonly id: string;
  readonly dependsOn?: readonly string[];
  readonly guards: readonly Guard<Input, Result, Effect>[];
  otherwise(input: Input): Execution<Result, Effect>;
}

export interface ControlPolicy {
  readonly execution: "direct" | "outbox" | "queue";
  readonly idempotency: "required" | "not-required";
  readonly compensation: "automatic" | "manual" | "none";
  readonly exposure?: "normal" | "shadow" | "canary";
}

export type ControlTable<Effects extends AnySumSchema> = Readonly<
  Partial<Record<Tags<Effects>, ControlPolicy | Pending>>
>;

export interface Behavior<
  InputSchema extends AnySumSchema,
  ResultSchema extends Schema<unknown>,
  EffectSchema extends AnySumSchema,
> {
  readonly kind: "behavior";
  readonly name: string;
  readonly input: InputSchema;
  readonly result: ResultSchema;
  readonly effects: EffectSchema;
  readonly dependsOn: readonly string[];
}

export type AnyBehavior = Behavior<
  AnySumSchema,
  Schema<unknown>,
  AnySumSchema
>;

export type BehaviorInput<B> = B extends Behavior<infer Input, Schema<unknown>, AnySumSchema>
  ? Infer<Input>
  : never;
export type BehaviorResult<B> = B extends Behavior<
  AnySumSchema,
  infer Result,
  AnySumSchema
>
  ? Infer<Result>
  : never;
export type BehaviorEffect<B> = B extends Behavior<
  AnySumSchema,
  Schema<unknown>,
  infer Effect
>
  ? Infer<Effect>
  : never;

export type ImplementationCases<B extends AnyBehavior> = {
  readonly [Tag in Tags<B["input"]>]:
    | Decision<VariantOf<B["input"], Tag>, BehaviorResult<B>, BehaviorEffect<B>>
    | RulesDecision<VariantOf<B["input"], Tag>, BehaviorResult<B>, BehaviorEffect<B>>
    | Pending;
};

export interface Implementation<B extends AnyBehavior> {
  readonly kind: "implementation";
  readonly behavior: B;
  readonly cases: ImplementationCases<B>;
  readonly controls: ControlTable<B["effects"]>;
}

export type AnyImplementation = Implementation<AnyBehavior>;

export class SpecificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecificationError";
  }
}

export function guard<Input, Result, Effect>(
  condition: Rule,
  orElse: (input: Input) => Execution<Result, Effect>,
): Guard<Input, Result, Effect> {
  return { kind: "guard", condition, orElse };
}

export function rules<Input, Result, Effect>(
  id: string,
  build: (
    input: TermOf<NoInfer<Input>>,
  ) => readonly Guard<NoInfer<Input>, NoInfer<Result>, NoInfer<Effect>>[],
  otherwise: (input: NoInfer<Input>) => Execution<NoInfer<Result>, NoInfer<Effect>>,
): RulesDecision<Input, Result, Effect> {
  return { kind: "rules", id, guards: build(selfTerm<NoInfer<Input>>()), otherwise };
}

export function pending(reason: string): Pending {
  return { kind: "pending", reason };
}

export function behavior<
  const InputSchema extends AnySumSchema,
  const ResultSchema extends Schema<unknown>,
  const EffectSchema extends AnySumSchema,
>(options: {
  readonly name: string;
  readonly input: InputSchema;
  readonly result: ResultSchema;
  readonly effects: EffectSchema;
  readonly dependsOn?: readonly string[];
}): Behavior<InputSchema, ResultSchema, EffectSchema> {
  return {
    kind: "behavior",
    name: options.name,
    input: options.input,
    result: options.result,
    effects: options.effects,
    dependsOn: options.dependsOn ?? [],
  };
}

export function implement<B extends AnyBehavior>(
  definition: B,
  options: {
    readonly cases: ImplementationCases<B>;
    readonly controls?: ControlTable<B["effects"]>;
  },
): Implementation<B> {
  return {
    kind: "implementation",
    behavior: definition,
    cases: options.cases,
    controls: options.controls ?? ({} as ControlTable<B["effects"]>),
  };
}

export function isBehavior(value: unknown): value is AnyBehavior {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Readonly<Record<string, unknown>>).kind === "behavior"
  );
}

export async function runImplementation<B extends AnyBehavior>(
  implementation: Implementation<B>,
  input: BehaviorInput<B>,
): Promise<Execution<BehaviorResult<B>, BehaviorEffect<B>>> {
  const definition = implementation.behavior;
  const parsedInput = definition.input.parse(input);
  if (!parsedInput.success) {
    throw new SpecificationError(formatIssues("Invalid input", parsedInput.issues));
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
  if (selected.kind === "pending") {
    throw new SpecificationError(`Pending decision for ${tag}: ${selected.reason}`);
  }

  const execution =
    selected.kind === "rules"
      ? decide(selected, parsedInput.value)
      : await selected.run(parsedInput.value as never);
  const parsedResult = definition.result.parse(execution.result);
  if (!parsedResult.success) {
    throw new SpecificationError(formatIssues("Invalid result", parsedResult.issues));
  }

  const parsedEffects: unknown[] = [];
  for (const [index, effect] of execution.effects.entries()) {
    const parsedEffect = definition.effects.parse(effect, `$.effects[${index}]`);
    if (!parsedEffect.success) {
      throw new SpecificationError(
        formatIssues("Invalid effect", parsedEffect.issues),
      );
    }
    parsedEffects.push(parsedEffect.value);
  }

  return {
    result: parsedResult.value as BehaviorResult<B>,
    effects: parsedEffects as BehaviorEffect<B>[],
  };
}

function decide<Result, Effect>(
  decision: RulesDecision<unknown, Result, Effect>,
  input: unknown,
): Execution<Result, Effect> {
  const failed = decision.guards.find(candidate => !holds(candidate.condition, input));
  return failed === undefined ? decision.otherwise(input) : failed.orElse(input);
}

function formatIssues(
  prefix: string,
  issues: readonly { readonly path: string; readonly message: string }[],
): string {
  return `${prefix}: ${issues
    .map(issue => `${issue.path}: ${issue.message}`)
    .join("; ")}`;
}
