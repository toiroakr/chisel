import { isDeepStrictEqual } from "node:util";
import type {
  AnyBehavior,
  AnyImplementation,
  BehaviorEffect,
  BehaviorInput,
  BehaviorResult,
  Execution,
  Implementation,
  Todo,
} from "./behavior.js";
import type { ArmTaken, ComparisonReached, WayTaken } from "./behavior.js";
import type { Way } from "./ways.js";
import { describeWay, sameSteps, waysOf } from "./ways.js";
import type { FakeTable, ValueDependencies } from "./dependency.js";
import { answerFrom, fakeIssuesOf, fakeWarningsOf } from "./dependency.js";
import {
  comparisonsNotReadOf,
  ensuresBordersOf,
  guardBordersOf,
  guardPartitionsOf,
  guardScope,
} from "./guard-borders.js";
import {
  brokenEnsures,
  comparisonsReached,
  isTodo,
  runImplementation,
  runTraced,
  traceSync,
} from "./behavior.js";
import { describeRule, describeTerm, isTerm, termData } from "./rule.js";
import type { Term } from "./rule.js";
import type { BorderPoint, PointRole } from "./border.js";
import { emptiedBy, normalize } from "./border.js";
import { feasibilityOf } from "./feasibility.js";
import { readEnsures } from "./ensures.js";
import type { EnsuresReport } from "./ensures.js";
import type { Feasibility } from "./feasibility.js";
import type { GuardBorder, GuardPartition } from "./guard-borders.js";
import type { Position } from "./partition.js";
import { coordinatesIn, excludedCases, positionsOf } from "./partition.js";
import { isVariantsSchema, tagOf } from "./schema.js";
import type { AnySchema } from "./schema.js";

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

export type BehaviorWith<B> = B extends { readonly requires: infer Requires }
  ? Partial<ValueDependencies<Requires>>
  : never;

export interface Example<B extends AnyBehavior> {
  readonly kind: "example";
  readonly name: string;
  readonly given: BehaviorInput<B>;
  readonly with?: BehaviorWith<B>;
  readonly expect: Execution<BehaviorResult<B>, BehaviorEffect<B>> | Todo;
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
  readonly fakes: readonly FakeTable[];
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
  readonly modelIssues: readonly string[];
  readonly incompleteness: readonly Incompleteness[];
  readonly ensures: EnsuresReport;
  readonly failures: readonly ExampleFailure[];
  readonly partitions: readonly PartitionCoverage[];
  readonly borders: readonly BorderCoverage[];
  readonly pairs: readonly PairCount[];
  readonly fakeIssues: readonly string[];
  readonly fakeWarnings: readonly string[];
  readonly evidence: {
    readonly input: readonly InputCaseEvidence[];
    readonly result: readonly ResultCaseEvidence[];
    readonly effects: readonly ResultCaseEvidence[];
  };
  readonly measures: {
    readonly arms: Measure;
    readonly rules: RulesMeasure;
    readonly comparisons: ComparisonsMeasure;
  };
  readonly adequate: boolean;
  readonly verdict: Verdict;
}

export type Verdict = "satisfied" | "not_satisfied" | "undetermined";

export type CoverageStatus = "met" | "gap" | "answer owed" | "no row owed" | "undecided";

export interface Incompleteness {
  readonly kind: "row not run" | "row did not come back";
  readonly subject: string;
  readonly reason: string;
}

export interface ArmCoverage {
  readonly decision: string;
  readonly guard: string;
  readonly arm: string;
  readonly status: CoverageStatus;
  readonly reason?: string;
}

export type ComparisonsMeasure =
  | { readonly status: "complete" }
  | { readonly status: "partial"; readonly notRead: readonly string[] };

export interface RuleCoverage {
  readonly decision: string;
  readonly way: string;
  readonly status: CoverageStatus;
  readonly reason?: string;
}

