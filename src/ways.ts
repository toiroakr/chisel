import { independentParts, isIteration, iterationEntries, iterationsOf, modelPaths, partLabel, partTemplate } from "./model.js";
import type { IterationEntry } from "./model.js";
import { isTerm } from "./rule.js";
import { NO_FACTS, outcomesOf, withStep } from "./outcomes.js";
import type { Facts } from "./outcomes.js";
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
  // The map or fold whose body one element takes this way through, or the independent part of the
  // model (`independentParts`) the way goes through, whose steps a run hands apart as it does an
  // iteration's.
  readonly within?: IterationNode | PartNode;
  // The steps of each way the choices around that iteration lead into it; one of them must hold. Left off where the iteration is entered unconditionally (or where `entryUnlisted` says there are too many to list).
  readonly entered?: readonly (readonly Step[])[];
  // Set where the ways into the iteration were too many to list, so a body way is feasible only as far as the way entering it is unknown.
  readonly entryUnlisted?: true;
}

export interface PartNode {
  readonly kind: string;
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
    const parts = independentParts(decision.expression);
    if (parts === undefined) for (const path of modelPaths(decision.expression)) yield { steps: path.steps, choices: path.choices, exit: "otherwise" };
    // A part that is itself a map or fold has no way of its own outside its body, whose ways the walk lists below; one here would read as an iteration's.
    else for (const part of parts) for (const path of modelPaths(partTemplate(part))) if (!isIteration(part) || path.steps.length > 0) yield { steps: path.steps, choices: path.choices, exit: "otherwise", within: part };
    const entries: IterationEntry[] = [];
    let listed = true;
    for (const entry of iterationEntries(decision.expression)) {
      if (entries.length >= WAY_LIMIT) { listed = false; break; }
      entries.push(entry);
    }
    for (const iteration of new Set(iterationsOf(decision.expression))) {
      // A body with no distinction is one path with no steps and owes nothing of its own; read lazily, since a body may have far more paths than a caller will list.
      const paths = modelPaths(iteration.body);
      const first = paths.next();
      if (first.done === true || first.value.steps.length === 0) continue;
      const alternatives = entries.filter(entry => entry.node === iteration).map(entry => entry.steps);
      // Every way into the model was listed and none leads here, so no input takes the walk; an empty list of steps is a way in that holds unconditionally.
      if (listed && alternatives.length === 0) continue;
      const reached = !listed ? { entryUnlisted: true as const } : alternatives.length > 0 && alternatives.every(steps => steps.length > 0) ? { entered: alternatives } : {};
      yield { steps: first.value.steps, choices: first.value.choices, exit: "otherwise", within: iteration, ...reached };
      for (const path of paths) yield { steps: path.steps, choices: path.choices, exit: "otherwise", within: iteration, ...reached };
    }
    return;
  }
  function* from(index: number, before: readonly Step[], facts: Facts): Generator<Way> {
    const candidate = decision.guards[index];
    if (candidate === undefined) {
      const { otherwise } = decision;
      if (typeof otherwise === "function") {
        yield { steps: before, exit: "otherwise" };
        return;
      }
      for (const tag of Object.keys(otherwise.cases)) {
        if (withStep(facts, { distinction: otherwise, outcome: tag }) === undefined) continue;
        yield { steps: [...before, { distinction: otherwise, outcome: tag }], exit: "case" };
      }
      return;
    }
    for (const outcome of outcomesOf(candidate.condition, facts)) {
      const steps = [...before, ...outcome.steps];
      if (outcome.result) {
        yield* from(index + 1, steps, outcome.facts);
      } else {
        yield { steps, exit: index };
      }
    }
  }
  yield* from(0, [], NO_FACTS);
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
  if (!isIteration(way.within)) return `${partLabel(way.within) ?? "a part"}: ${described}`;
  const over = isTerm(way.within.values) ? `${describeTerm(way.within.values)}[]` : "an element";
  return `each of ${over}: ${described}`;
}
