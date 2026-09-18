export {
  boolean,
  literal,
  isSumSchema,
  number,
  object,
  string,
  sum,
  tagOf,
} from "./schema.js";
export type {
  AnySchema,
  AnySumSchema,
  Infer,
  ObjectSchema,
  Schema,
  SumSchema,
  SumVariant,
  Tags,
  ValidationIssue,
  ValidationResult,
  VariantOf,
} from "./schema.js";

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
  Example,
  ExampleFailure,
  ExampleSet,
  GeneratedExample,
  PendingDecision,
  Specification,
  Unanswered,
  UnansweredExample,
} from "./specification.js";
