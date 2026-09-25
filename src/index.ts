export type {} from "temporal-spec/global";

export {
  array,
  boolean,
  instant,
  int,
  literal,
  isVariantsSchema,
  number,
  object,
  record,
  string,
  variants,
  tagOf,
} from "./schema.js";
export type {
  AnySchema,
  AnyVariantsSchema,
  ArraySchema,
  Infer,
  InferShape,
  InstantSchema,
  IntSchema,
  ObjectSchema,
  OptionalSchema,
  RecordSchema,
  Schema,
  VariantsSchema,
  VariantValue,
  Tags,
  ValidationIssue,
  ValidationResult,
  VariantOf,
} from "./schema.js";

export type { Comparable, Condition, InvariantRule, Operand, Operator, Rule, Term, TermOf } from "./rule.js";

export { formatTypeScriptValue } from "./codegen.js";

export { dependency, fake, FakeMiss } from "./dependency.js";
export type {
  AnyDependency,
  FakeTable,
  FunctionDependency,
  FunctionDependencyNames,
  Requirements,
  Resolved,
  ValueDependencies,
  ValueDependency,
} from "./dependency.js";

export type { Border, BorderPoint, PointRole, PointStatus } from "./border.js";

export { positionsOf } from "./partition.js";
export type {
  DividedPosition,
  Position,
  UndividedPosition,
} from "./partition.js";

export {
  action,
  behavior,
  external,
  guard,
  implement,
  isBehavior,
  match,
  isTodo,
  todo,
  perform,
  SpecificationError,
  TodoDecision,
} from "./behavior.js";
export type {
  AnyBehavior,
  AnyImplementation,
  Behavior,
  BehaviorDeps,
  BehaviorEffect,
  BehaviorInput,
  BehaviorResult,
  ControlPolicy,
  ControlTable,
  Decision,
  EnsuresBuilder,
  EnsuresClause,
  Execution,
  Guard,
  Implementation,
  ImplementationCases,
  Match,
  Otherwise,
  Todo,
  RulesDecision,
} from "./behavior.js";

export {
  spec,
  check,
  example,
  examples,
  generate,
  isSpecification,
  test,
} from "./specification.js";
export type {
  AdequacyReport,
  ArmCoverage,
  BehaviorWith,
  BorderCoverage,
  ComparisonsMeasure,
  ConformanceSubject,
  CoverageStatus,
  ControlGap,
  Coverage,
  Example,
  ExampleFailure,
  ExampleRow,
  ExampleSet,
  GeneratedExample,
  Incompleteness,
  GenerationReport,
  InputCaseEvidence,
  Measure,
  PairCount,
  PartitionCoverage,
  PendingDecision,
  ResultCaseEvidence,
  RuleCoverage,
  RulesMeasure,
  Specification,
  TestOutcome,
  UnansweredExample,
  Verdict,
} from "./specification.js";
export type { EnsuresClassification, EnsuresReading, EnsuresReport } from "./ensures.js";
export { reportDocument, reportSchemaVersion } from "./report-json.js";
export type { ReportSource, Weakening } from "./report-json.js";
export { compose, isComposition } from "./composition.js";
export type { Composition } from "./composition.js";
