import type {
  AnySumSchema,
  Infer,
  Schema,
  SumSchema,
  SumVariants,
  Tags,
  VariantOf,
} from "./schema.js";
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

export type Cases<
  Input extends SumSchema<string, SumVariants>,
  Result,
  Effect,
> = {
  readonly [Tag in Tags<Input>]:
    | Decision<VariantOf<Input, Tag>, Result, Effect>
    | Pending;
};

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
  InputSchema extends SumSchema<string, SumVariants>,
  ResultSchema extends Schema<unknown>,
  EffectSchema extends AnySumSchema,
> {
  readonly kind: "behavior";
  readonly name: string;
  readonly input: InputSchema;
  readonly result: ResultSchema;
  readonly effects: EffectSchema;
  readonly cases: Cases<
    InputSchema,
    Infer<ResultSchema>,
    Infer<EffectSchema>
  >;
  readonly controls: ControlTable<EffectSchema>;
}

export type AnyBehavior = Behavior<
  SumSchema<string, SumVariants>,
  Schema<unknown>,
  AnySumSchema
>;

export type BehaviorInput<B> = B extends Behavior<infer Input, Schema<unknown>, AnySumSchema>
  ? Infer<Input>
  : never;
export type BehaviorResult<B> = B extends Behavior<
  SumSchema<string, SumVariants>,
  infer Result,
  AnySumSchema
>
  ? Infer<Result>
  : never;
export type BehaviorEffect<B> = B extends Behavior<
  SumSchema<string, SumVariants>,
  Schema<unknown>,
  infer Effect
>
  ? Infer<Effect>
  : never;

export class SpecificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecificationError";
  }
}

export function pending(reason: string): Pending {
  return { kind: "pending", reason };
}

export function behavior<
  const InputSchema extends SumSchema<string, SumVariants>,
  const ResultSchema extends Schema<unknown>,
  const EffectSchema extends AnySumSchema,
>(options: {
  readonly name: string;
  readonly input: InputSchema;
  readonly result: ResultSchema;
  readonly effects: EffectSchema;
  readonly cases: Cases<
    InputSchema,
    Infer<ResultSchema>,
    Infer<EffectSchema>
  >;
  readonly controls?: ControlTable<EffectSchema>;
}): Behavior<InputSchema, ResultSchema, EffectSchema> {
  return {
    kind: "behavior",
    name: options.name,
    input: options.input,
    result: options.result,
    effects: options.effects,
    cases: options.cases,
    controls: options.controls ?? ({} as ControlTable<EffectSchema>),
  };
}

export async function runBehavior<B extends AnyBehavior>(
  definition: B,
  input: BehaviorInput<B>,
): Promise<Execution<BehaviorResult<B>, BehaviorEffect<B>>> {
  const parsedInput = definition.input.parse(input);
  if (!parsedInput.success) {
    throw new SpecificationError(formatIssues("Invalid input", parsedInput.issues));
  }

  const tag = tagOf(definition.input, parsedInput.value);
  if (tag === undefined) {
    throw new SpecificationError("Input has no recognized variant");
  }

  const selected = definition.cases[tag as Tags<typeof definition.input>];
  if (selected === undefined) {
    throw new SpecificationError(`No decision for input variant ${tag}`);
  }
  if (selected.kind === "pending") {
    throw new SpecificationError(`Pending decision for ${tag}: ${selected.reason}`);
  }

  const execution = await selected.run(parsedInput.value as never);
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

function formatIssues(
  prefix: string,
  issues: readonly { readonly path: string; readonly message: string }[],
): string {
  return `${prefix}: ${issues
    .map(issue => `${issue.path}: ${issue.message}`)
    .join("; ")}`;
}
