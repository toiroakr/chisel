import type { Temporal as TemporalTypes } from "temporal-spec";

export type Comparable = number | string | TemporalTypes.Instant;

const TERM = Symbol("chisel.term");

export interface TermData {
  readonly path: readonly string[];
  readonly measure: "value" | "length";
}

export type Term<T> = {
  readonly [TERM]: TermData;
  readonly __value?: { bivariant(value: T): void }["bivariant"];
};

export type Operand<T> = Term<T> | T;

export type TermOf<T> = Term<T> &
  (T extends Comparable | boolean | readonly unknown[]
    ? unknown
    : T extends object
      ? string extends keyof T
        ? { readonly [key: string]: any }
        : { readonly [K in keyof T]-?: TermOf<Exclude<T[K], undefined>> }
      : unknown);

export type InvariantRule<T> = { bivariant(self: TermOf<T>): Rule }["bivariant"];

export type Operator = "<" | "<=" | ">" | ">=" | "==" | "!=";

export interface CompareRule {
  readonly kind: "compare";
  readonly operator: Operator;
  readonly left: Operand<unknown>;
  readonly right: Operand<unknown>;
}

export type Rule = CompareRule;

export function lt<T extends Comparable>(left: Operand<T>, right: Operand<T>): Rule {
  return compare("<", left, right);
}

export function le<T extends Comparable>(left: Operand<T>, right: Operand<T>): Rule {
  return compare("<=", left, right);
}

export function gt<T extends Comparable>(left: Operand<T>, right: Operand<T>): Rule {
  return compare(">", left, right);
}

export function ge<T extends Comparable>(left: Operand<T>, right: Operand<T>): Rule {
  return compare(">=", left, right);
}

export function eq<T extends Comparable | boolean>(
  left: Operand<T>,
  right: Operand<T>,
): Rule {
  return compare("==", left, right);
}

export function ne<T extends Comparable | boolean>(
  left: Operand<T>,
  right: Operand<T>,
): Rule {
  return compare("!=", left, right);
}

export function length(of: Term<string | readonly unknown[]>): Term<number> {
  return termAt(of[TERM].path, "length");
}

export function selfTerm<T>(): TermOf<T> {
  return termAt([], "value") as TermOf<T>;
}

export function isTerm(value: unknown): value is Term<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    TERM in value
  );
}

export function termData(term: Term<unknown>): TermData {
  return term[TERM];
}

export function holds(rule: Rule, value: unknown): boolean {
  const left = read(rule.left, value);
  const right = read(rule.right, value);
  const order = ordering(left, right);
  switch (rule.operator) {
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "==":
      return order === 0;
    case "!=":
      return order !== 0;
  }
}

export function describeRule(rule: Rule, path = "$"): string {
  return `${describeOperand(rule.left, path)} ${rule.operator} ${describeOperand(rule.right, path)}`;
}

function compare(operator: Operator, left: unknown, right: unknown): Rule {
  return { kind: "compare", operator, left, right };
}

function termAt(path: readonly string[], measure: TermData["measure"]): Term<unknown> {
  const data: TermData = { path, measure };
  return new Proxy({} as Term<unknown>, {
    get: (_target, key) => {
      if (key === TERM) {
        return data;
      }
      return typeof key === "string" ? termAt([...path, key], "value") : undefined;
    },
    has: (_target, key) => key === TERM,
  });
}

function read(operand: unknown, value: unknown): unknown {
  if (!isTerm(operand)) {
    return operand;
  }
  const { path, measure } = termData(operand);
  const found = path.reduce<unknown>(
    (current, key) =>
      typeof current === "object" && current !== null
        ? (current as Readonly<Record<string, unknown>>)[key]
        : undefined,
    value,
  );
  return measure === "length" ? (found as string | readonly unknown[]).length : found;
}

function ordering(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === right ? 0 : Number.NaN;
  }
  const compareInstants = (
    left as { readonly constructor?: { readonly compare?: (a: unknown, b: unknown) => number } }
  )?.constructor?.compare;
  if (typeof compareInstants === "function") {
    return compareInstants(left, right);
  }
  return Number.NaN;
}

function describeOperand(operand: unknown, path: string): string {
  if (!isTerm(operand)) {
    return typeof operand === "string" ? JSON.stringify(operand) : String(operand);
  }
  const { path: keys, measure } = termData(operand);
  const location = [path, ...keys].join(".");
  return measure === "length" ? `length(${location})` : location;
}
