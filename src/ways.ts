import type { Branch, RulesDecision } from "./behavior.js";
import type { Rule } from "./rule.js";
import { describeRule, describeTerm } from "./rule.js";

export interface Step {
  readonly distinction: Branch;
  readonly outcome: boolean | string;
}

export interface Way {
  readonly steps: readonly Step[];
  readonly exit: number | "otherwise" | "case";
}

interface Outcome {
  readonly steps: readonly Step[];
  readonly result: boolean;
}

export function waysOf(decision: RulesDecision<unknown, unknown, unknown>): readonly Way[] {
  const from = (index: number, before: readonly Step[]): readonly Way[] => {
    const candidate = decision.guards[index];
    if (candidate === undefined) {
      const { otherwise } = decision;
      return typeof otherwise === "function"
        ? [{ steps: before, exit: "otherwise" }]
        : Object.keys(otherwise.cases).map(tag => ({
            steps: [...before, { distinction: otherwise, outcome: tag }],
            exit: "case" as const,
          }));
    }
    return outcomesOf(candidate.condition).flatMap(outcome => {
      const steps = [...before, ...outcome.steps];
      return outcome.result ? from(index + 1, steps) : [{ steps, exit: index }];
    });
  };
  return from(0, []);
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

function outcomesOf(rule: Rule): readonly Outcome[] {
  switch (rule.kind) {
    case "compare":
    case "all":
    case "any":
      return [
        { steps: [{ distinction: rule, outcome: true }], result: true },
        { steps: [{ distinction: rule, outcome: false }], result: false },
      ];
    case "not":
      return outcomesOf(rule.rule).map(outcome => ({ ...outcome, result: !outcome.result }));
    case "and":
    case "or": {
      const settles = rule.kind === "or";
      let partial: readonly Outcome[] = [{ steps: [], result: !settles }];
      for (const part of rule.rules) {
        partial = partial.flatMap(outcome =>
          outcome.result === settles
            ? [outcome]
            : outcomesOf(part).map(next => ({
                steps: [...outcome.steps, ...next.steps],
                result: next.result,
              })),
        );
      }
      return partial;
    }
  }
}
