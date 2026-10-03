import { modelPaths } from "./model.js";
import type { Branch, RulesDecision } from "./behavior.js";
import type { Rule } from "./rule.js";
import { describeRule, describeTerm } from "./rule.js";

export interface Step {
  readonly distinction: Branch;
  readonly outcome: boolean | string;
}

export interface Way {
  readonly choices?: readonly { readonly condition: Rule; readonly outcome: boolean }[];
  readonly steps: readonly Step[];
  readonly exit: number | "otherwise" | "case";
}

interface Outcome {
  readonly steps: readonly Step[];
  readonly result: boolean;
}

// How many ways through a decision's guards are listed before its rules and
// arms are left unmeasured instead.
export const WAY_LIMIT = 10_000;

export function waysOf(decision: RulesDecision<unknown, unknown, unknown>): readonly Way[] {
  return [...eachWayOf(decision)];
}

// The ways through the guards one at a time, in the order waysOf lists them,
// so a caller can stop before building them all.
export function* eachWayOf(decision: RulesDecision<unknown, unknown, unknown>): Generator<Way> {
  if (decision.expression !== undefined) {
    for (const path of modelPaths(decision.expression)) yield { steps: path.steps, choices: path.choices, exit: "otherwise" };
    return;
  }
  function* from(index: number, before: readonly Step[]): Generator<Way> {
    const candidate = decision.guards[index];
    if (candidate === undefined) {
      const { otherwise } = decision;
      if (typeof otherwise === "function") {
        yield { steps: before, exit: "otherwise" };
        return;
      }
      for (const tag of Object.keys(otherwise.cases)) {
        yield { steps: [...before, { distinction: otherwise, outcome: tag }], exit: "case" };
      }
      return;
    }
    for (const outcome of outcomesOf(candidate.condition)) {
      const steps = [...before, ...outcome.steps];
      if (outcome.result) {
        yield* from(index + 1, steps);
      } else {
        yield { steps, exit: index };
      }
    }
  }
  yield* from(0, []);
}

export function sameSteps(left: readonly Step[], right: readonly Step[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (step, index) =>
        step.distinction === right[index]!.distinction && step.outcome === right[index]!.outcome,
    )
  );
}

export function describeWay(way: Way): string {
  const steps = way.steps
    .map(step =>
      step.distinction.kind === "match"
        ? `${describeTerm(step.distinction.on)} is ${String(step.outcome)}`
        : `${describeRule(step.distinction)} ${step.outcome ? "holds" : "fails"}`,
    )
    .join(", ");
  if (way.exit === "case") {
    return steps;
  }
  const exit = way.exit === "otherwise" ? "otherwise" : `else of guard ${way.exit + 1}`;
  return steps === "" ? exit : `${steps} → ${exit}`;
}

export function* outcomesOf(rule: Rule): Generator<Outcome> {
  switch (rule.kind) {
    case "compare":
    case "all":
    case "any":
      yield { steps: [{ distinction: rule, outcome: true }], result: true };
      yield { steps: [{ distinction: rule, outcome: false }], result: false };
      return;
    case "not":
      for (const outcome of outcomesOf(rule.rule)) {
        yield { ...outcome, result: !outcome.result };
      }
      return;
    case "and":
    case "or": {
      const settles = rule.kind === "or";
      const { rules } = rule;
      function* from(index: number, before: readonly Step[]): Generator<Outcome> {
        const part = rules[index];
        if (part === undefined) {
          yield { steps: before, result: !settles };
          return;
        }
        for (const next of outcomesOf(part)) {
          const steps = [...before, ...next.steps];
          if (next.result === settles) {
            yield { steps, result: next.result };
          } else {
            yield* from(index + 1, steps);
          }
        }
      }
      yield* from(0, []);
    }
  }
}
