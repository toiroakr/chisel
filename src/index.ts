export type {} from "temporal-spec/global";

export {
  array,
  boolean,
  instant,
  integer,
  literal,
  isSumSchema,
  number,
  object,
  optional,
  record,
  string,
  sum,
  tagOf,
} from "./schema.js";
export type {
  AnySchema,
  AnySumSchema,
  ArraySchema,
  Infer,
  InferShape,
  InstantSchema,
  IntegerSchema,
  ObjectSchema,
  OptionalSchema,
  RecordSchema,
  Schema,
  SumSchema,
  SumVariant,
  Tags,
  ValidationIssue,
  ValidationResult,
  VariantOf,
} from "./schema.js";

export { all, and, any, eq, ge, gt, le, length, lt, ne, not, or } from "./rule.js";
export type { Comparable, InvariantRule, Operand, Operator, Rule, Term, TermOf } from "./rule.js";

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
  behavior,
  guard,
  implement,
  isBehavior,
  match,
  pending,
  rules,
  runImplementation,
  SpecificationError,
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
  Pending,
  RulesDecision,
} from "./behavior.js";

export {
  defineSpecification,
  evaluateSpecification,
  example,
  examples,
  generateExamples,
  generationReport,
  isUnanswered,
  isSpecification,
  unanswered,
  verifyConformance,
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
  DependencyIssue,
  Example,
  ExampleFailure,
  ExampleSet,
  GeneratedExample,
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
  Unanswered,
  UnansweredExample,
  Verdict,
} from "./specification.js";
export type { EnsuresClassification, EnsuresReading, EnsuresReport } from "./ensures.js";
