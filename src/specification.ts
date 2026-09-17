import { isDeepStrictEqual } from "node:util";
import type {
  AnyBehavior,
  BehaviorEffect,
  BehaviorInput,
  BehaviorResult,
  Execution,
} from "./behavior.js";
import { runBehavior } from "./behavior.js";
import { isSumSchema, tagOf } from "./schema.js";

export interface CompleteExample<B extends AnyBehavior> {
  readonly kind: "example";
  readonly name: string;
  readonly given: BehaviorInput<B>;
  readonly expect: Execution<BehaviorResult<B>, BehaviorEffect<B>>;
}

export interface TodoExample<B extends AnyBehavior> {
  readonly kind: "todo";
  readonly name: string;
  readonly given: BehaviorInput<B>;
  readonly reason: string;
}

export type Example<B extends AnyBehavior> =
  | CompleteExample<B>
  | TodoExample<B>;

export interface ExampleSet<B extends AnyBehavior> {
  readonly kind: "example-set";
  readonly behavior: B;
  readonly rows: readonly Example<B>[];
}

export interface Specification<B extends AnyBehavior = AnyBehavior> {
  readonly kind: "specification";
  readonly name: string;
  readonly examples: ExampleSet<B>;
}

export interface ExampleFailure {
  readonly name: string;
  readonly message: string;
}

export interface PendingDecision {
  readonly variant: string;
  readonly reason: string;
}

export interface ControlGap {
  readonly effect: string;
  readonly reason: string;
}

export interface AdequacyReport {
  readonly specification: string;
  readonly behavior: string;
  readonly input: Coverage;
  readonly result: Coverage;
  readonly effects: Coverage;
  readonly pendingDecisions: readonly PendingDecision[];
  readonly controlGaps: readonly ControlGap[];
  readonly todos: readonly string[];
  readonly failures: readonly ExampleFailure[];
  readonly internalDecisionCoverage: "undetermined";
  readonly adequate: boolean;
}

export interface Coverage {
  readonly covered: readonly string[];
  readonly missing: readonly string[];
  readonly total: number;
}

export interface GeneratedTodo {
  readonly name: string;
  readonly given: unknown;
  readonly reason: string;
}

export type ConformanceSubject<B extends AnyBehavior> = (
  input: BehaviorInput<B>,
) =>
  | Execution<BehaviorResult<B>, BehaviorEffect<B>>
  | Promise<Execution<BehaviorResult<B>, BehaviorEffect<B>>>;

export function example<B extends AnyBehavior>(
  name: string,
  value: {
    readonly given: BehaviorInput<B>;
    readonly expect: Execution<BehaviorResult<B>, BehaviorEffect<B>>;
  },
): CompleteExample<B> {
  return { kind: "example", name, ...value };
}

export function todo<B extends AnyBehavior>(
  name: string,
  value: { readonly given: BehaviorInput<B>; readonly reason: string },
): TodoExample<B> {
  return { kind: "todo", name, ...value };
}

export function examples<
  B extends AnyBehavior,
  const Rows extends readonly Example<B>[],
>(behavior: B, rows: Rows): ExampleSet<B> {
  return { kind: "example-set", behavior, rows };
}

export function defineSpecification<B extends AnyBehavior>(options: {
  readonly name: string;
  readonly examples: ExampleSet<B>;
}): Specification<B> {
  return { kind: "specification", ...options };
}

export function isSpecification(value: unknown): value is Specification {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Readonly<Record<string, unknown>>).kind === "specification"
  );
}

