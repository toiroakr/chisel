// What to change in a model before measuring it (Souther 0.5.0, "the report
// says how to change the model"): a decision whose ways are more than the
// limit is not measured, and rather than only saying so, the report names
// where the ways multiply and which part, declared as a behavior of its own,
// leaves the rest within the limit. What is said is read off the shape of the
// decision alone, by counting its ways without listing them, so it can be said
// before anything is measured and does not change with what the measurement
// finds.
import type { RulesDecision } from "./behavior.js";
import { childrenOf, nodeOf } from "./model.js";
import { outcomesOf } from "./outcomes.js";
import { describeRule, isTerm } from "./rule.js";
import type { Rule } from "./rule.js";

export interface ModelChangePart {
  // Where the part stands in the model (`result.total`, `the yes branch of
  // choose($.a > 0)`), or the guards and the match a stage takes.
  readonly at: string;
  // The conditions the part chooses on, as the report writes them.
  readonly conditions: readonly string[];
  // Its ways, as an exact decimal string (they may be past 2^53).
  readonly ways: string;
}

export interface ModelChange {
  readonly decision: string;
  // The figure the decision stops at: the ways a decision's rules and arms are
  // measured through, `CheckOptions.feasibility.ways`.
  readonly figure: "ways";
  readonly limit: number;
  readonly ways: string;
  // `behavior`: declare each part as a behavior and call it as a dependency
  // (`call(deps.x, …)`), whose answer is read as a value, so its choices are
  // measured once in its own report. `stages`: split the guards into behaviors
  // joined with `compose`. `none`: no such split leaves every part within the
  // limit.
  readonly kind: "behavior" | "stages" | "none";
  readonly parts: readonly ModelChangePart[];
  // The ways left in this decision once the parts are taken out (`behavior`).
  readonly remaining?: string;
  readonly message: string;
}

export function changeOf(decision: RulesDecision<unknown, unknown, unknown>, limit: number): ModelChange | undefined {
  return decision.expression !== undefined ? expressionChange(decision.id, decision.expression, limit) : guardsChange(decision, limit);
}

// The message a summary prints for a decision left for a change.
export const toBeChangedFirst = "計測しない（先に変更する）";

