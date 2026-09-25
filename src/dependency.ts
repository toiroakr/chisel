import { isDeepStrictEqual } from "node:util";
import type { Rule } from "./rule.js";
import { holds } from "./rule.js";
import type { Schema } from "./schema.js";
import { isVariantsSchema, tagOf } from "./schema.js";

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
  readonly injected?: Injected;
}

interface InjectedBehavior {
  readonly kind: "behavior";
  readonly name: string;
  readonly input: Schema<unknown>;
  readonly result: Schema<unknown>;
  readonly ensures: readonly {
    readonly name: string;
    readonly cases: readonly string[] | undefined;
    readonly rule: Rule;
  }[];
}

interface RecordedRow {
  readonly name: string;
  readonly given: unknown;
  readonly expect: { readonly kind?: string; readonly result?: unknown };
}

interface Injected {
  readonly behavior: InjectedBehavior;
  readonly rows: readonly RecordedRow[];
}

type InputOf<B> = B extends { readonly input: Schema<infer Input> } ? Input : never;
type ResultOf<B> = B extends { readonly result: Schema<infer Result> } ? Result : never;

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

export function dependency<const B extends InjectedBehavior>(
  behavior: B,
): FunctionDependency<InputOf<B>, ResultOf<B>>;
export function dependency<const B extends InjectedBehavior>(examples: {
  readonly kind: "example-set";
  readonly behavior: B;
  readonly rows: readonly RecordedRow[];
}): FunctionDependency<InputOf<B>, ResultOf<B>>;
export function dependency<Output>(output: Schema<Output>): ValueDependency<Output>;
export function dependency<Input, Output>(
  input: Schema<Input>,
  output: Schema<Output>,
): FunctionDependency<Input, Output>;
export function dependency(
  first:
    | Schema<unknown>
    | InjectedBehavior
    | { readonly kind: "example-set"; readonly behavior: InjectedBehavior; readonly rows: readonly RecordedRow[] },
  second?: Schema<unknown>,
): AnyDependency {
  if (first.kind === "behavior") {
    return injectedDependency({ behavior: first as InjectedBehavior, rows: [] });
  }
  if (first.kind === "example-set") {
    const set = first as { readonly behavior: InjectedBehavior; readonly rows: readonly RecordedRow[] };
    return injectedDependency({ behavior: set.behavior, rows: set.rows });
  }
  const schema = first as Schema<unknown>;
  return second === undefined
    ? { kind: "dependency", takes: "nothing", output: schema }
    : { kind: "dependency", takes: "input", input: schema, output: second };
}

function injectedDependency(injected: Injected): FunctionDependency<unknown, unknown> {
  return {
    kind: "dependency",
    takes: "input",
    input: injected.behavior.input,
    output: injected.behavior.result,
    injected,
  };
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

export function fakeIssuesOf(
  requires: Requirements,
  behavior: string,
  tables: readonly FakeTable[],
): readonly { readonly table: FakeTable; readonly issue: string }[] {
  const issues: { table: FakeTable; issue: string }[] = [];
  for (const table of tables) {
    const name = table.dependency;
    const declared = requires[name];
    const written = tables.filter(other => other.dependency === name).length;
    if (declared === undefined) {
      issues.push({ table, issue: `Fake ${name} names no dependency of ${behavior}` });
      continue;
    }
    if (declared.takes === "nothing") {
      issues.push({ table, issue: `Fake ${name} stands in for a value dependency; write it with with` });
      continue;
    }
    if (written > 1) {
      if (tables.find(other => other.dependency === name) === table) {
        issues.push({ table, issue: `Fake ${name} is written ${written} times` });
      }
      continue;
    }
    table.rows.forEach(([asked, answer], index) => {
      const input = declared.input.parse(asked);
      if (!input.success) {
        issues.push({
          table,
          issue: `Fake ${name} row ${index + 1} is asked a value the dependency cannot take: ${input.issues[0]!.message}`,
        });
      }
      const output = declared.output.parse(answer);
      if (!output.success) {
        issues.push({
          table,
          issue: `Fake ${name} row ${index + 1} answers a value the dependency cannot: ${output.issues[0]!.message}`,
        });
      }
      const broken =
        input.success && output.success && declared.injected !== undefined
          ? brokenBy(declared.injected.behavior, input.value, output.value)
          : undefined;
      if (broken !== undefined) {
        issues.push({
          table,
          issue: `Fake ${name} row ${index + 1} breaks ensures ${broken} of ${declared.injected!.behavior.name}`,
        });
      }
      const earlier = table.rows.findIndex(([other]) => isDeepStrictEqual(other, asked));
      if (earlier < index) {
        issues.push({
          table,
          issue: `Fake ${name} row ${index + 1} answers nothing: row ${earlier + 1} already states ${JSON.stringify(asked)}`,
        });
      }
    });
    if (table.otherwise !== undefined) {
      const fallback = declared.output.parse(table.otherwise.value);
      if (!fallback.success) {
        issues.push({
          table,
          issue: `Fake ${name} default answers a value the dependency cannot: ${fallback.issues[0]!.message}`,
        });
      }
    }
  }
  return issues;
}

function brokenBy(behavior: InjectedBehavior, input: unknown, value: unknown): string | undefined {
  const tag = isVariantsSchema(behavior.result) ? tagOf(behavior.result, value) : undefined;
  return behavior.ensures.find(
    clause =>
      (clause.cases === undefined || (tag !== undefined && clause.cases.includes(tag))) &&
      !holds(clause.rule, { input, value }),
  )?.name;
}

export function fakeWarningsOf(requires: Requirements, tables: readonly FakeTable[]): readonly string[] {
  return tables.flatMap(table => {
    const declared = requires[table.dependency];
    if (declared?.takes !== "input" || declared.injected === undefined) {
      return [];
    }
    const { behavior, rows } = declared.injected;
    return table.rows.flatMap(([asked, answer], index) =>
      rows
        .filter(
          row =>
            row.expect.kind !== "todo" &&
            isDeepStrictEqual(row.given, asked) &&
            !isDeepStrictEqual(row.expect.result, answer),
        )
        .map(
          row =>
            `Fake ${table.dependency} row ${index + 1} answers ${JSON.stringify(answer)} where ${behavior.name} example ${row.name} answers ${JSON.stringify(row.expect.result)}`,
        ),
    );
  });
}
