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
  SpecificationError,
  TodoDecision,
  brokenEnsures,
  comparisonsReached,
  isTodo,
  perform,
  runTraced,
  traceSync,
} from "./behavior.js";
import { DEPS, describeRule, describeTerm, isTerm, termData } from "./rule.js";
import type { Rule, Term } from "./rule.js";
import type { BorderPoint, PointRole } from "./border.js";
import { emptiedBy, normalize } from "./border.js";
import { feasibilityOf, witnessesOf } from "./feasibility.js";
import { readEnsures } from "./ensures.js";
import type { EnsuresReport } from "./ensures.js";
import type { Feasibility } from "./feasibility.js";
import type { GuardBorder, GuardPartition } from "./guard-borders.js";
import type { DividedInstance, Position } from "./partition.js";
import { coordinatesIn, excludedCases, positionsOf } from "./partition.js";
import { isVariantsSchema, tagOf } from "./schema.js";
import type { AnySchema } from "./schema.js";

interface RunOutcome {
  readonly actual: unknown;
  readonly failure: ExampleFailure | undefined;
  readonly error?: unknown;
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
      error,
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
  readonly kind: "row not run" | "row did not come back" | "disregards not checked";
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

export function spec<B extends AnyBehavior>(name: string, options: {
  readonly examples: ExampleSet<B>;
  readonly implementation?: Implementation<B>;
  readonly fakes?: readonly FakeTable[];
}): Specification<B> {
  return {
    kind: "specification",
    name,
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

export interface CheckOptions {
  // How far the disregards check goes, a policy of the caller rather than of
  // the check: past either limit a row is not tried and is reported as such.
  readonly disregards?: {
    readonly combinations?: number;
    readonly candidates?: number;
  };
}

export async function check(
  specification: Specification,
  options: CheckOptions = {},
): Promise<AdequacyReport> {
  const limits = {
    combinations: disregardLimit("combinations", options.disregards?.combinations, DISREGARD_COMBINATION_LIMIT),
    candidates: disregardLimit("candidates", options.disregards?.candidates, DISREGARD_CANDIDATE_LIMIT),
  };
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
  const guardPartitions =
    specification.implementation === undefined
      ? []
      : guardPartitionsOf(specification.implementation);
  const positions = measuredPositionsOf(
    definition,
    new Set(guardPartitions.map(partition => trailKey(partition.segments))),
    guardReadSegmentsOf(specification.implementation),
  );
  const coveredClasses = positions.map(() => new Set<string>());
  const answeredGivens: unknown[] = [];
  const armsMet: ArmTaken[] = [];
  const armsOwed: ArmTaken[] = [];
  const reached: { readonly tag: string | undefined; readonly comparison: ComparisonReached }[] = [];
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
  const externals = externalsIn(specification.implementation);
  const notRunFor = (row: Example<AnyBehavior>): boolean => {
    if (externals.length === 0) {
      return false;
    }
    incompleteness.push({
      kind: "row not run",
      subject: row.name,
      reason: `外部の段のため実行できない（${externals.join("、")}）`,
    });
    return true;
  };
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
      if (implementation !== undefined && notRunFor(row)) {
        continue;
      }
      if (implementation !== undefined && unstoodOwed !== undefined) {
        failures.push({ name: row.name, message: unstoodOwed });
        incompleteness.push({ kind: "row not run", subject: row.name, reason: unstoodOwed });
      } else if (
        implementation !== undefined &&
        (implementation.pipeline !== undefined ||
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
          const open = openDecisionIn(implementation, error);
          if (open !== undefined) {
            incompleteness.push({ kind: "row not run", subject: row.name, reason: `判断が未定（${open}）` });
          } else {
            const message = error instanceof Error ? error.message : String(error);
            failures.push({ name: row.name, message });
            incompleteness.push({ kind: "row did not come back", subject: row.name, reason: message });
          }
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
    if (implementation !== undefined && notRunFor(row)) {
      continue;
    }
    if (implementation !== undefined && unstood !== undefined) {
      failures.push({ name: row.name, message: unstood });
      incompleteness.push({ kind: "row not run", subject: row.name, reason: unstood });
    } else if (implementation !== undefined) {
      const { actual, failure, error } = await runAndCompare(
        row.name,
        row.given,
        row.expect,
        async input => {
          const traced = await runTraced(implementation, input, standIns(row) as never);
          armsMet.push(...traced.arms);
          reached.push(
            ...traced.comparisons.map(comparison => ({ tag: tagOf(definition.input, input), comparison })),
          );
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
          const disregard = await disregardBroken(
            implementation,
            row,
            actual,
            standIns(row),
            limits,
          );
          if (disregard.kind === "broken") {
            failures.push(disregard.failure);
          } else if (disregard.kind === "not checked") {
            incompleteness.push(disregard.incompleteness);
          }
        }
      }
      const open = openDecisionIn(implementation, error);
      if (open !== undefined) {
        incompleteness.push({ kind: "row not run", subject: row.name, reason: `判断が未定（${open}）` });
      } else if (failure !== undefined) {
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

  const pendingDecisions = todoDecisionsIn(specification.implementation);

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

  const refusedInputs = excludedCases(definition.input);
  const input = coverage(definition.input.variantTags, coveredInputs, refusedInputs);
  const result = isVariantsSchema(definition.result)
    ? coverage(definition.result.variantTags, coveredResults)
    : coverage([], new Set());
  const effects = coverage(definition.effects.variantTags, coveredEffects);
  const modelIssues = positionsOf(definition.input).flatMap(position => {
    const emptied = emptiedBy(position.borders);
    return emptied === undefined
      ? []
      : [
          `${position.path}: 不変条件を満たす値がありません (${emptied
            .map(border => border.rule)
            .join(", ")})`,
        ];
  });
  const partitions = positions.map((position, index): PartitionCoverage => {
    const drawn = guardPartitions.find(partition =>
      isDeepStrictEqual(partition.segments, position.segments),
    );
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
      .filter(item => item.comparison.rule === drawn.comparison && item.tag === drawn.origin?.tag)
      .map(item => drawn.coordinateOf(item.comparison));
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
      .filter(given => drawn.segments[0] === `@${tagOf(definition.input, given)}`)
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
      : comparisons.status === "partial" ||
          armUndecided ||
          externals.length > 0 ||
          incompleteness.some(item => item.kind === "disregards not checked")
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

export interface GenerationReport {
  readonly rows: readonly GeneratedExample[];
  readonly notComposed: readonly string[];
}

export interface GenerationOptions {
  readonly ways?: boolean;
}

export function generate(
  target: AnyBehavior | ExampleSet<AnyBehavior>,
  implementation?: AnyImplementation,
  options: GenerationOptions = {},
): GenerationReport {
  const definition = target.kind === "behavior" ? target : target.behavior;
  const rows =
    target.kind === "behavior" ? [] : target.rows.filter(row => definition.input.parse(row.given).success);
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
  const guardDivided = new Set(
    (implementation === undefined ? [] : guardPartitionsOf(implementation)).map(
      partition => trailKey(partition.segments),
    ),
  );
  const guardRead = guardReadSegmentsOf(implementation);
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

  for (const position of measuredPositionsOf(definition, guardDivided, guardRead)) {
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

  for (const position of measuredPositionsOf(definition, guardDivided, guardRead)) {
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
    positionsOf(definition.input).map(position => [trailKey(position.segments), position] as const),
  );
  for (const drawn of implementation === undefined ? [] : guardPartitionsOf(implementation)) {
    const position = positionsByPath.get(trailKey(drawn.segments));
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
      tagOf(definition.input, given) === drawn.origin?.tag
        ? comparisonsReached(implementation!, given, deps).filter(item => item.rule === drawn.comparison)
        : [];
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
      const taken = (candidate: { readonly given: unknown; readonly origin: unknown } | undefined) =>
        candidate !== undefined && takes(candidate.given, withFrom(candidate.origin).with, way)
          ? candidate
          : undefined;
      const composed =
        taken(composeForWay(way, tag)) ??
        (options.ways === true ? taken(composeFromWitnesses(way, tag)) : undefined);
      if (composed !== undefined) {
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

    function composeFromWitnesses(
      way: Way,
      caseTag: string,
    ): { readonly given: unknown; readonly origin: unknown } | undefined {
      const witnesses = witnessesOf(way, scopeOf(implementation!, caseTag));
      if (witnesses === undefined) {
        return undefined;
      }
      // Not a lookup by the term's own trail: a term steps through an optional
      // without naming it, so that trail finds whether the field is left out.
      const at = (path: readonly string[]) => {
        const wanted = trailKey([`@${caseTag}`, ...path.map(key => `.${key}`)]);
        return [...positionsByPath.values()]
          .filter(position => trailKey(position.segments.filter(step => step !== "?")) === wanted)
          .sort((left, right) => right.segments.length - left.segments.length)[0];
      };
      const origin =
        origins.find(given => tagOf(definition.input, given) === caseTag) ??
        definition.input.placeholderFor(caseTag);
      let given: unknown = origin;
      for (const { path, value } of witnesses) {
        const position = at(path) ?? at(path.slice(0, -1));
        if (position?.kind !== "divided") {
          return undefined;
        }
        given = position.place(given, String(value));
      }
      return { given, origin };
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
      // A match on an enum selects the position itself; one on a sum field's
      // discriminant selects the field holding it.
      const at = (path: readonly string[]) =>
        positionsByPath.get(trailKey([`@${caseTag}`, ...path.map(key => `.${key}`)]));
      const position = at(keys) ?? at(keys.slice(0, -1));
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

export interface TestOutcome {
  readonly failures: readonly ExampleFailure[];
  readonly skipped: readonly { readonly name: string; readonly reason: string }[];
}

export async function test<B extends AnyBehavior>(
  exampleSet: ExampleSet<B>,
  subject: NoInfer<ConformanceSubject<B>>,
): Promise<TestOutcome> {
  const failures: ExampleFailure[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const row of exampleSet.rows) {
    if (isTodo(row.expect)) {
      skipped.push({ name: row.name, reason: row.expect.reason });
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
  return { failures, skipped };
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
    const drawn = guardPartitions.find(partition =>
      isDeepStrictEqual(partition.segments, position.segments),
    );
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
  if (implementation === undefined || implementation.pipeline !== undefined) {
    return { status: "unavailable", reason: "not applicable" };
  }
  if (implementation.external !== undefined) {
    return { status: "unavailable", reason: "not measured", notRead: [implementation.behavior.name] };
  }
  const decided = decisionsWithCases(implementation);
  const notRead = decided.flatMap(([decision]) =>
    decision.kind === "decision" ? [decision.id] : [],
  );
  const took = (taken: readonly WayTaken[], decision: string, steps: Parameters<typeof sameSteps>[0]) =>
    taken.some(item => item.decision === decision && sameSteps(item.steps, steps));
  const rules = decided.flatMap(([decision, tags]) =>
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
          return {
            ...base,
            ...unmetStatus(tags.map(tag => feasibilityOf(way, scopeOf(implementation, tag)))),
          };
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
  if (implementation === undefined || implementation.pipeline !== undefined) {
    return { status: "unavailable", reason: "not applicable" };
  }
  if (implementation.external !== undefined) {
    return { status: "unavailable", reason: "not measured", notRead: [implementation.behavior.name] };
  }
  const decided = decisionsWithCases(implementation);
  const notRead = decided.flatMap(([decision]) =>
    decision.kind === "decision" ? [decision.id] : [],
  );
  const took = (taken: readonly ArmTaken[], decision: string, guard: number, arm: string) =>
    taken.some(item => item.decision === decision && item.guard === guard && item.arm === arm);
  const arms = decided.flatMap(([decision, tags]) => {
    if (decision.kind !== "rules") {
      return [];
    }
    const ways = tags.flatMap(tag =>
      waysOf(decision).map(way => ({
        way,
        feasibility: feasibilityOf(way, scopeOf(implementation, tag)),
      })),
    );
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

// Not one entry per case: $default hands one decision to several cases, and
// listing it per case would owe each of its arms once for every case it decides.
function decisionsWithCases(
  implementation: AnyImplementation,
): readonly (readonly [AnyImplementation["cases"][string], readonly string[]])[] {
  const grouped = new Map<AnyImplementation["cases"][string], string[]>();
  for (const [tag, decision] of Object.entries(implementation.cases)) {
    grouped.set(decision, [...(grouped.get(decision) ?? []), tag]);
  }
  return [...grouped];
}

function stagesOf(implementation: AnyImplementation): AnyImplementation[] {
  return implementation.pipeline === undefined
    ? [implementation]
    : implementation.pipeline.flatMap(stagesOf);
}

function todoDecisionsIn(implementation: AnyImplementation | undefined): PendingDecision[] {
  if (implementation === undefined) {
    return [];
  }
  const composed = implementation.pipeline !== undefined;
  return stagesOf(implementation).flatMap(stage =>
    Object.entries(stage.cases).flatMap(([variant, decision]) =>
      decision.kind === "todo"
        ? [{ variant: composed ? `${stage.behavior.name}: ${variant}` : variant, reason: decision.reason }]
        : [],
    ),
  );
}

function openDecisionIn(
  implementation: AnyImplementation,
  error: unknown,
): string | undefined {
  if (!(error instanceof TodoDecision)) {
    return undefined;
  }
  return implementation.pipeline === undefined
    ? error.variant
    : `${error.behavior}: ${error.variant}`;
}

function externalsIn(implementation: AnyImplementation | undefined): string[] {
  if (implementation === undefined) {
    return [];
  }
  if (implementation.external !== undefined) {
    return [`${implementation.behavior.name}: ${implementation.external.reason}`];
  }
  return implementation.pipeline === undefined
    ? []
    : implementation.pipeline.flatMap(stage => externalsIn(stage));
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

function isDisregarded(definition: AnyBehavior, position: Position): boolean {
  return Object.entries(definition.disregards).some(([tag, paths]) =>
    paths.some(keys => isUnder(position, [`@${tag}`, ...keys.map(key => `.${key}`)])),
  );
}

// A term steps through an optional or a nested case without naming it, so the
// markers for those are left out before its keys are compared with a position's.
// Positions are keyed by their segments, not their rendered path, since a key
// holding "." renders the same as the nested path it spells.
function trailKey(segments: readonly string[]): string {
  return JSON.stringify(segments);
}

function isUnder(position: Position, prefix: readonly string[]): boolean {
  const named = namedSegments(position);
  return prefix.every((segment, index) => named[index] === segment);
}

// An element name maps to its trail, or to undefined when the quantifier ranges
// over something other than the input, such as a value dependency.
function segmentsRead(
  rule: Rule,
  root: readonly string[],
  elements: ReadonlyMap<string, readonly string[] | undefined>,
): (readonly string[])[] {
  const trailOf = (term: unknown): readonly string[] | undefined => {
    if (!isTerm(term)) {
      return undefined;
    }
    const [head, ...rest] = termData(term).path;
    if (head === undefined || head === DEPS) {
      return undefined;
    }
    if (elements.has(head)) {
      const base = elements.get(head);
      return base === undefined ? undefined : [...base, ...rest.map(key => `.${key}`)];
    }
    return [...root, `.${head}`, ...rest.map(key => `.${key}`)];
  };
  switch (rule.kind) {
    case "compare":
      return [rule.left, rule.right].flatMap(term => {
        const trail = trailOf(term);
        return trail === undefined ? [] : [trail];
      });
    case "all":
    case "any": {
      const of = trailOf(rule.of);
      const inner = segmentsRead(
        rule.each,
        root,
        new Map([...elements, [rule.element, of === undefined ? undefined : [...of, "[]"]]]),
      );
      return of === undefined ? inner : [of, ...inner];
    }
    case "and":
    case "or":
      return rule.rules.flatMap(inner => segmentsRead(inner, root, elements));
    case "not":
      return segmentsRead(rule.rule, root, elements);
  }
}

function guardReadSegmentsOf(implementation: AnyImplementation | undefined): readonly (readonly string[])[] {
  if (implementation === undefined) {
    return [];
  }
  return Object.entries(implementation.cases).flatMap(([tag, decision]) => {
    if (decision.kind !== "rules") {
      return [];
    }
    const root = [`@${tag}`];
    const matched =
      typeof decision.otherwise === "function"
        ? []
        : [[...root, ...termData(decision.otherwise.on).path.map(key => `.${key}`)]];
    return [...decision.guards.flatMap(item => segmentsRead(item.condition, root, new Map())), ...matched];
  });
}

function namedSegments(position: Position): readonly string[] {
  const [inputCase, ...rest] = position.segments;
  return [inputCase!, ...rest.filter(segment => segment !== "?" && !segment.startsWith("@"))];
}

// A disregarded position a guard reads is kept rather than dropped, since the
// guard's classes are attached to it; only what its type and invariants owe goes.
function measuredPositionsOf(
  definition: AnyBehavior,
  guardDivided: ReadonlySet<string> = new Set(),
  guardRead: readonly (readonly string[])[] = [],
): readonly Position[] {
  return positionsOf(definition.input).flatMap((position): Position[] => {
    if (!isDisregarded(definition, position)) {
      return [position];
    }
    const named = namedSegments(position);
    if (guardRead.some(trail => named.every((segment, index) => trail[index] === segment))) {
      return [{ ...position, borders: [] }];
    }
    if (!guardDivided.has(trailKey(position.segments))) {
      return [];
    }
    return [
      position.kind === "divided"
        ? { ...position, classes: [], excluded: [], borders: [] }
        : { ...position, borders: [] },
    ];
  });
}

const DISREGARD_COMBINATION_LIMIT = 255;
// Not the combinations alone: moves are tried before a combination is known to
// be one the input can hold, so the candidates tried that way are bounded too.
const DISREGARD_CANDIDATE_LIMIT = 4096;

function disregardLimit(name: string, given: number | undefined, fallback: number): number {
  if (given === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(given) || given <= 0) {
    throw new SpecificationError(`disregards.${name} must be a positive integer, but was ${given}`);
  }
  return given;
}

interface DisregardMove {
  readonly label: string;
  apply(given: unknown): unknown;
  reached(varied: unknown): boolean;
}

type DisregardCheck =
  | { readonly kind: "held" }
  | { readonly kind: "broken"; readonly failure: ExampleFailure }
  | { readonly kind: "not checked"; readonly incompleteness: Incompleteness };

async function disregardBroken(
  implementation: AnyImplementation,
  row: Example<AnyBehavior>,
  answered: unknown,
  standIns: unknown,
  limits: { readonly combinations: number; readonly candidates: number },
): Promise<DisregardCheck> {
  const definition = implementation.behavior;
  const tag = tagOf(definition.input, row.given);
  const kept = positionsOf(definition.input).filter(
    position => isUnder(position, [`@${tag}`]) && !isDisregarded(definition, position),
  );
  const readKept = (given: unknown) =>
    kept.map(position => [
      position.kind === "divided" ? position.classify(given) : [],
      position.borders.map(border => coordinatesIn(position, border.measure, given)),
    ]);
  const keptOriginally = readKept(row.given);
  const axes = positionsOf(definition.input).flatMap(position => {
    if (!isUnder(position, [`@${tag}`]) || !isDisregarded(definition, position)) {
      return [];
    }
    return position.instancesIn(row.given).flatMap(instance => {
      const classes = position.kind === "divided" ? position : undefined;
      const located = instance as DividedInstance;
      const classified = (given: unknown) => (classes === undefined ? [] : located.classify(given));
      const taken = classified(row.given);
      const coordinates = (given: unknown) =>
        position.borders.map(border => coordinatesIn(instance, border.measure, given));
      const original = coordinates(row.given);
      const classMoves: DisregardMove[] =
        classes === undefined
          ? []
          : classes.classes
              .filter(className => !taken.includes(className) && !classes.excluded.includes(className))
              .map(className => ({
                label: className,
                apply: given => located.place(given, className),
                reached: varied => located.classify(varied).includes(className),
              }));
      const pointMoves: DisregardMove[] = position.borders.flatMap((border, index) =>
        border.points.flatMap(point =>
          point.status !== "owed" ||
          point.witness === undefined ||
          original[index]!.some(value => point.contains(value))
            ? []
            : [
                {
                  label: `${point.role} (${point.relation})`,
                  apply: (given: unknown) => instance.write(given, border.measure, point.witness),
                  reached: (varied: unknown) =>
                    coordinatesIn(instance, border.measure, varied).some(value => point.contains(value)),
                },
              ],
        ),
      );
      const moves = [...classMoves, ...pointMoves];
      return moves.length === 0
        ? []
        : [
            {
              path: instance.path,
              moves,
              unmoved: (varied: unknown) =>
                (isDeepStrictEqual(classified(varied), taken) &&
                  isDeepStrictEqual(coordinates(varied), original)) ||
                (classified(varied).length === 0 && coordinates(varied).every(values => values.length === 0)),
            },
          ];
    });
  });
  const candidates = axes.reduce((total, axis) => total * (axis.moves.length + 1), 1) - 1;
  if (candidates > limits.candidates) {
    return {
      kind: "not checked",
      incompleteness: {
        kind: "disregards not checked",
        subject: row.name,
        reason: `disregardsの組み合わせの候補が${candidates}通りあり、上限の${limits.candidates}通りを超えるため数えていない`,
      },
    };
  }
  const combinations = axes
    .reduce<(DisregardMove | undefined)[][]>(
      (partial, axis) => partial.flatMap(choice => [undefined, ...axis.moves].map(move => [...choice, move])),
      [[]],
    )
    .filter(choice => choice.some(move => move !== undefined))
    .flatMap(choice => {
      const varied = choice.reduce<unknown>((given, move) => (move === undefined ? given : move.apply(given)), row.given);
      const holds = axes.every((axis, index) => {
        const move = choice[index];
        return move === undefined ? axis.unmoved(varied) : move.reached(varied);
      });
      return holds &&
        isDeepStrictEqual(readKept(varied), keptOriginally) &&
        definition.input.parse(varied).success
        ? [{ choice, varied }]
        : [];
    })
    .sort((left, right) => {
      const moved = (choice: readonly (DisregardMove | undefined)[]) =>
        choice.flatMap((move, index) => (move === undefined ? [] : [index]));
      const [a, b] = [moved(left.choice), moved(right.choice)];
      const first = a.findIndex((index, at) => index !== b[at]);
      return a.length - b.length || (first === -1 ? 0 : a[first]! - b[first]!);
    });
  if (combinations.length > limits.combinations) {
    return {
      kind: "not checked",
      incompleteness: {
        kind: "disregards not checked",
        subject: row.name,
        reason: `disregardsの組み合わせが${combinations.length}通りあり、上限の${limits.combinations}通りを超えるため確かめていない`,
      },
    };
  }
  for (const { choice, varied } of combinations) {
    const outcome = await runTraced(implementation, varied as never, standIns as never).then(
      (traced): { readonly text: string; readonly error?: string } | undefined =>
        isDeepStrictEqual(traced.execution, answered) ? undefined : { text: "its answer changed" },
      (error: unknown) => ({ text: "it threw", error: error instanceof Error ? error.message : String(error) }),
    );
    if (outcome !== undefined) {
      const moved = axes.flatMap((axis, index) => {
        const move = choice[index];
        return move === undefined ? [] : [{ path: axis.path, label: move.label }];
      });
      return {
        kind: "broken",
        failure: {
          name: row.name,
          message: `${definition.name} disregards ${moved.map(item => item.path).join(", ")}, but ${outcome.text} when ${moved
            .map(item => `${item.path} was ${item.label}`)
            .join(" and ")}${outcome.error === undefined ? "" : `: ${outcome.error}`}`,
        },
      };
    }
  }
  return { kind: "held" };
}
