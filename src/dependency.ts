import { isDeepStrictEqual } from "node:util";
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
  readonly [K in keyof R as R[K] extends { readonly takes: "nothing" } ? K : never]: R[K] extends ValueDependency<
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

export interface FakeTable {
  readonly kind: "fake";
  readonly behavior: string;
  readonly dependency: string;
  readonly rows: readonly (readonly [unknown, unknown])[];
  readonly otherwise?: { readonly value: unknown };
}

export type FunctionDependencyNames<R> = {
  [K in keyof R]: R[K] extends { readonly takes: "input" } ? K : never;
}[keyof R] &
  string;

type FakeInput<R, K extends keyof R> = R[K] extends { readonly input: Schema<infer Input> }
  ? Input
  : never;
type FakeOutput<R, K extends keyof R> = R[K] extends { readonly output: Schema<infer Output> }
  ? Output
  : never;

export function fake<
  const B extends { readonly name: string; readonly requires: Requirements },
  const K extends FunctionDependencyNames<B["requires"]>,
>(
  definition: B,
  name: K,
  rows: readonly (readonly [FakeInput<B["requires"], K>, FakeOutput<B["requires"], K>])[],
  options?: { readonly otherwise: FakeOutput<B["requires"], K> },
): FakeTable {
  return {
    kind: "fake",
    behavior: definition.name,
    dependency: name,
    rows,
    ...(options === undefined ? {} : { otherwise: { value: options.otherwise } }),
  };
}

export class FakeMiss extends Error {
  constructor(dependency: string, input: unknown) {
    super(`Fake ${dependency} has no answer for ${JSON.stringify(input)}`);
    this.name = "FakeMiss";
  }
}

export function answerFrom(table: FakeTable): (input: unknown) => unknown {
  return input => {
    const row = table.rows.find(([asked]) => isDeepStrictEqual(asked, input));
    if (row !== undefined) {
      return row[1];
    }
    if (table.otherwise !== undefined) {
      return table.otherwise.value;
    }
    throw new FakeMiss(table.dependency, input);
  };
}
