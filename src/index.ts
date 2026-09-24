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

export { all, eq, ge, gt, le, length, lt, ne } from "./rule.js";
export type { Comparable, InvariantRule, Operand, Operator, Rule, Term, TermOf } from "./rule.js";

export { formatTypeScriptValue } from "./codegen.js";

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
  pending,
  rules,
  runImplementation,
  SpecificationError,
} from "./behavior.js";
export type {
  AnyBehavior,
  AnyImplementation,
  Behavior,
  BehaviorEffect,
  BehaviorInput,
  BehaviorResult,
  ControlPolicy,
  ControlTable,
  Decision,
  Execution,
  Guard,
  Implementation,
  ImplementationCases,
  Pending,
  RulesDecision,
} from "./behavior.js";

export {
  defineSpecification,
  evaluateSpecification,
  example,
  examples,
  generateExamples,
  isUnanswered,
  isSpecification,
  unanswered,
  verifyConformance,
} from "./specification.js";
export type {
  AdequacyReport,
  BorderCoverage,
  ConformanceSubject,
  ControlGap,
  Coverage,
  DependencyIssue,
  Example,
  ExampleFailure,
  ExampleSet,
  GeneratedExample,
  InputCaseEvidence,
  Measure,
  PartitionCoverage,
  PendingDecision,
  ResultCaseEvidence,
  Specification,
  Unanswered,
  UnansweredExample,
  Verdict,
} from "./specification.js";
