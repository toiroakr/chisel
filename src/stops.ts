// Whether a run may stop, said of the step it stops at (Souther 0.5.0): an
// operation past its type, a division by nought, a construction its schema
// refuses, a move past a temporal type's range. Every such step a model writes
// is judged, whether or not a comparison comes after it, and each is said once.
// Completion is shown or not (ADR-0125): a step `may stop` where some input
// gets there and stops, `never stops` where every valid input was run, the
// construction is proved, or the exact range of the operation leaves no room
// to stop, and `not resolved` otherwise, which is read as neither.
import type { AnyImplementation, RulesDecision } from "./behavior.js";
import { performSync } from "./behavior.js";
import { constantsOf, domainOf } from "./domain.js";
import { feasibilityScope } from "./guard-borders.js";
import { completes } from "./interval.js";
import { childrenOf, dependencyName, nodeOf, withStops } from "./model.js";
import type { StopStep } from "./model.js";
import type { ProofReport } from "./proof.js";
import { DEPS, describeTerm, isTerm, localLabel, positionData, termData } from "./rule.js";
import type { Term } from "./rule.js";
import { object, tagOf } from "./schema.js";
import { EvaluationLimit } from "./exact.js";

export interface StopCoverage {
  readonly decision: string;
  // The step, as `divide($.total, $.count)`.
  readonly at: string;
  readonly status: "may stop" | "never stops" | "not resolved";
  // An input that gets to the step and stops there, with the stand-ins it ran with.
  readonly input?: unknown;
  readonly with?: unknown;
  readonly reason?: string;
  // What to declare so that no run stops there, where it can be said.
  readonly keeping?: string;
}

export interface StopRow {
  readonly given: unknown;
  readonly deps: unknown;
}

interface Step {
  readonly template: unknown;
  readonly node: StopStep;
}

function stepsIn(written: unknown): readonly Step[] {
  const steps: Step[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown) => {
    if (value === null || typeof value !== "object" || isTerm(value)) return;
    const node = nodeOf(value);
    if (node !== undefined && seen.has(node)) return;
    if (node !== undefined) seen.add(node);
    if ((node?.kind === "operation" && node.operator !== "concat") || node?.kind === "temporal" || node?.kind === "construct") {
      steps.push({ template: value, node: node as StopStep });
    }
    for (const child of childrenOf(value)) walk(child);
  };
  walk(written);
  return steps;
}

export function describeStep(value: unknown): string {
  if (isTerm(value)) {
    const data = termData(value as Term<unknown>);
    if (data.kind === "position") {
      const [root, ...rest] = data.path;
      if (root === DEPS) return ["deps", ...rest].join(".");
      if (root?.startsWith("#local:")) return [localLabel(root), ...rest].join(".");
    }
    return describeTerm(value as Term<unknown>);
  }
  const node = nodeOf(value);
  if (node?.kind === "operation" || node?.kind === "temporal") return `${node.operator}(${describeStep(node.left)}, ${describeStep(node.right)})`;
  if (node?.kind === "construct") return `construct(${describeStep(node.value)})`;
  if (node?.kind === "call") return `${dependencyName(node.dependency)}()`;
  if (node !== undefined) return node.kind;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (value === null || typeof value !== "object") return String(value);
  return Array.isArray(value) ? "[…]" : "{…}";
}

function containsCalls(value: unknown): boolean {
  return nodeOf(value)?.kind === "call" || childrenOf(value).some(containsCalls);
}