export type RulesMeasure =
  | { readonly status: "complete"; readonly rules: readonly RuleCoverage[] }
  | {
      readonly status: "partial";
      readonly rules: readonly RuleCoverage[];
      readonly notRead: readonly string[];
    }
  | { readonly status: "unavailable"; readonly reason: "not applicable" }
  | {
      readonly status: "unavailable";
      readonly reason: "not measured";
      readonly notRead: readonly string[];
    };

export type Measure =
  | { readonly status: "complete"; readonly arms: readonly ArmCoverage[] }
  | {
      readonly status: "partial";
      readonly arms: readonly ArmCoverage[];
      readonly notRead: readonly string[];
    }
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

export interface PairCount {
  readonly positions: readonly [string, string];
  readonly reached: number;
  readonly total: number;
}

export interface BorderCoverage {
  readonly path: string;
  readonly rule: string;
  readonly points: readonly {
    readonly role: PointRole;
    readonly relation: string;
    readonly status: "met" | "gap" | "excluded" | "not named" | "no point" | "no row owed" | "undecided";
    readonly reason?: string;
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
  readonly excluded: readonly string[];
  readonly total: number;
}

export interface GeneratedExample {
  readonly name: string;
  readonly given: unknown;
  readonly with?: unknown;
  readonly reason: string;
}

export type ConformanceSubject<B extends AnyBehavior> = (
  input: BehaviorInput<B>,
) =>
  | Execution<BehaviorResult<B>, BehaviorEffect<B>>
  | Promise<Execution<BehaviorResult<B>, BehaviorEffect<B>>>;

export interface ExampleRow<B extends AnyBehavior> {
  readonly given: BehaviorInput<B>;
  readonly with?: BehaviorWith<B>;
  readonly expect: Execution<BehaviorResult<B>, BehaviorEffect<B>> | Todo;
}

export function example<B extends AnyBehavior>(
  _definition: B,
  row: NoInfer<ExampleRow<B>>,
): ExampleRow<B> {
  return row;
}

export function examples<B extends AnyBehavior>(
  behavior: B,
  table: NoInfer<Readonly<Record<string, ExampleRow<B>>>>,
): ExampleSet<B> {
  return {
    kind: "example-set",
    behavior,
    rows: Object.entries(table).map(([name, row]) => ({ kind: "example" as const, name, ...row })),
  };
}

export function spec<B extends AnyBehavior>(options: {
  readonly name: string;
  readonly examples: ExampleSet<B>;
  readonly implementation?: Implementation<B>;
  readonly fakes?: readonly FakeTable[];
}): Specification<B> {
  return {
    kind: "specification",
    name: options.name,
    examples: options.examples,
    implementation: options.implementation,
    fakes: options.fakes ?? [],
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
  const armsMet: ArmTaken[] = [];
  const armsOwed: ArmTaken[] = [];
  const reached: ComparisonReached[] = [];
  const waysMet: WayTaken[] = [];
  const waysOwed: WayTaken[] = [];
  const fakeIssues = fakeIssuesOf(definition.requires, definition.name, specification.fakes);
  const tables = new Map(
    specification.fakes
      .filter(table => !fakeIssues.some(item => item.table.dependency === table.dependency))
      .map(table => [table.dependency, answerFrom(table)] as const),
  );
  const standIns = (row: Example<AnyBehavior>): unknown => ({
    ...Object.fromEntries(tables),
    ...(row.with ?? {}),
  });
  const incompleteness: Incompleteness[] = [];
  const unstoodFor = (row: Example<AnyBehavior>): string | undefined => {
    const written = (row.with ?? {}) as Readonly<Record<string, unknown>>;
    for (const [name, value] of Object.entries(written)) {
      const declared = definition.requires[name];
      if (declared === undefined) {
        return `with ${name} names no dependency of ${definition.name}`;
      }
      const parsed = declared.output.parse(value);
      if (!parsed.success) {
        return `with ${name} is not a value the dependency answers: ${parsed.issues[0]!.message}`;
      }
    }
    const missing = Object.keys(definition.requires).find(
      name => !(name in written) && !tables.has(name),
    );
    return missing === undefined ? undefined : `No stand-in for dependency ${missing}`;
  };
  const observe = (
    inputTag: string,
    actual: unknown,
  ): { readonly result: string | undefined; readonly effects: ReadonlySet<string> } => {
    executedInputs.add(inputTag);
    const execution = actual as Execution<unknown, unknown>;
    const result = isVariantsSchema(definition.result)
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

    if (isTodo(row.expect)) {
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
      const unstoodOwed = unstoodFor(row);
      if (implementation !== undefined && unstoodOwed !== undefined) {
        failures.push({ name: row.name, message: unstoodOwed });
        incompleteness.push({ kind: "row not run", subject: row.name, reason: unstoodOwed });
      } else if (
        implementation !== undefined &&
        (implementation.stages !== undefined ||
          (decision !== undefined && decision.kind !== "todo"))
      ) {
        try {
          const traced = await runTraced(implementation, row.given, standIns(row) as never);
          observe(inputTag!, traced.execution);
          armsOwed.push(...traced.arms);
          if (traced.way !== undefined) {
            waysOwed.push(traced.way);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ name: row.name, message });
          incompleteness.push({ kind: "row did not come back", subject: row.name, reason: message });
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

    const broken = brokenEnsures(definition, row.given, row.expect.result);
    if (broken !== undefined) {
      failures.push({
        name: row.name,
        message: `Example breaks ensures ${broken.name}: ${describeRule(broken.rule, "")}`,
      });
    }

    const resultTag = isVariantsSchema(definition.result)
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
    const unstood = unstoodFor(row);
    if (implementation !== undefined && unstood !== undefined) {
      failures.push({ name: row.name, message: unstood });
      incompleteness.push({ kind: "row not run", subject: row.name, reason: unstood });
    } else if (implementation !== undefined) {
      const { actual, failure } = await runAndCompare(
        row.name,
        row.given,
        row.expect,
        async input => {
          const traced = await runTraced(implementation, input, standIns(row) as never);
          armsMet.push(...traced.arms);
          reached.push(...traced.comparisons);
          if (traced.way !== undefined) {
            waysMet.push(traced.way);
          }
          return traced.execution;
        },
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
        if (actual === undefined) {
          incompleteness.push({
            kind: "row did not come back",
            subject: row.name,
            reason: failure.message,
          });
        }
      }
    }
  }

  const pendingDecisions =
    specification.implementation === undefined
      ? []
      : Object.entries(specification.implementation.cases).flatMap(
          ([variant, decision]) =>
            decision.kind === "todo"
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
          return "kind" in control && control.kind === "todo"
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

  const refusedInputs = excludedCases(definition.input);
  const input = coverage(definition.input.variantTags, coveredInputs, refusedInputs);
  const result = isVariantsSchema(definition.result)
    ? coverage(definition.result.variantTags, coveredResults)
    : coverage([], new Set());
  const effects = coverage(definition.effects.variantTags, coveredEffects);
  const modelIssues = positions.flatMap(position => {
    const emptied = emptiedBy(position.borders);
    return emptied === undefined
      ? []
      : [
          `${position.path}: 不変条件を満たす値がありません (${emptied
            .map(border => border.rule)
            .join(", ")})`,
        ];
  });
  const guardPartitions =
    specification.implementation === undefined
      ? []
      : guardPartitionsOf(specification.implementation);
  const partitions = positions.map((position, index): PartitionCoverage => {
    const drawn = guardPartitions.find(partition => partition.path === position.path);
    if (drawn !== undefined && position.kind !== "divided") {
      const values = answeredGivens.flatMap(given => position.valuesIn(given));
      const names = drawn.classes.map(item => item.name);
      const reached = new Set(
        drawn.classes
          .filter(item => values.some(value => value !== undefined && item.contains(value)))
          .map(item => item.name),
      );
      const { covered, missing } = coverage(names, reached);
      return {
        path: position.path,
        kind: "divided",
        covered,
        missing,
        excluded: drawn.excluded,
      };
    }
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
  const borders: BorderCoverage[] = positions.flatMap(position =>
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
  const guardBorders = (
    specification.implementation === undefined ? [] : guardBordersOf(specification.implementation)
  ).map((drawn): BorderCoverage => {
    const coordinates = reached
      .filter(item => item.rule === drawn.comparison)
      .map(item => drawn.coordinateOf(item));
    return {
      path: drawn.path,
      rule: drawn.border.rule,
      points: drawn.border.points.map(point => {
        const base = { role: point.role, relation: point.relation };
        if (point.status !== "owed") {
          return { ...base, status: point.status };
        }
        if (coordinates.some(value => point.contains(value))) {
          return { ...base, status: "met" as const };
        }
        return { ...base, ...unmetStatus(reachOf(drawn, point)) };
      }),
    };
  });
  borders.push(...guardBorders);
  const ensuresBorders = ensuresBordersOf(definition).map((drawn): BorderCoverage => {
    const coordinates = answeredGivens
      .filter(given => drawn.path.startsWith(`@${tagOf(definition.input, given)}.`))
      .map(given => drawn.coordinateOf({ rule: drawn.comparison, scope: given }));
    return {
      path: drawn.path,
      rule: drawn.border.rule,
      points: drawn.border.points.map(point => ({
        role: point.role,
        relation: point.relation,
        status:
          point.status !== "owed"
            ? point.status
            : coordinates.some(value => value !== undefined && point.contains(value))
              ? "met"
              : "gap",
      })),
    };
  });
  borders.push(...ensuresBorders);
  const adequate =
    fakeIssues.length === 0 &&
    specification.implementation !== undefined &&
    failures.length === 0 &&
    unansweredRows.length === 0 &&
    pendingDecisions.length === 0 &&
    controlGaps.length === 0 &&
    dependencyIssues.length === 0 &&
    modelIssues.length === 0 &&
    input.missing.length === 0 &&
    result.missing.length === 0 &&
    effects.missing.length === 0 &&
    partitions.every(
      partition => partition.kind !== "divided" || partition.missing.length === 0,
    ) &&
    borders.every(border => border.points.every(point => point.status !== "gap"));

  const arms = measureArms(specification.implementation, armsMet, armsOwed);
  const rulesMeasure = measureRules(specification.implementation, waysMet, waysOwed);
  const lines = [
    ...(arms.status === "unavailable" ? [] : arms.arms),
    ...(rulesMeasure.status === "unavailable" ? [] : rulesMeasure.rules),
  ];
  const armGap = lines.some(line => line.status === "gap" || line.status === "answer owed");
  const armUndecided =
    lines.some(line => line.status === "undecided") ||
    borders.some(border => border.points.some(point => point.status === "undecided"));
  const unreadComparisons =
    specification.implementation === undefined
      ? []
      : comparisonsNotReadOf(specification.implementation);
  const comparisons: ComparisonsMeasure =
    unreadComparisons.length === 0
      ? { status: "complete" }
      : { status: "partial", notRead: unreadComparisons };
  const verdict: Verdict =
    !adequate || armGap
      ? "not_satisfied"
      : comparisons.status === "partial" || armUndecided
        ? "undetermined"
        : arms.status === "complete" ||
          (arms.status === "unavailable" && arms.reason === "not applicable")
        ? "satisfied"
        : "undetermined";

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
    modelIssues,
    incompleteness,
    ensures: readEnsures(definition),
    failures,
    partitions,
    borders,
    pairs: countPairs(pairablesOf(positions, guardPartitions), answeredGivens),
    fakeIssues: fakeIssues.map(item => item.issue),
    fakeWarnings: fakeWarningsOf(definition.requires, specification.fakes),
    evidence: {
      input: definition.input.variantTags.filter(tag => !refusedInputs.includes(tag)).map(tag => ({
        case: tag,
        specified: coveredInputs.has(tag),
        executed: executedInputs.has(tag),
        verified: verifiedInputs.has(tag),
      })),
      result: isVariantsSchema(definition.result)
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
    measures: { arms, rules: rulesMeasure, comparisons },
    adequate: adequate && !armGap,
    verdict,
  };
}

export function generateExamples(
  target: AnyBehavior | ExampleSet<AnyBehavior>,
  implementation?: AnyImplementation,
): readonly GeneratedExample[] {
  return generationReport(target, implementation).rows;
}

export interface GenerationReport {
  readonly rows: readonly GeneratedExample[];
  readonly notComposed: readonly string[];
}

export function generationReport(
  target: AnyBehavior | ExampleSet<AnyBehavior>,
  implementation?: AnyImplementation,
): GenerationReport {
  const definition = target.kind === "behavior" ? target : target.behavior;
  const rows = target.kind === "behavior" ? [] : target.rows;
  const existing = new Set(
    rows
      .map(row => tagOf(definition.input, row.given))
      .filter((tag): tag is string => tag !== undefined),
  );

  const answeredRows = rows.filter(row => !isTodo(row.expect));
  const origins = answeredRows.map(row => row.given);
  const withFrom = (origin: unknown): { readonly with?: unknown } => {
    const written = answeredRows.find(row => row.given === origin)?.with;
    return written === undefined ? {} : { with: written };
  };
  const originFor = (position: Position): unknown =>
    origins.find(given => position.valuesIn(given).length > 0) ??
    definition.input.placeholder();

  const generated: GeneratedExample[] = [];
  const notComposed: string[] = [];
  const offer = (row: GeneratedExample): void => {
    const parsed = definition.input.parse(row.given);
    if (parsed.success) {
      generated.push(row);
    } else {
      notComposed.push(`${row.name}: ${parsed.issues[0]!.message}`);
    }
  };
  const refused = excludedCases(definition.input);
  for (const tag of definition.input.variantTags.filter(
    tag => !existing.has(tag) && !refused.includes(tag),
  )) {
    offer({
      name: `${definition.name}: ${tag}`,
      given: definition.input.placeholderFor(tag),
      reason: `${tag}の期待結果を人間が決める必要があります`,
    });
  }

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
        const origin = originFor(position);
        offer({
          name: `${definition.name}: ${position.path} = ${className}`,
          given: position.place(origin, className),
          reason: `${position.path}が${className}の期待結果を人間が決める必要があります`,
          ...withFrom(origin),
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
          const origin = originFor(position);
          offer({
            name: `${definition.name}: ${position.path} ${point.role} (${point.relation})`,
            given: position.write(origin, border.measure, point.witness),
            reason: `${position.path}の${point.role}点（${point.relation}）の期待結果を人間が決める必要があります`,
            ...withFrom(origin),
          });
        }
      }
    }
  }

  const positionsByPath = new Map(
    positionsOf(definition.input).map(position => [position.path, position] as const),
  );
  for (const drawn of implementation === undefined ? [] : guardPartitionsOf(implementation)) {
    const position = positionsByPath.get(drawn.path);
    if (position === undefined) {
      continue;
    }
    for (const item of drawn.classes) {
      const standsIn = [...rows, ...generated].some(row =>
        position.valuesIn(row.given).some(value => value !== undefined && item.contains(value)),
      );
      if (!standsIn) {
        const origin = originFor(position);
        offer({
          name: `${definition.name}: ${drawn.path} = ${item.name}`,
          given: position.write(origin, "value", item.witness),
          reason: `${drawn.path}が${item.name}の期待結果を人間が決める必要があります`,
          ...withFrom(origin),
        });
      }
    }
  }

  for (const drawn of implementation === undefined ? [] : guardBordersOf(implementation)) {
    const reachedBy = (given: unknown, deps: unknown) =>
      comparisonsReached(implementation!, given, deps).filter(
        item => item.rule === drawn.comparison,
      );
    for (const point of drawn.border.points) {
      if (point.status !== "owed" || point.witness === undefined) {
        continue;
      }
      const standsAt = [...rows, ...generated].some(row =>
        reachedBy(row.given, row.with).some(item => point.contains(drawn.coordinateOf(item))),
      );
      if (standsAt || unmetStatus(reachOf(drawn, point)).status === "no row owed") {
        continue;
      }
      const origin =
        origins.find(given => reachedBy(given, withFrom(given).with).length > 0) ??
        definition.input.placeholder();
      const given = drawn.compose(origin, point.witness, withFrom(origin).with);
      if (given === undefined) {
        notComposed.push(`${drawn.path} ${point.role} (${point.relation})`);
      } else {
        offer({
          name: `${definition.name}: ${drawn.path} ${point.role} (${point.relation})`,
          given,
          reason: `${drawn.path}の${point.role}点（${point.relation}）の期待結果を人間が決める必要があります`,
          ...withFrom(origin),
        });
      }
    }
  }

  for (const [tag, decision] of Object.entries(implementation?.cases ?? {})) {
    if (decision.kind !== "rules") {
      continue;
    }
    const wayOf = (given: unknown, deps: unknown) => traceSync(implementation!, given, deps).way;
    const takes = (given: unknown, deps: unknown, way: Way) => {
      const taken = wayOf(given, deps);
      return taken !== undefined && sameSteps(taken.steps, way.steps);
    };
    for (const way of waysOf(decision)) {
      if ([...rows, ...generated].some(row => takes(row.given, row.with, way))) {
        continue;
      }
      if (feasibilityOf(way, scopeOf(implementation!, tag)).kind === "infeasible") {
        continue;
      }
      const composed = composeForWay(way, tag);
      if (
        composed !== undefined &&
        takes(composed.given, withFrom(composed.origin).with, way)
      ) {
        offer({
          name: `${definition.name}: ${decision.id} ${describeWay(way)}`,
          given: composed.given,
          reason: `${decision.id}の道筋（${describeWay(way)}）の期待結果を人間が決める必要があります`,
          ...withFrom(composed.origin),
        });
      } else {
        notComposed.push(`${decision.id}: ${describeWay(way)}`);
      }
    }

    function composeForWay(
      way: Way,
      caseTag: string,
    ): { readonly given: unknown; readonly origin: unknown } | undefined {
      const last = way.steps[way.steps.length - 1];
      if (last === undefined || last.distinction.kind !== "match") {
        return undefined;
      }
      const matched = last.distinction;
      const keys = termData(matched.on).path;
      const position = positionsByPath.get(
        `@${caseTag}${keys.slice(0, -1).map(key => `.${key}`).join("")}`,
      );
      const origin = origins.find(given =>
        wayOf(given, withFrom(given).with)?.steps.some(step => step.distinction === matched),
      );
      return position?.kind === "divided" && origin !== undefined
        ? { given: position.place(origin, String(last.outcome)), origin }
        : undefined;
    }
  }

  return { rows: generated, notComposed };
}

export async function verifyConformance<B extends AnyBehavior>(
  exampleSet: ExampleSet<B>,
  subject: NoInfer<ConformanceSubject<B>>,
): Promise<readonly ExampleFailure[]> {
  const failures: ExampleFailure[] = [];
  for (const row of exampleSet.rows) {
    if (isTodo(row.expect)) {
      continue;
    }
    const { actual, failure } = await runAndCompare(row.name, row.given, row.expect, subject);
    const broken =
      actual === undefined
        ? undefined
        : brokenEnsures(
            exampleSet.behavior,
            row.given,
            (actual as Execution<unknown, unknown>).result,
          );
    if (broken !== undefined) {
      failures.push({
        name: row.name,
        message: `Answer breaks ensures ${broken.name}: ${describeRule(broken.rule, "")}`,
      });
      continue;
    }
    if (failure !== undefined) {
      failures.push(failure);
    }
  }
  return failures;
}

interface Pairable {
  readonly path: string;
  readonly classes: readonly string[];
  classify(given: unknown): readonly string[];
}

function pairablesOf(
  positions: readonly Position[],
  guardPartitions: readonly GuardPartition[],
): Pairable[] {
  return positions.flatMap((position): Pairable[] => {
    if (position.kind === "divided") {
      return [
        {
          path: position.path,
          classes: position.classes.filter(name => !position.excluded.includes(name)),
          classify: given => position.classify(given),
        },
      ];
    }
    const drawn = guardPartitions.find(partition => partition.path === position.path);
    if (drawn === undefined) {
      return [];
    }
    return [
      {
        path: position.path,
        classes: drawn.classes.map(item => item.name),
        classify: given =>
          position
            .valuesIn(given)
            .flatMap(value =>
              value === undefined
                ? []
                : drawn.classes.filter(item => item.contains(value)).map(item => item.name),
            ),
      },
    ];
  });
}

function countPairs(pairables: readonly Pairable[], givens: readonly unknown[]): PairCount[] {
  const pairs: PairCount[] = [];
  pairables.forEach((left, index) => {
    for (const right of pairables.slice(index + 1)) {
      if (!combine(left.path, right.path)) {
        continue;
      }
      const reached = new Set(
        givens.flatMap(given =>
          left
            .classify(given)
            .flatMap(first => right.classify(given).map(second => `${first}\u0000${second}`)),
        ),
      );
      pairs.push({
        positions: [left.path, right.path],
        reached: reached.size,
        total: left.classes.length * right.classes.length,
      });
    }
  });
  return pairs;
}

function combine(left: string, right: string): boolean {
  if (right.startsWith(`${left}@`) || left.startsWith(`${right}@`)) {
    return false;
  }
  const narrowings = (path: string) =>
    [...path.matchAll(/@([^.@\[\]{}?]+)/g)].map(found => ({
      before: path.slice(0, found.index),
      tag: found[1],
    }));
  const rightNarrowings = narrowings(right);
  return narrowings(left).every(narrowing =>
    rightNarrowings.every(
      other => other.before !== narrowing.before || other.tag === narrowing.tag,
    ),
  );
}

function measureRules(
  implementation: Implementation<AnyBehavior> | undefined,
  met: readonly WayTaken[],
  owed: readonly WayTaken[],
): RulesMeasure {
  if (implementation === undefined || implementation.stages !== undefined) {
    return { status: "unavailable", reason: "not applicable" };
  }
  const decisions = Object.values(implementation.cases);
  const notRead = decisions.flatMap(decision =>
    decision.kind === "decision" ? [decision.id] : [],
  );
  const took = (taken: readonly WayTaken[], decision: string, steps: Parameters<typeof sameSteps>[0]) =>
    taken.some(item => item.decision === decision && sameSteps(item.steps, steps));
  const rules = Object.entries(implementation.cases).flatMap(([tag, decision]) =>
    decision.kind !== "rules"
      ? []
      : waysOf(decision).map((way): RuleCoverage => {
          const base = { decision: decision.id, way: describeWay(way) };
          if (took(met, decision.id, way.steps)) {
            return { ...base, status: "met" };
          }
          if (took(owed, decision.id, way.steps)) {
            return { ...base, status: "answer owed" };
          }
          return { ...base, ...unmetStatus([feasibilityOf(way, scopeOf(implementation, tag))]) };
        }),
  );
  if (notRead.length === 0) {
    return { status: "complete", rules };
  }
  return rules.length === 0
    ? { status: "unavailable", reason: "not measured", notRead }
    : { status: "partial", rules, notRead };
}

function measureArms(
  implementation: Implementation<AnyBehavior> | undefined,
  met: readonly ArmTaken[],
  owed: readonly ArmTaken[],
): Measure {
  if (implementation === undefined || implementation.stages !== undefined) {
    return { status: "unavailable", reason: "not applicable" };
  }
  const decisions = Object.values(implementation.cases);
  const notRead = decisions.flatMap(decision =>
    decision.kind === "decision" ? [decision.id] : [],
  );
  const took = (taken: readonly ArmTaken[], decision: string, guard: number, arm: string) =>
    taken.some(item => item.decision === decision && item.guard === guard && item.arm === arm);
  const arms = Object.entries(implementation.cases).flatMap(([tag, decision]) => {
    if (decision.kind !== "rules") {
      return [];
    }
    const ways = waysOf(decision).map(way => ({
      way,
      feasibility: feasibilityOf(way, scopeOf(implementation, tag)),
    }));
    const through = (index: number, arm: string) =>
      ways.filter(({ way }) =>
        index === decision.guards.length
          ? way.exit === "case" && way.steps[way.steps.length - 1]?.outcome === arm
          : arm === "else"
            ? way.exit === index
            : typeof way.exit !== "number" || way.exit > index,
      );
    const statusOf = (index: number, arm: string): Pick<ArmCoverage, "status" | "reason"> =>
      took(met, decision.id, index, arm)
        ? { status: "met" }
        : took(owed, decision.id, index, arm)
          ? { status: "answer owed" }
          : unmetStatus(through(index, arm).map(item => item.feasibility));
    const guarded = decision.guards.flatMap((candidate, index) =>
      (["holds", "else"] as const).map(
        (arm): ArmCoverage => ({
          decision: decision.id,
          guard: describeRule(candidate.condition),
          arm,
          ...statusOf(index, arm),
        }),
      ),
    );
    const { otherwise } = decision;
    const matched =
      typeof otherwise === "function"
        ? []
        : Object.keys(otherwise.cases).map(
            (arm): ArmCoverage => ({
              decision: decision.id,
              guard: `match ${describeTerm(otherwise.on)}`,
              arm,
              ...statusOf(decision.guards.length, arm),
            }),
          );
    return [...guarded, ...matched];
  });
  if (notRead.length === 0) {
    return { status: "complete", arms };
  }
  return arms.length === 0
    ? { status: "unavailable", reason: "not measured", notRead }
    : { status: "partial", arms, notRead };
}

function unmetStatus(
  feasibilities: readonly Feasibility[],
): { readonly status: "gap" | "no row owed" | "undecided"; readonly reason?: string } {
  if (feasibilities.length === 0 || feasibilities.some(item => item.kind === "feasible")) {
    return { status: "gap" };
  }
  const undecided = feasibilities.find(item => item.kind === "undecided");
  if (undecided !== undefined) {
    return { status: "undecided", reason: undecided.reason };
  }
  return { status: "no row owed", reason: (feasibilities[0] as { readonly reason: string }).reason };
}

function reachOf(drawn: GuardBorder, point: BorderPoint): readonly Feasibility[] {
  const normalized = normalize(drawn.comparison);
  if (drawn.origin === undefined || point.region === undefined || normalized === undefined) {
    return [{ kind: "feasible" }];
  }
  const { decision, scope } = drawn.origin;
  const term = (
    isTerm(drawn.comparison.left) ? drawn.comparison.left : drawn.comparison.right
  ) as Term<unknown>;
  const placement = {
    path: termData(term).path,
    measure: normalized.measure,
    ...point.region,
  };
  const prefixes = waysOf(decision).flatMap(way => {
    const index = way.steps.findIndex(step => step.distinction === drawn.comparison);
    return index === -1 ? [] : [way.steps.slice(0, index)];
  });
  return prefixes.length === 0
    ? [{ kind: "feasible" }]
    : prefixes.map(steps => feasibilityOf({ steps }, scope, placement));
}

function scopeOf(implementation: Implementation<AnyBehavior>, tag: string): AnySchema {
  return guardScope(implementation.behavior, tag);
}

function coverage(
  all: readonly string[],
  covered: ReadonlySet<string>,
  excluded: readonly string[] = [],
): Coverage {
  const counted = all.filter(value => !excluded.includes(value));
  return {
    covered: counted.filter(value => covered.has(value)),
    missing: counted.filter(value => !covered.has(value)),
    excluded: all.filter(value => excluded.includes(value)),
    total: counted.length,
  };
}
