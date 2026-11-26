import type { Rule } from "./rule.js";
import { holds, isTerm, positionData } from "./rule.js";
import type { Step } from "./ways.js";

export interface Outcome {
  readonly steps: readonly Step[];
  readonly result: boolean;
  // What the steps settle of the positions they compare with constants, for pruning the ways after them.
  readonly facts: Facts;
}

// What the steps of a way settle about the value of each position they compare with a constant
// by `==` or `!=`: the one value it equals, or the values it does not. A value is the same
// wherever a way reads it, so a step contradicting what the steps before it settled is taken by
// no input, and the ways through it are left out rather than listed and later found infeasible.
export interface Facts {
  readonly equal: ReadonlyMap<string, string>;
  readonly unequal: ReadonlyMap<string, ReadonlySet<string>>;
}

export const NO_FACTS: Facts = { equal: new Map(), unequal: new Map() };

function constantKey(value: unknown): string | undefined {
  switch (typeof value) {
    case "string": return `s${value.normalize("NFC")}`;
    case "boolean": return `b${value}`;
    case "bigint": return `i${value}`;
    case "number": return Number.isFinite(value) ? `n${value === 0 ? 0 : value}` : undefined;
    default: return value === null ? "null" : undefined;
  }
}

function settled(rule: Rule): { readonly position: string; readonly constant: string; readonly equal: boolean } | undefined {
  if (rule.kind !== "compare" || (rule.operator !== "==" && rule.operator !== "!=")) return undefined;
  const [term, constant] = isTerm(rule.left) ? [rule.left, rule.right] : [rule.right, rule.left];
  if (!isTerm(term) || isTerm(constant)) return undefined;
  const position = positionData(term);
  const key = constantKey(constant);
  if (position === undefined || position.measure !== "value" || key === undefined) return undefined;
  return { position: JSON.stringify(position.path), constant: key, equal: rule.operator === "==" };
}

function matched(on: unknown, tag: boolean | string): { readonly position: string; readonly constant: string; readonly equal: boolean } | undefined {
  const position = isTerm(on) ? positionData(on) : undefined;
  const key = constantKey(tag);
  return position === undefined || position.measure !== "value" || key === undefined ? undefined : { position: JSON.stringify(position.path), constant: key, equal: true };
}

// The facts with one step added, or undefined where the step contradicts them.
export function withStep(facts: Facts, step: Step): Facts | undefined {
  const fact = step.distinction.kind === "match" ? matched(step.distinction.on, step.outcome) : settled(step.distinction);
  if (fact === undefined) return facts;
  const equal = step.distinction.kind === "match" || fact.equal === step.outcome;
  const known = facts.equal.get(fact.position);
  const excluded = facts.unequal.get(fact.position);
  if (equal) {
    if (known !== undefined) return known === fact.constant ? facts : undefined;
    if (excluded?.has(fact.constant)) return undefined;
    return { equal: new Map(facts.equal).set(fact.position, fact.constant), unequal: facts.unequal };
  }
  if (known !== undefined) return known === fact.constant ? undefined : facts;
  if (excluded?.has(fact.constant)) return facts;
  return { equal: facts.equal, unequal: new Map(facts.unequal).set(fact.position, new Set([...excluded ?? [], fact.constant])) };
}

export function withSteps(facts: Facts, steps: readonly Step[]): Facts | undefined {
  let current: Facts | undefined = facts;
  for (const step of steps) {
    current = withStep(current, step);
    if (current === undefined) return undefined;
  }
  return current;
}

// The ways a rule can come out, short-circuiting as it is evaluated, leaving out those the facts
// already settled before it, or its own earlier steps, rule out.
// `constants` settles a comparison of two constants, as a clause about the answer becomes once the
// answer is written in, to the one way it comes out; a way through a model lists both, the one it
// never takes owing no row.
export function* outcomesOf(rule: Rule, facts: Facts = NO_FACTS, constants = false): Generator<Outcome> {
  switch (rule.kind) {
    case "compare":
    case "relation":
    case "all":
    case "any":
      for (const result of constants && rule.kind === "compare" && !isTerm(rule.left) && !isTerm(rule.right) ? [holds(rule, {})] : [true, false]) {
        const step = { distinction: rule, outcome: result };
        const after = withStep(facts, step);
        if (after !== undefined) yield { steps: [step], result, facts: after };
      }
      return;
    case "not":
      for (const outcome of outcomesOf(rule.rule, facts, constants)) {
        yield { ...outcome, result: !outcome.result };
      }
      return;
    case "and":
    case "or": {
      const settles = rule.kind === "or";
      const { rules } = rule;
      function* from(index: number, before: readonly Step[], known: Facts): Generator<Outcome> {
        const part = rules[index];
        if (part === undefined) {
          yield { steps: before, result: !settles, facts: known };
          return;
        }
        for (const next of outcomesOf(part, known, constants)) {
          const steps = [...before, ...next.steps];
          if (next.result === settles) {
            yield { steps, result: next.result, facts: next.facts };
          } else {
            yield* from(index + 1, steps, next.facts);
          }
        }
      }
      yield* from(0, [], facts);
    }
  }
}
