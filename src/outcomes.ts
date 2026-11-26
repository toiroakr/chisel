import type { Rule } from "./rule.js";
import type { Step } from "./ways.js";

export interface Outcome {
  readonly steps: readonly Step[];
  readonly result: boolean;
}

export function* outcomesOf(rule: Rule): Generator<Outcome> {
  switch (rule.kind) {
    case "compare":
    case "relation":
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