export async function evaluateSpecification(
  specification: Specification,
): Promise<AdequacyReport> {
  const definition = specification.examples.behavior;
  const coveredInputs = new Set<string>();
  const coveredResults = new Set<string>();
  const coveredEffects = new Set<string>();
  const failures: ExampleFailure[] = [];
  const todos: string[] = [];

  for (const row of specification.examples.rows) {
    if (row.kind === "todo") {
      todos.push(row.name);
      continue;
    }

    const inputTag = tagOf(definition.input, row.given);
    if (inputTag !== undefined) {
      coveredInputs.add(inputTag);
    }

    const resultValidation = definition.result.parse(row.expect.result);
    if (!resultValidation.success) {
      failures.push({ name: row.name, message: "Expected result is invalid" });
      continue;
    }

    const resultTag = isSumSchema(definition.result)
      ? tagOf(definition.result, row.expect.result)
      : undefined;
    if (resultTag !== undefined) {
      coveredResults.add(resultTag);
    }

    for (const effect of row.expect.effects) {
      const effectTag = tagOf(definition.effects, effect);
      if (effectTag !== undefined) {
        coveredEffects.add(effectTag);
      }
    }

    try {
      const actual = await runBehavior(definition, row.given);
      if (!isDeepStrictEqual(actual, row.expect)) {
        failures.push({
          name: row.name,
          message: `Expected ${JSON.stringify(row.expect)}, received ${JSON.stringify(actual)}`,
        });
      }
    } catch (error) {
      failures.push({
        name: row.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const pendingDecisions = Object.entries(definition.cases).flatMap(
    ([variant, decision]) =>
      decision.kind === "pending"
        ? [{ variant, reason: decision.reason }]
        : [],
  );

  const controlGaps = definition.effects.variantTags.flatMap(effect => {
    const control = definition.controls[effect];
    if (control === undefined) {
      return [{ effect, reason: "control policy is missing" }];
    }
    return "kind" in control && control.kind === "pending"
      ? [{ effect, reason: control.reason }]
      : [];
  });

  const input = coverage(definition.input.variantTags, coveredInputs);
  const result =
    isSumSchema(definition.result)
      ? coverage(definition.result.variantTags, coveredResults)
      : coverage([], new Set());
  const effects = coverage(definition.effects.variantTags, coveredEffects);
  const adequate =
    failures.length === 0 &&
    todos.length === 0 &&
    pendingDecisions.length === 0 &&
    controlGaps.length === 0 &&
    input.missing.length === 0 &&
    result.missing.length === 0 &&
    effects.missing.length === 0;

  return {
    specification: specification.name,
    behavior: definition.name,
    input,
    result,
    effects,
    pendingDecisions,
    controlGaps,
    todos,
    failures,
    internalDecisionCoverage: "undetermined",
    adequate,
  };
}

export function generateTodos(specification: Specification): readonly GeneratedTodo[] {
  const definition = specification.examples.behavior;
  const existing = new Set(
    specification.examples.rows
      .map(row => tagOf(definition.input, row.given))
      .filter((tag): tag is string => tag !== undefined),
  );

  return definition.input.variantTags
    .filter(tag => !existing.has(tag))
    .map(tag => ({
      name: `${definition.name}: ${tag}`,
      given: definition.input.placeholderFor(tag),
      reason: `Expected result for ${tag} must be decided by a human`,
    }));
}

export async function verifyConformance<B extends AnyBehavior>(
  exampleSet: ExampleSet<B>,
  subject: ConformanceSubject<B>,
): Promise<readonly ExampleFailure[]> {
  const failures: ExampleFailure[] = [];
  for (const row of exampleSet.rows) {
    if (row.kind === "todo") {
      continue;
    }
    try {
      const actual = await subject(row.given);
      if (!isDeepStrictEqual(actual, row.expect)) {
        failures.push({
          name: row.name,
          message: `Expected ${JSON.stringify(row.expect)}, received ${JSON.stringify(actual)}`,
        });
      }
    } catch (error) {
      failures.push({
        name: row.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failures;
}

function coverage(all: readonly string[], covered: ReadonlySet<string>): Coverage {
  return {
    covered: all.filter(value => covered.has(value)),
    missing: all.filter(value => !covered.has(value)),
    total: all.length,
  };
}
