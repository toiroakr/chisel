// A fold owes a row whose step reads what an earlier step answered (Souther's
// ADR-0126). A row of no element runs no step, and a row of one element runs
// the step once, on the seed, so neither tells a fold from one whose step never
// reads its accumulator, `(acc, x) => x`, or from one that keeps the first
// element. Each fold a model writes is put to two rewrites — the walk stopping
// after its first step, and every step handed the seed in place of what the
// step before it answered — and a rewrite is told apart when some answered row
// that passed comes out differently under it. Only a row that takes a second
// element can: a run that takes none is the rewrite's answer already.
import type { AnyImplementation, RulesDecision } from "./behavior.js";
import { SpecificationError, performSync } from "./behavior.js";
import { childrenOf, iterationsOf, nodeOf, withWalk } from "./model.js";
import type { Walk } from "./model.js";
import { describeTerm, isTerm, localLabel, pathsRead, termData } from "./rule.js";
import type { Rule, Term } from "./rule.js";

export type { Walk } from "./model.js";

export interface WalkCoverage {
  readonly decision: string;
  // The fold, as `fold over $.lines`.
  readonly walk: string;
  readonly rewrite: Walk;
  // `told`: some row comes out differently under the rewrite; `not told`: no
  // row does; `no row owed`: the list holds one element at most, so no row
  // can; `undecided`: a row that could tell was not run synchronously.
  readonly status: "told" | "not told" | "no row owed" | "undecided";
  // The row that told it apart.
  readonly row?: string;
  readonly reason?: string;
}

export interface WalkRow {
  readonly name: string;
  readonly given: unknown;
  readonly deps: unknown;
  readonly expected: unknown;
}

export interface Fold {
  readonly decision: RulesDecision<unknown, unknown, unknown>;
  readonly tags: readonly string[];
  readonly node: unknown;
  readonly label: string;
  // The list the fold walks, where it is an input field: its path.
  readonly over?: readonly string[];
  // Set where the list is written with one element or none.
  readonly single?: true;
}

type FoldNode = { readonly kind: "fold"; readonly name: string; readonly accumulator: string; readonly values: unknown; readonly initial: unknown; readonly body: unknown };

// The folds an implementation's models write, each once however many cases
// its decision decides, leaving out a fold that reads nothing a run is handed:
// it answers one value on every run, and so does either rewrite of it.
export function foldsOf(implementation: AnyImplementation | undefined): readonly Fold[] {
  if (implementation === undefined || implementation.pipeline !== undefined || implementation.external !== undefined) return [];
  const decisions = new Map<unknown, string[]>();
  for (const [tag, decision] of Object.entries(implementation.cases ?? {})) {
    if ((decision as { kind?: string } | undefined)?.kind !== "rules") continue;
    const tags = decisions.get(decision) ?? [];
    tags.push(tag);
    decisions.set(decision, tags);
  }
  const folds: Fold[] = [];
  for (const [decision, tags] of decisions) {
    const rules = decision as RulesDecision<unknown, unknown, unknown>;
    const written = rules.runs ?? rules.expression;
    if (written === undefined) continue;
    for (const node of new Set(iterationsOf(written))) {
      if (node.kind !== "fold") continue;
      const fold = node as unknown as FoldNode;
      if (!readsRun(fold)) continue;
      const values = fold.values;
      const label = isTerm(values) ? `fold over ${termLabel(values)}` : "fold";
      const position = isTerm(values) ? termData(values as Term<unknown>) : undefined;
      const over = position?.kind === "position" && position.measure === "value" && !position.path[0]!.startsWith("#") ? position.path : undefined;
      const single = Array.isArray(values) && nodeOf(values) === undefined && values.length <= 1;
      folds.push({ decision: rules, tags, node, label, ...(over === undefined ? {} : { over }), ...(single ? { single: true as const } : {}) });
    }
  }
  return folds;
}

function termLabel(term: unknown): string {
  const data = termData(term as Term<unknown>);
  if (data.kind === "position" && data.path[0]?.startsWith("#local:")) return [localLabel(data.path[0]), ...data.path.slice(1)].join(".");
  return describeTerm(term as Term<unknown>);
}

