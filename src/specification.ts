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
import type { PointRole } from "./border.js";
import type { Position } from "./partition.js";
import { coordinatesIn, positionsOf } from "./partition.js";
import { isSumSchema, tagOf } from "./schema.js";

interface RunOutcome {
  readonly actual: unknown;
  readonly failure: ExampleFailure | undefined;
}

async function runAndCompare<B extends AnyBehavior>(
  name: string,
  given: BehaviorInput<B>,
  expected: Execution<BehaviorResult<B>, BehaviorEffect<B>>,
  subject: ConformanceSubject<B>,
): Promise<RunOutcome> {
  try {
    const actual = await subject(given);
    return {
      actual,
      failure: isDeepStrictEqual(actual, expected)
        ? undefined
        : {
            name,
            message: `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
          },
    };
  } catch (error) {
    return {
      actual: undefined,
      failure: { name, message: error instanceof Error ? error.message : String(error) },
    };
  }
}

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

export interface DependencyIssue {
  readonly variant: string | undefined;
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
  readonly dependencyIssues: readonly DependencyIssue[];
  readonly failures: readonly ExampleFailure[];
  readonly partitions: readonly PartitionCoverage[];
  readonly borders: readonly BorderCoverage[];
  readonly evidence: {
    readonly input: readonly InputCaseEvidence[];
    readonly result: readonly ResultCaseEvidence[];
    readonly effects: readonly ResultCaseEvidence[];
  };
  readonly measures: { readonly arms: Measure };
  readonly adequate: boolean;
  readonly verdict: Verdict;
}

export type Verdict = "satisfied" | "not_satisfied" | "undetermined";

export type Measure =
  | { readonly status: "unavailable"; readonly reason: "not applicable" }
  | {
      readonly status: "unavailable";
      readonly reason: "not measured";
      readonly notRead: readonly string[];
    };

export interface InputCaseEvidence {
  readonly case: string;
  readonly specified: boolean;
  readonly executed: boolean;
  readonly verified: boolean;
}

export interface ResultCaseEvidence {
  readonly case: string;
  readonly specified: boolean;
  readonly observed: boolean;
  readonly verified: boolean;
}

export interface BorderCoverage {
  readonly path: string;
  readonly rule: string;
  readonly points: readonly {
    readonly role: PointRole;
    readonly relation: string;
    readonly status: "met" | "gap" | "excluded" | "not named";
  }[];
}

export type PartitionCoverage =
  | {
      readonly path: string;
      readonly kind: "divided";
      readonly covered: readonly string[];
      readonly missing: readonly string[];
      readonly excluded: readonly string[];
    }
  | { readonly path: string; readonly kind: "not-derivable" | "bounded" };

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
  const executedInputs = new Set<string>();
  const verifiedInputs = new Set<string>();
  const observedResults = new Set<string>();
  const verifiedResults = new Set<string>();
  const observedEffects = new Set<string>();
  const verifiedEffects = new Set<string>();
  const positions = positionsOf(definition.input);
  const coveredClasses = positions.map(() => new Set<string>());
  const answeredGivens: unknown[] = [];
  const observe = (
    inputTag: string,
    actual: unknown,
  ): { readonly result: string | undefined; readonly effects: ReadonlySet<string> } => {
    executedInputs.add(inputTag);
    const execution = actual as Execution<unknown, unknown>;
    const result = isSumSchema(definition.result)
      ? tagOf(definition.result, execution.result)
      : undefined;
    if (result !== undefined) {
      observedResults.add(result);
    }
    const effects = new Set(
      execution.effects
        .map(effect => tagOf(definition.effects, effect))
        .filter((tag): tag is string => tag !== undefined),
    );
    for (const effect of effects) {
      observedEffects.add(effect);
    }
    return { result, effects };
  };

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
      const implementation = specification.implementation;
      const decision =
        implementation === undefined || inputTag === undefined
          ? undefined
          : implementation.cases[inputTag];
      if (implementation !== undefined && decision?.kind === "decision") {
        try {
          observe(inputTag!, await runImplementation(implementation, row.given));
        } catch (error) {
          failures.push({
            name: row.name,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      continue;
    }

    if (inputTag !== undefined) {
      coveredInputs.add(inputTag);
    }
    answeredGivens.push(row.given);
    positions.forEach((position, index) => {
      if (position.kind === "divided") {
        for (const found of position.classify(row.given)) {
          coveredClasses[index]!.add(found);
        }
      }
    });

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

    const implementation = specification.implementation;
    if (implementation !== undefined) {
      const { actual, failure } = await runAndCompare(
        row.name,
        row.given,
        row.expect,
        input => runImplementation(implementation, input),
      );
      if (actual !== undefined && inputTag !== undefined) {
        const observed = observe(inputTag, actual);
        if (observed.result !== undefined && observed.result === resultTag) {
          verifiedResults.add(observed.result);
        }
        for (const effect of row.expect.effects) {
          const effectTag = tagOf(definition.effects, effect);
          if (effectTag !== undefined && observed.effects.has(effectTag)) {
            verifiedEffects.add(effectTag);
          }
        }
        if (failure === undefined) {
          verifiedInputs.add(inputTag);
        }
      }
      if (failure !== undefined) {
        failures.push(failure);
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

  const knownEffects = new Set(definition.effects.variantTags);
  const unknownDependency = (tag: string): boolean => !knownEffects.has(tag);
  const dependencyIssues: DependencyIssue[] = [
    ...definition.dependsOn.filter(unknownDependency).map(tag => ({
      variant: undefined,
      reason: `未知の作用'${tag}'に依存すると宣言されています`,
    })),
    ...(specification.implementation === undefined
      ? []
      : Object.entries(specification.implementation.cases).flatMap(
          ([variant, decision]) =>
            decision.kind === "decision"
              ? (decision.dependsOn ?? [])
                  .filter(unknownDependency)
                  .map(tag => ({
                    variant,
                    reason: `未知の作用'${tag}'に依存すると宣言されています`,
                  }))
              : [],
        )),
  ];

  const input = coverage(definition.input.variantTags, coveredInputs);
  const result = isSumSchema(definition.result)
    ? coverage(definition.result.variantTags, coveredResults)
    : coverage([], new Set());
  const effects = coverage(definition.effects.variantTags, coveredEffects);
  const partitions = positions.map((position, index): PartitionCoverage => {
    if (position.kind !== "divided") {
      return { path: position.path, kind: position.kind };
    }
    const { covered, missing } = coverage(
      position.classes.filter(className => !position.excluded.includes(className)),
      coveredClasses[index]!,
    );
    return {
      path: position.path,
      kind: "divided",
      covered,
      missing,
      excluded: position.excluded,
    };
  });
  const borders = positions.flatMap(position =>
    position.borders.map((border): BorderCoverage => {
      const coordinates = answeredGivens.flatMap(given =>
        coordinatesIn(position, border.measure, given),
      );
      return {
        path: position.path,
        rule: border.rule,
        points: border.points.map(point => ({
          role: point.role,
          relation: point.relation,
          status:
            point.status !== "owed"
              ? point.status
              : coordinates.some(value => point.contains(value))
                ? "met"
                : "gap",
        })),
      };
    }),
  );
  const adequate =
    specification.implementation !== undefined &&
    failures.length === 0 &&
    unansweredRows.length === 0 &&
    pendingDecisions.length === 0 &&
    controlGaps.length === 0 &&
    dependencyIssues.length === 0 &&
    input.missing.length === 0 &&
    result.missing.length === 0 &&
    effects.missing.length === 0 &&
    partitions.every(
      partition => partition.kind !== "divided" || partition.missing.length === 0,
    ) &&
    borders.every(border => border.points.every(point => point.status !== "gap"));

  const arms: Measure =
    specification.implementation === undefined
      ? { status: "unavailable", reason: "not applicable" }
      : {
          status: "unavailable",
          reason: "not measured",
          notRead: Object.values(specification.implementation.cases).flatMap(decision =>
            decision.kind === "decision" ? [decision.id] : [],
          ),
        };
  const verdict: Verdict = !adequate
    ? "not_satisfied"
    : arms.reason === "not measured"
      ? "undetermined"
      : "satisfied";

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
    dependencyIssues,
    failures,
    partitions,
    borders,
    evidence: {
      input: definition.input.variantTags.map(tag => ({
        case: tag,
        specified: coveredInputs.has(tag),
        executed: executedInputs.has(tag),
        verified: verifiedInputs.has(tag),
      })),
      result: isSumSchema(definition.result)
        ? definition.result.variantTags.map(tag => ({
            case: tag,
            specified: coveredResults.has(tag),
            observed: observedResults.has(tag),
            verified: verifiedResults.has(tag),
          }))
        : [],
      effects: definition.effects.variantTags.map(tag => ({
        case: tag,
        specified: coveredEffects.has(tag),
        observed: observedEffects.has(tag),
        verified: verifiedEffects.has(tag),
      })),
    },
    measures: { arms },
    adequate,
    verdict,
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

  const origins = rows.filter(row => !isUnanswered(row.expect)).map(row => row.given);
  const originFor = (position: Position): unknown =>
    origins.find(given => position.valuesIn(given).length > 0) ??
    definition.input.placeholder();

  const generated: GeneratedExample[] = definition.input.variantTags
    .filter(tag => !existing.has(tag))
    .map(tag => ({
      name: `${definition.name}: ${tag}`,
      given: definition.input.placeholderFor(tag),
      reason: `${tag}の期待結果を人間が決める必要があります`,
    }));

  for (const position of positionsOf(definition.input)) {
    if (position.kind !== "divided") {
      continue;
    }
    for (const className of position.classes) {
      if (position.excluded.includes(className)) {
        continue;
      }
      const standsIn = [...rows, ...generated].some(row =>
        position.classify(row.given).includes(className),
      );
      if (!standsIn) {
        generated.push({
          name: `${definition.name}: ${position.path} = ${className}`,
          given: position.place(originFor(position), className),
          reason: `${position.path}が${className}の期待結果を人間が決める必要があります`,
        });
      }
    }
  }

  for (const position of positionsOf(definition.input)) {
    for (const border of position.borders) {
      for (const point of border.points) {
        if (point.status !== "owed" || point.witness === undefined) {
          continue;
        }
        const standsAt = [...rows, ...generated].some(row =>
          coordinatesIn(position, border.measure, row.given).some(value => point.contains(value)),
        );
        if (!standsAt) {
          generated.push({
            name: `${definition.name}: ${position.path} ${point.role} (${point.relation})`,
            given: position.write(originFor(position), border.measure, point.witness),
            reason: `${position.path}の${point.role}点（${point.relation}）の期待結果を人間が決める必要があります`,
          });
        }
      }
    }
  }

  return generated;
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
    const { failure } = await runAndCompare(row.name, row.given, row.expect, subject);
    if (failure !== undefined) {
      failures.push(failure);
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