function format(ways: bigint): string {
  return ways.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function conditionsText(conditions: readonly string[]): string {
  const shown = conditions.slice(0, 3).map(condition => `「${condition}」`).join("");
  return conditions.length > 3 ? `${shown}ほか${conditions.length - 3}つ` : shown;
}

// --- a model -----------------------------------------------------------------

// The children a way of the model goes through, as `modelPaths` reads them: an
// iteration's body is not one of them, since its ways are listed apart.
function pathChildren(template: unknown): readonly unknown[] {
  const node = nodeOf(template);
  if (node?.kind === "map") return [node.values];
  if (node?.kind === "fold") return [node.values, node.initial];
  if (node?.kind === "choose") return [];
  return childrenOf(template);
}

interface Located {
  readonly template: unknown;
  readonly at: string;
}

function expressionChange(decision: string, expression: unknown, limit: number): ModelChange | undefined {
  const total = (cut: ReadonlySet<unknown>) => decisionWays(expression, cut);
  const ways = total(new Set());
  if (ways <= BigInt(limit)) return undefined;
  const candidates = locate(expression).filter(item => item.template !== expression && !isTerm(item.template) && pathsIn(item.template, new Set()) + bodyWays(item.template, new Set()) > 1n);
  const sizes = new Map(candidates.map(item => [item.template, sizeOf(item.template)]));
  const cut: Located[] = [];
  for (let round = 0; round < 8 && total(new Set(cut.map(item => item.template))) > BigInt(limit); round++) {
    const taken = new Set(cut.map(item => item.template));
    const under = new Set(cut.flatMap(item => locate(item.template).map(inner => inner.template)));
    let alone: { item: Located; size: number } | undefined;
    let best: { item: Located; left: bigint; size: number } | undefined;
    for (const item of candidates.slice(0, 2000)) {
      if (under.has(item.template)) continue;
      const left = total(new Set([...taken, item.template]));
      const size = sizes.get(item.template)!;
      if (left <= BigInt(limit)) {
        if (alone === undefined || size < alone.size) alone = { item, size };
      } else if (best === undefined || left < best.left || (left === best.left && size < best.size)) {
        best = { item, left, size };
      }
    }
    const chosen = alone?.item ?? (best !== undefined && best.left < total(taken) ? best.item : undefined);
    if (chosen === undefined) break;
    cut.push(chosen);
  }
  // A part another part holds goes with it.
  const kept = cut.filter(item => !cut.some(other => other !== item && locate(other.template).some(inner => inner.template === item.template)));
  const remaining = total(new Set(kept.map(item => item.template)));
  const factors = factorsOf(expression).filter(item => item.ways > 1n);
  const product = factors.length > 1 ? `道筋は${factors.map(item => `${item.at}（${format(item.ways)}本）`).join("、")}の掛け算で増える。` : "";
  const head = `${decision}: 道筋が${format(ways)}本あり、上限の${format(BigInt(limit))}本を超えるため計測しない。${product}`;
  const tail = `いまのまま計測するには上限（--feasibility-ways）を${format(ways)}以上にする。`;
  if (kept.length === 0 || remaining > BigInt(limit)) {
    return { decision, figure: "ways", limit, ways: ways.toString(), kind: "none", parts: [], message: `${head}一部をbehaviorとして切り出しても上限の内に収まらない。選択を減らすか、${tail}` };
  }
  const parts = kept.map((item): ModelChangePart => ({ at: item.at, conditions: conditionsIn(item.template), ways: (pathsIn(item.template, new Set()) + bodyWays(item.template, new Set())).toString() }));
  const named = parts.map(part => `${part.at}${part.conditions.length === 0 ? "" : `（${conditionsText(part.conditions)}で選ぶ、${format(BigInt(part.ways))}本）`}`).join("と");
  return {
    decision,
    figure: "ways",
    limit,
    ways: ways.toString(),
    kind: "behavior",
    parts,
    remaining: remaining.toString(),
    message: `${head}${named}をbehaviorとして宣言し、dependencyとしてcall(deps.…)で呼べば、その選択はそのbehaviorのレポートで一度ずつ計測され、ここでは答えを値として読むので、このdecisionの道筋は${format(remaining)}本になる。${tail}`,
  };
}

// The ways eachWayOf lists for a model: those through the model, and those
// through each iteration's body that distinguishes anything.
function decisionWays(expression: unknown, cut: ReadonlySet<unknown>): bigint {
  return pathsIn(expression, cut) + bodyWays(expression, cut);
}

function pathsIn(template: unknown, cut: ReadonlySet<unknown>): bigint {
  if (cut.has(template)) return 1n;
  const node = nodeOf(template);
  if (node?.kind === "choose") {
    let sum = 0n;
    for (const outcome of outcomesOf(node.condition as Rule)) sum += pathsIn(outcome.result ? node.yes : node.no, cut);
    return sum;
  }
  let product = 1n;
  for (const child of pathChildren(template)) product *= pathsIn(child, cut);
  return product;
}

function bodyWays(template: unknown, cut: ReadonlySet<unknown>, seen: Set<unknown> = new Set()): bigint {
  if (cut.has(template) || seen.has(template)) return 0n;
  seen.add(template);
  const node = nodeOf(template);
  let sum = 0n;
  if (node?.kind === "map" || node?.kind === "fold") {
    const own = pathsIn(node.body, cut);
    if (own > 1n) sum += own;
  }
  for (const child of childrenOf(template)) sum += bodyWays(child, cut, seen);
  return sum;
}

// Every subexpression with where it stands.
function locate(template: unknown, at = "答え", found: Located[] = [], seen: Set<unknown> = new Set()): Located[] {
  if (seen.has(template) || isTerm(template) || template === null || typeof template !== "object") return found;
  seen.add(template);
  found.push({ template, at });
  const node = nodeOf(template);
  const join = (key: string) => (at === "答え" ? key : `${at}.${key}`);
  if (node === undefined) {
    if (Array.isArray(template)) template.forEach((child, index) => locate(child, `${at}[${index}]`, found, seen));
    else for (const [key, child] of Object.entries(template as object)) locate(child, join(key), found, seen);
    return found;
  }
  switch (node.kind) {
    case "choose": {
      const condition = describeRule(node.condition as Rule);
      locate(node.yes, `「${condition}」が成り立つ側`, found, seen);
      locate(node.no, `「${condition}」が成り立たない側`, found, seen);
      break;
    }
    case "bind":
      locate(node.value, `${at}で束ねる値`, found, seen);
      locate(node.body, at, found, seen);
      break;
    case "map":
    case "fold":
      locate(node.values, `${at}の${node.kind}が回す値`, found, seen);
      if (node.kind === "fold") locate(node.initial, `${at}のfoldの初期値`, found, seen);
      locate(node.body, `${at}の${node.kind}の本体`, found, seen);
      break;
    case "call":
      locate(node.input, `${at}のcallの引数`, found, seen);
      break;
    case "construct":
      locate(node.value, at, found, seen);
      break;
    case "operation":
    case "temporal":
      locate(node.left, `${at}の${node.operator}の左`, found, seen);
      locate(node.right, `${at}の${node.operator}の右`, found, seen);
      break;
    default:
      for (const child of childrenOf(template)) locate(child, at, found, seen);
  }
  return found;
}

// The parts whose ways multiply at the top of the model: the children of
// every node a way goes through all of, down to the first choice.
function factorsOf(expression: unknown): readonly { readonly at: string; readonly ways: bigint }[] {
  const located = new Map(locate(expression).map(item => [item.template, item.at]));
  const factors: { at: string; ways: bigint }[] = [];
  const walk = (template: unknown) => {
    const node = nodeOf(template);
    const children = pathChildren(template);
    if (node?.kind === "choose" || children.length === 0) {
      factors.push({ at: located.get(template) ?? "答え", ways: pathsIn(template, new Set()) });
      return;
    }
    if (children.filter(child => pathsIn(child, new Set()) > 1n).length <= 1 && template !== expression) {
      factors.push({ at: located.get(template) ?? "答え", ways: pathsIn(template, new Set()) });
      return;
    }
    for (const child of children) walk(child);
  };
  walk(expression);
  return factors;
}

function conditionsIn(template: unknown): readonly string[] {
  const conditions = new Set<string>();
  const seen = new Set<unknown>();
  const walk = (value: unknown) => {
    if (seen.has(value) || isTerm(value) || value === null || typeof value !== "object") return;
    seen.add(value);
    const node = nodeOf(value);
    if (node?.kind === "choose") conditions.add(describeRule(node.condition as Rule));
    for (const child of childrenOf(value)) walk(child);
  };
  walk(template);
  return [...conditions];
}

function sizeOf(template: unknown): number {
  return locate(template).length;
}

// --- guards ------------------------------------------------------------------

function guardsChange(decision: RulesDecision<unknown, unknown, unknown>, limit: number): ModelChange | undefined {
  const counts = decision.guards.map(guard => {
    let holds = 0n, fails = 0n;
    for (const outcome of outcomesOf(guard.condition as Rule)) outcome.result ? holds++ : fails++;
    return { holds, fails };
  });
  const { otherwise } = decision;
  const cases = typeof otherwise === "function" ? 1n : BigInt(Object.keys(otherwise.cases).length);
  const n = counts.length;
  // The ways through guards [from, to), continuing to `to` in one way unless
  // it is the end, where the match divides them.
  const waysOf = (from: number, to: number) => {
    let through = 1n, sum = 0n;
    for (let index = from; index < to; index++) {
      sum += through * counts[index]!.fails;
      through *= counts[index]!.holds;
    }
    return sum + through * (to === n ? cases : 1n);
  };
  const ways = waysOf(0, n);
  if (ways <= BigInt(limit)) return undefined;
  const head = `${decision.id}: 道筋が${format(ways)}本あり、上限の${format(BigInt(limit))}本を超えるため計測しない。guardを順に通る道筋は、各guardが成り立つ道筋の掛け算で増える。`;
  const tail = `いまのまま計測するには上限（--feasibility-ways）を${format(ways)}以上にする。`;
  const stages: { from: number; to: number; ways: bigint }[] = [];
  let from = 0;
  while (from < n) {
    if (waysOf(from, from + 1) > BigInt(limit)) { stages.length = 0; break; }
    let to = from + 1;
    while (to < n && waysOf(from, to + 1) <= BigInt(limit)) to++;
    stages.push({ from, to, ways: waysOf(from, to) });
    from = to;
  }
  const label = (stage: { from: number; to: number }) => {
    const guards = stage.from + 1 === stage.to ? `guard ${stage.from + 1}` : `guard ${stage.from + 1}〜${stage.to}`;
    return stage.to === n && typeof otherwise !== "function" ? `${guards}とmatch` : guards;
  };
  if (stages.length < 2) {
    return { decision: decision.id, figure: "ways", limit, ways: ways.toString(), kind: "none", parts: [], message: `${head}guardを段に分けても上限の内に収まらない。一つの条件の書き方を減らすか、${tail}` };
  }
  const parts = stages.map((stage): ModelChangePart => ({
    at: label(stage),
    conditions: decision.guards.slice(stage.from, stage.to).map(guard => describeRule(guard.condition as Rule)),
    ways: stage.ways.toString(),
  }));
  return {
    decision: decision.id,
    figure: "ways",
    limit,
    ways: ways.toString(),
    kind: "stages",
    parts,
    message: `${head}${stages.map(stage => `${label(stage)}（${format(stage.ways)}本）`).join("、")}をそれぞれbehaviorにしてcomposeでつなげば、各段は上限の内で計測される。${tail}`,
  };
}