function readsRun(fold: FoldNode): boolean {
  const own = new Set([fold.name, fold.accumulator]);
  const seen = new Set<unknown>();
  let reads = false;
  const rooted = (path: readonly string[]) => {
    if (path[0] !== undefined && !own.has(path[0])) reads = true;
  };
  const walk = (value: unknown) => {
    if (reads || value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (isTerm(value)) {
      const data = termData(value as Term<unknown>);
      if (data.kind === "position") rooted(data.path);
      else for (const part of data.parts) rooted(part.path);
      return;
    }
    const node = nodeOf(value);
    if (node?.kind === "choose") for (const path of pathsRead(node.condition as Rule)) rooted(path);
    if (node?.kind === "call") reads = true;
    for (const child of childrenOf(value)) walk(child);
  };
  for (const part of [fold.values, fold.initial, fold.body]) walk(part);
  return reads;
}

export interface WalkRun {
  readonly actual?: unknown;
  readonly error?: unknown;
  // The run could not be made synchronously.
  readonly pending?: true;
  // How many elements each fold entered was handed, once per entering.
  readonly elements: ReadonlyMap<unknown, readonly number[]>;
}

export function runWalk(implementation: AnyImplementation, given: unknown, deps: unknown, rewrite?: { readonly node: unknown; readonly walk: Walk }): WalkRun {
  const elements = new Map<unknown, number[]>();
  const observe = (node: unknown, count: number) => {
    const counts = elements.get(node) ?? [];
    counts.push(count);
    elements.set(node, counts);
  };
  try {
    const actual = withWalk(rewrite, observe, () => performSync(implementation as never, given as never, deps as never));
    return { actual, elements };
  } catch (error) {
    if (error instanceof SpecificationError && error.message.includes("answered a promise")) return { pending: true, elements };
    return { error, elements };
  }
}

export const walks: readonly Walk[] = ["after one step", "from the seed"];

export function tookSecond(run: WalkRun, node: unknown): boolean {
  return (run.elements.get(node) ?? []).some(count => count >= 2);
}

// Whether a rewrite of a fold changes how a run on `given` comes out:
// `answers` says whether what the rewritten run answered is the answer.
export function tells(implementation: AnyImplementation, fold: Fold, walk: Walk, given: unknown, deps: unknown, answers: (actual: unknown) => boolean): boolean | "pending" {
  const rewritten = runWalk(implementation, given, deps, { node: fold.node, walk });
  if (rewritten.pending) return "pending";
  return rewritten.error !== undefined || !answers(rewritten.actual);
}

export function walksOf(
  implementation: AnyImplementation | undefined,
  rows: readonly WalkRow[],
  answers: (expected: unknown, actual: unknown) => boolean,
  tagOfGiven: (given: unknown) => string | undefined,
): readonly WalkCoverage[] {
  if (implementation === undefined) return [];
  const coverage: WalkCoverage[] = [];
  for (const fold of foldsOf(implementation)) {
    const ofCase = rows.filter(row => fold.tags.includes(tagOfGiven(row.given) ?? ""));
    const plain = ofCase.map(row => ({ row, run: runWalk(implementation, row.given, row.deps) }));
    const entered = plain.filter(({ run }) => run.elements.has(fold.node));
    const second = plain.filter(({ run }) => tookSecond(run, fold.node));
    const pendingPlain = plain.some(({ run }) => run.pending);
    for (const walk of walks) {
      const base = { decision: fold.decision.id, walk: fold.label, rewrite: walk };
      if (fold.single) {
        coverage.push({ ...base, status: "no row owed", reason: "リストが要素を一つしか持たない" });
        continue;
      }
      let told: string | undefined;
      let pending = pendingPlain;
      for (const { row } of second) {
        const outcome = tells(implementation, fold, walk, row.given, row.deps, actual => answers(row.expected, actual));
        if (outcome === "pending") pending = true;
        else if (outcome) { told = row.name; break; }
      }
      if (told !== undefined) coverage.push({ ...base, status: "told", row: told });
      else if (pending) coverage.push({ ...base, status: "undecided", reason: "同期に実行できない行がある" });
      else coverage.push({
        ...base,
        status: "not told",
        reason: entered.length === 0
          ? "答えのある行がfoldに入らない"
          : second.length === 0
            ? "二つ目の要素まで歩く答えのある行がない"
            : "二つ以上の要素を歩く行も、書き換えで答えが変わらない",
      });
    }
  }
  return coverage;
}

// A short sentence a report writes for a rewrite no row tells apart.
export function describeWalk(item: WalkCoverage): string {
  const rewrite = item.rewrite === "after one step" ? "最初の要素で止めても" : "各段階に前の答えの代わりに初期値を渡しても";
  return `${item.decision}: ${item.walk}を${rewrite}答えの変わる行がない`;
}
