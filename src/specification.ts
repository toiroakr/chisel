import { isDeepStrictEqual } from "node:util";
import type {
  AnyBehavior,
  BehaviorEffect,
  BehaviorInput,
  BehaviorResult,
  Execution,
  Implementation,
} from "./behavior.js";
import { runImplementation } from "./behavior.js";
import { isSumSchema, tagOf } from "./schema.js";

export interface Unanswered {
  readonly kind: "unanswered";
  readonly reason: string;
}

export interface Example<B extends AnyBehavior> {
  readonly kind: "example";
  readonly name: string;
  readonly given: BehaviorInput<B>;
  readonly expect: Execution<BehaviorResult<B>, BehaviorEffect<B>> | Unanswered;
}

export interface ExampleSet<B extends AnyBehavior> {
  readonly kind: "example-set";
  readonly behavior: B;
  readonly rows: readonly Example<B>[];
}

export interface Specification<B extends AnyBehavior = AnyBehavior> {
  readonly kind: "specification";
  readonly name: string;
  readonly examples: ExampleSet<B>;
  readonly implementation: Implementation<B> | undefined;
}

export interface ExampleFailure {
  readonly name: string;
  readonly message: string;
}

export interface PendingDecision {
  readonly variant: string;
  readonly reason: string;
}

export interface UnansweredExample {
  readonly name: string;
  readonly variant: string | undefined;
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
  readonly implementation: "present" | "missing";
  readonly unanswered: readonly UnansweredExample[];
  readonly pendingDecisions: readonly PendingDecision[];
  readonly controlGaps: readonly ControlGap[];
  readonly failures: readonly ExampleFailure[];
  readonly internalDecisionCoverage: "undetermined";
  readonly adequate: boolean;
}

export interface Coverage {
  readonly covered: readonly string[];
  readonly missing: readonly string[];
  readonly total: number;
}

export interface GeneratedExample {
  readonly name: string;
  readonly given: unknown;
  readonly reason: string;
}

export type ConformanceSubject<B extends AnyBehavior> = (
  input: BehaviorInput<B>,
) =>
  | Execution<BehaviorResult<B>, BehaviorEffect<B>>
  | Promise<Execution<BehaviorResult<B>, BehaviorEffect<B>>>;

export function unanswered(
  reason = "期待結果を人間が決める必要があります",
): Unanswered {
  return { kind: "unanswered", reason };
}

export function isUnanswered(value: unknown): value is Unanswered {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Readonly<Record<string, unknown>>).kind === "unanswered"
  );
}

export function example<B extends AnyBehavior>(
  definition: B,
  name: string,
  value: {
    readonly given: BehaviorInput<B>;
    readonly expect: Execution<BehaviorResult<B>, BehaviorEffect<B>> | Unanswered;
  },
): Example<B> {
  return { kind: "example", name, ...value };
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
  readonly implementation?: Implementation<B>;
}): Specification<B> {
  return {
    kind: "specification",
    name: options.name,
    examples: options.examples,
    implementation: options.implementation,
  };
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
  const unansweredRows: UnansweredExample[] = [];

  for (const row of specification.examples.rows) {
    const inputValidation = definition.input.parse(row.given);
    const inputTag = tagOf(definition.input, row.given);
    if (!inputValidation.success) {
      failures.push({ name: row.name, message: "Example input is invalid" });
      continue;
    }

    if (isUnanswered(row.expect)) {
      unansweredRows.push({
        name: row.name,
        variant: inputTag,
        reason: row.expect.reason,
      });
      continue;
    }

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

    if (specification.implementation !== undefined) {
      try {
        const actual = await runImplementation(
          specification.implementation,
          row.given,
        );
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
  }

  const pendingDecisions =
    specification.implementation === undefined
      ? []
      : Object.entries(specification.implementation.cases).flatMap(
          ([variant, decision]) =>
            decision.kind === "pending"
              ? [{ variant, reason: decision.reason }]
              : [],
        );

  const controlGaps =
    specification.implementation === undefined
      ? []
      : definition.effects.variantTags.flatMap(effect => {
          const control = specification.implementation?.controls[effect];
          if (control === undefined) {
            return [{ effect, reason: "control policy is missing" }];
          }
          return "kind" in control && control.kind === "pending"
            ? [{ effect, reason: control.reason }]
            : [];
        });

  const input = coverage(definition.input.variantTags, coveredInputs);
  const result = isSumSchema(definition.result)
    ? coverage(definition.result.variantTags, coveredResults)
    : coverage([], new Set());
  const effects = coverage(definition.effects.variantTags, coveredEffects);
  const adequate =
    specification.implementation !== undefined &&
    failures.length === 0 &&
    unansweredRows.length === 0 &&
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
    implementation:
      specification.implementation === undefined ? "missing" : "present",
    unanswered: unansweredRows,
    pendingDecisions,
    controlGaps,
    failures,
    internalDecisionCoverage: "undetermined",
    adequate,
  };
}

export function generateExamples(
  target: AnyBehavior | ExampleSet<AnyBehavior>,
): readonly GeneratedExample[] {
  const definition = target.kind === "behavior" ? target : target.behavior;
  const rows = target.kind === "behavior" ? [] : target.rows;
  const existing = new Set(
    rows
      .map(row => tagOf(definition.input, row.given))
      .filter((tag): tag is string => tag !== undefined),
  );

  return definition.input.variantTags
    .filter(tag => !existing.has(tag))
    .map(tag => ({
      name: `${definition.name}: ${tag}`,
      given: definition.input.placeholderFor(tag),
      reason: `${tag}の期待結果を人間が決める必要があります`,
    }));
}

export async function verifyConformance<B extends AnyBehavior>(
  exampleSet: ExampleSet<B>,
  subject: ConformanceSubject<B>,
): Promise<readonly ExampleFailure[]> {
  const failures: ExampleFailure[] = [];
  for (const row of exampleSet.rows) {
    if (isUnanswered(row.expect)) {
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
