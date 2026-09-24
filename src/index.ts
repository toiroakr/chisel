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

export { formatTypeScriptValue } from "./codegen.js";

export { positionsOf } from "./partition.js";
export type {
  DividedPosition,
  Position,
  UndividedPosition,
} from "./partition.js";

export {
  behavior,
  implement,
  isBehavior,
  pending,
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
  Implementation,
  ImplementationCases,
  Pending,
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
