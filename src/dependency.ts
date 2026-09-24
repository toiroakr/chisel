import type { Schema } from "./schema.js";

export interface ValueDependency<Output> {
  readonly kind: "dependency";
  readonly takes: "nothing";
  readonly output: Schema<Output>;
}

export interface FunctionDependency<Input, Output> {
  readonly kind: "dependency";
  readonly takes: "input";
  readonly input: Schema<Input>;
  readonly output: Schema<Output>;
}

export type AnyDependency = ValueDependency<any> | FunctionDependency<any, any>;

export type Requirements = Readonly<Record<string, AnyDependency>>;

export type Resolved<R> = {
  readonly [K in keyof R]: R[K] extends FunctionDependency<infer Input, infer Output>
    ? (input: Input) => Output
    : R[K] extends ValueDependency<infer Output>
      ? Output
      : never;
};

export type ValueDependencies<R> = {
  readonly [K in keyof R as R[K] extends ValueDependency<unknown> ? K : never]: R[K] extends ValueDependency<
    infer Output
  >
    ? Output
    : never;
};

export function dependency<Output>(output: Schema<Output>): ValueDependency<Output>;
export function dependency<Input, Output>(
  input: Schema<Input>,
  output: Schema<Output>,
): FunctionDependency<Input, Output>;
export function dependency(
  first: Schema<unknown>,
  second?: Schema<unknown>,
): AnyDependency {
  return second === undefined
    ? { kind: "dependency", takes: "nothing", output: first }
    : { kind: "dependency", takes: "input", input: first, output: second };
}
