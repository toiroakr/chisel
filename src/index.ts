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

export { behavior, pending, runBehavior, SpecificationError } from "./behavior.js";
export type {
  AnyBehavior,
  Behavior,
  BehaviorEffect,
  BehaviorInput,
  BehaviorResult,
  Cases,
  ControlPolicy,
  ControlTable,
  Decision,
  Execution,
  Pending,
} from "./behavior.js";

export {
  defineSpecification,
  evaluateSpecification,
  example,
  examples,
  generateTodos,
  isSpecification,
  todo,
  verifyConformance,
} from "./specification.js";
export type {
  AdequacyReport,
  CompleteExample,
  ConformanceSubject,
  ControlGap,
  Coverage,
  Example,
  ExampleFailure,
  ExampleSet,
  GeneratedTodo,
  PendingDecision,
  Specification,
  TodoExample,
} from "./specification.js";
