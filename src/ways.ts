import { iterationEntries, modelPaths } from "./model.js";
import { isTerm } from "./rule.js";
import { outcomesOf } from "./outcomes.js";
export { outcomesOf } from "./outcomes.js";
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
  // The map or fold whose body one element takes this way through.
  readonly within?: IterationNode;
  // The steps the choices around that iteration take to reach it, held only where one way reaches it.
  readonly entered?: readonly Step[];
}

export interface IterationNode {
  readonly kind: "map" | "fold";
  readonly name: string;
  readonly values: unknown;
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
    const entries = [...iterationEntries(decision.expression)];
    for (const [index, { node: iteration, steps: entered }] of entries.entries()) {
      if (entries.findIndex(entry => entry.node === iteration) !== index) continue;
      // A body with no distinction is one path with no steps and owes nothing of its own; read lazily, since a body may have far more paths than a caller will list.
      const paths = modelPaths(iteration.body);
      const first = paths.next();
      if (first.done === true || first.value.steps.length === 0) continue;
      // An iteration several choices reach is entered by any of them, so no entry is required of it.
      const reached = entries.filter(entry => entry.node === iteration).length === 1 ? { entered } : {};
      yield { steps: first.value.steps, choices: first.value.choices, exit: "otherwise", within: iteration, ...reached };
      for (const path of paths) yield { steps: path.steps, choices: path.choices, exit: "otherwise", within: iteration, ...reached };
    }
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
  const described = steps === "" ? exit : `${steps} → ${exit}`;
  if (way.within === undefined) return described;
  const over = isTerm(way.within.values) ? `${describeTerm(way.within.values)}[]` : "an element";
  return `each of ${over}: ${described}`;
}