export function stopsOf(
  implementation: AnyImplementation | undefined,
  rows: readonly StopRow[],
  options: { readonly candidates: number; readonly proof?: ProofReport },
): readonly StopCoverage[] {
  if (implementation === undefined || implementation.pipeline !== undefined || implementation.external !== undefined) return [];
  const definition = implementation.behavior;
  const decisions = new Map<unknown, string[]>();
  for (const [tag, decision] of Object.entries(implementation.cases ?? {})) {
    if ((decision as { kind?: string } | undefined)?.kind !== "rules" || (decision as RulesDecision<unknown, unknown, unknown>).expression === undefined) continue;
    decisions.set(decision, [...(decisions.get(decision) ?? []), tag]);
  }
  const coverage: StopCoverage[] = [];
  for (const [decision, tags] of decisions) {
    const rules = decision as RulesDecision<unknown, unknown, unknown>;
    const written = rules.runs ?? rules.expression;
    const steps = stepsIn(written);
    if (steps.length === 0) continue;
    const calls = containsCalls(written);
    const valueDeps = Object.entries(definition.dependencies).filter(([, dependency]) => dependency.takes === "nothing");
    const domain = calls ? undefined : domainOf(
      object({ input: definition.input, deps: object(Object.fromEntries(valueDeps.map(([name, dependency]) => [name, dependency.output]))) }),
      options.candidates,
      constantsOf(rules.guards.map(guard => guard.condition)),
    );
    const candidates: StopRow[] = [
      ...rows.filter(row => tags.includes(tagOf(definition.input, row.given) ?? "")),
      ...(domain?.values ?? []).map(value => {
        const { input, deps } = value as { input: unknown; deps: unknown };
        return { given: input, deps: valueDeps.length === 0 ? undefined : deps };
      }).filter(row => tags.includes(tagOf(definition.input, row.given) ?? "")),
    ];
    // Inputs written to stop each step: its operands' fields at the edges of
    // the exact range and at nought, into each row of the case and the case's
    // placeholder, since sampling the domain seldom reaches an edge.
    const bases: StopRow[] = [
      ...candidates.slice(0, 4),
      ...tags.map(tag => ({ given: { ...(definition.input.variants[tag]!.placeholder() as object), [definition.input.discriminant]: tag }, deps: candidates[0]?.deps })),
    ];
    for (const step of steps) candidates.push(...edgesFor(step, bases));
    const stopped = new Map<unknown, StopRow>();
    // Only this decision's steps: a dependency that runs a model of its own
    // stops at steps of that model, which are no steps of this one.
    const own = new Set<unknown>(steps.map(step => step.node));
    // A run cut short by a limit of evaluation shows neither a stop nor that
    // every step it would have reached completes.
    let incomplete = false;
    for (const row of candidates) {
      if (stopped.size === steps.length) break;
      try {
        withStops((step, error) => {
          if (own.has(step) && !isLimit(error) && !stopped.has(step)) stopped.set(step, row);
        }, () => performSync(implementation as never, row.given as never, row.deps as never));
      } catch (error) {
        if (isLimit(error)) incomplete = true;
        // A run that stops is what is looked for; one that fails elsewhere says nothing of the steps.
      }
    }
    // Proved for every case the decision decides, not for one of them.
    const proofs = options.proof?.decisions.filter(item => item.decision === rules.id) ?? [];
    const proved = proofs.length >= tags.length && proofs.every(item => item.status === "verified");
    const scopes = tags.map(tag => feasibilityScope(definition, tag));
    for (const step of steps) {
      const base = { decision: rules.id, at: describeStep(step.template) };
      const found = stopped.get(step.node);
      if (found !== undefined) {
        coverage.push({
          ...base,
          status: "may stop",
          input: found.given,
          ...(found.deps === undefined ? {} : { with: found.deps }),
          reason: `この入力の実行は${base.at}で止まる`,
          ...keepingFor(step),
        });
      } else if (domain?.exhaustive && !incomplete) {
        coverage.push({ ...base, status: "never stops", reason: "有効な入力をすべて実行した" });
      } else if (step.node.kind === "construct" && proved) {
        coverage.push({ ...base, status: "never stops", reason: "構築の証明が成り立つ" });
      } else if (step.node.kind !== "construct" && scopes.every(scope => completes(step.template, scope, []))) {
        coverage.push({ ...base, status: "never stops", reason: "読む値の範囲で演算の答えが正確に収まる" });
      } else {
        coverage.push({ ...base, status: "not resolved", reason: "止まる入力は見つからず、止まらないことも示せない" });
      }
    }
  }
  return coverage;
}

// A quotient by an input field is kept from stopping by declaring that the
// field is never nought. Not a `divide`, which stops too where the answer has
// no exact value of its type, as 1n / 3n and a decimal 1 / 3 have none.
function keepingFor(step: Step): { readonly keeping?: string } {
  const node = step.node;
  if (node.kind !== "operation" || node.operator !== "quotient" || !isTerm(node.right)) return {};
  const position = positionData(node.right as Term<unknown>);
  if (position === undefined || position.measure !== "value" || position.path.some(key => key.startsWith("#"))) return {};
  return { keeping: `${describeTerm(node.right as Term<unknown>)}に .refine(v => v.$ne(0)) を宣言すれば、${describeStep(step.template)}で止まる実行はなくなる` };
}

function isLimit(error: unknown): boolean {
  return error instanceof EvaluationLimit || (error instanceof Error && (error.name === "EvaluationLimit" || error.name === "OutOfRoom"));
}

const EDGES: readonly unknown[] = [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0, 1, -1];

function edgesFor(step: Step, bases: readonly StopRow[]): readonly StopRow[] {
  const node = step.node;
  if (node.kind !== "operation") return [];
  const paths = [node.left, node.right].flatMap(side => {
    if (!isTerm(side)) return [];
    const data = termData(side as Term<unknown>);
    const paths = data.kind === "position" ? (data.measure === "value" ? [data.path] : []) : data.parts.filter(part => part.measure === "value").map(part => part.path);
    return paths.filter(path => path.length > 0 && !path.some(key => key.startsWith("#")));
  }).slice(0, 3);
  if (paths.length === 0) return [];
  const rows: StopRow[] = [];
  const choose = (index: number, given: unknown, base: StopRow) => {
    if (rows.length >= 512) return;
    if (index === paths.length) {
      rows.push({ given, deps: base.deps });
      return;
    }
    for (const edge of EDGES) choose(index + 1, writtenAt(given, paths[index]!, edge), base);
  };
  for (const base of bases) choose(0, base.given, base);
  return rows;
}

function writtenAt(given: unknown, path: readonly string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [key, ...rest] = path;
  const record = (given !== null && typeof given === "object" ? given : {}) as Record<string, unknown>;
  return { ...record, [key!]: writtenAt(record[key!], rest, value) };
}
