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

// --- counting ----------------------------------------------------------------

// How many outcomes of a rule hold and how many fail, as outcomesOf lists
// them, worked out without listing them: a conjunction of n disjunctions has
// 2^n outcomes, too many to visit.
export function outcomeCounts(rule: Rule): { readonly holds: bigint; readonly fails: bigint } {
  switch (rule.kind) {
    case "not": {
      const inner = outcomeCounts(rule.rule);
      return { holds: inner.fails, fails: inner.holds };
    }
    case "and":
    case "or": {
      // The outcomes that settle the junction end it; the others go on to the next part.
      const settles = rule.kind === "or";
      let going = 1n, settled = 0n;
      for (const part of rule.rules) {
        const counts = outcomeCounts(part);
        const [settling, continuing] = settles ? [counts.holds, counts.fails] : [counts.fails, counts.holds];
        settled += going * settling;
        going *= continuing;
      }
      return settles ? { holds: settled, fails: going } : { holds: going, fails: settled };
    }
    default:
      return { holds: 1n, fails: 1n };
  }
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

// Where each child of a node stands, as the report names it.
function labelled(template: unknown, at: string): { readonly paths: readonly (readonly [unknown, string])[]; readonly body?: readonly [unknown, string] } {
  const node = nodeOf(template);
  const join = (key: string) => (at === "答え" ? key : `${at}.${key}`);
  if (node === undefined) {
    if (isTerm(template) || template === null || typeof template !== "object") return { paths: [] };
    if (Array.isArray(template)) return { paths: template.map((child, index) => [child, `${at}[${index}]`] as const) };
    return { paths: Object.entries(template as object).map(([key, child]) => [child, join(key)] as const) };
  }
  switch (node.kind) {
    case "choose": {
      const condition = describeRule(node.condition as Rule);
      // The field the choice stands in, so two choices on one condition are told apart.
      const where = at === "答え" ? "" : `${at}の`;
      return { paths: [[node.yes, `${where}「${condition}」が成り立つ側`], [node.no, `${where}「${condition}」が成り立たない側`]] };
    }
    case "bind":
      return { paths: [[node.value, `${at}で束ねる値`], [node.body, at]] };
    case "map":
      return { paths: [[node.values, `${at}のmapが回す値`]], body: [node.body, `${at}のmapの本体`] };
    case "fold":
      return { paths: [[node.values, `${at}のfoldが回す値`], [node.initial, `${at}のfoldの初期値`]], body: [node.body, `${at}のfoldの本体`] };
    case "call":
      return { paths: [[node.input, `${at}のcallの引数`]] };
    case "construct":
      return { paths: [[node.value, at]] };
    case "operation":
    case "temporal":
      return { paths: [[node.left, `${at}の${node.operator}の左`], [node.right, `${at}の${node.operator}の右`]] };
  }
}

interface TreeNode {
  readonly template: unknown;
  readonly at: string;
  readonly parent: number | undefined;
  readonly choose: boolean;
  readonly children: number[];
  // For a choice, how many of its outcomes go to each branch.
  readonly weights: bigint[];
  readonly root: number;
  // The bodies of the walks this node is, each a root of its own.
  readonly bodies: number[];
  // For a body's root, the walk it is the body of.
  readonly owner?: number;
  size: number;
}

// The model as the ways count it: one tree of the paths through it, and one
// for each walk's body, whose ways are listed apart.
function treeOf(expression: unknown): TreeNode[] {
  const nodes: TreeNode[] = [];
  const build = (template: unknown, at: string, parent: number | undefined, root: number | undefined, owner?: number): number => {
    const id = nodes.length;
    const node = nodeOf(template);
    const entry: TreeNode = { template, at, parent, choose: node?.kind === "choose", children: [], weights: [], root: root ?? id, bodies: [], ...(owner === undefined ? {} : { owner }), size: 1 };
    nodes.push(entry);
    const { paths, body } = labelled(template, at);
    const followed = new Set(pathChildren(template));
    if (node?.kind === "choose") {
      const { holds, fails } = outcomeCounts(node.condition as Rule);
      entry.children.push(build(node.yes, paths[0]![1], id, entry.root), build(node.no, paths[1]![1], id, entry.root));
      entry.weights.push(holds, fails);
    } else {
      for (const [child, label] of paths) if (followed.has(child)) entry.children.push(build(child, label, id, entry.root));
    }
    if (body !== undefined) entry.bodies.push(build(body[0], body[1], undefined, undefined, id));
    entry.size = 1 + entry.children.reduce((sum, child) => sum + nodes[child]!.size, 0) + entry.bodies.reduce((sum, child) => sum + nodes[child]!.size, 0);
    return id;
  };
  build(expression, "答え", undefined, undefined);
  return nodes;
}

interface Counted {
  readonly count: readonly bigint[];
  // The ways of the bodies of walks within each node, alive under the cut.
  readonly within: readonly bigint[];
  readonly total: bigint;
}

function counted(nodes: readonly TreeNode[], cut: ReadonlySet<number>): Counted {
  const count: bigint[] = Array(nodes.length).fill(1n);
  const within: bigint[] = Array(nodes.length).fill(0n);
  // Children come after their parent, so a pass from the end sees them first.
  for (let id = nodes.length - 1; id >= 0; id--) {
    const node = nodes[id]!;
    if (cut.has(id)) { count[id] = 1n; within[id] = 0n; continue; }
    count[id] = node.choose
      ? node.children.reduce((sum, child, index) => sum + node.weights[index]! * count[child]!, 0n)
      : node.children.reduce((product, child) => product * count[child]!, 1n);
    within[id] = node.children.reduce((sum, child) => sum + within[child]!, 0n) +
      node.bodies.reduce((sum, body) => sum + contribution(count[body]!, true) + within[body]!, 0n);
  }
  return { count, within, total: count[0]! + within[0]! };
}

// A body with one way distinguishes nothing and lists none.
function contribution(count: bigint, body: boolean): bigint {
  return body && count <= 1n ? 0n : count;
}

function expressionChange(decision: string, expression: unknown, limit: number): ModelChange | undefined {
  const nodes = treeOf(expression);
  const bound = BigInt(limit);
  const first = counted(nodes, new Set());
  const ways = first.total;
  if (ways <= bound) return undefined;
  const own = (id: number) => first.count[id]! + first.within[id]!;
  const ancestors = (id: number): number[] => {
    const chain: number[] = [];
    for (let at: number | undefined = id; at !== undefined;) {
      const node: TreeNode = nodes[at]!;
      const up: number | undefined = node.parent ?? node.owner;
      if (up !== undefined) chain.push(up);
      at = up;
    }
    return chain;
  };
  const cut = new Set<number>();
  // Each round cuts one more node, none inside another, while the rest shrinks.
  for (let round = 0; round < nodes.length; round++) {
    const now = counted(nodes, cut);
    if (now.total <= bound) break;
    const blocked = (id: number) => cut.has(id) || ancestors(id).some(up => cut.has(up));
    let alone: { id: number; size: number } | undefined;
    let best: { id: number; left: bigint; size: number } | undefined;
    for (let id = 1; id < nodes.length; id++) {
      const node = nodes[id]!;
      if (isTerm(node.template) || blocked(id) || [...cut].some(other => ancestors(other).includes(id))) continue;
      // A part declared as a behavior is measured under the same limit.
      if (own(id) <= 1n || own(id) > bound) continue;
      // The root's count with this node taken as one way, along the path up to it.
      let value = 1n;
      let at = id;
      while (nodes[at]!.parent !== undefined) {
        const parent = nodes[nodes[at]!.parent!]!;
        const index = parent.children.indexOf(at);
        const old = now.count[nodes[at]!.parent!]!;
        value = parent.choose ? old - parent.weights[index]! * now.count[at]! + parent.weights[index]! * value : (old / now.count[at]!) * value;
        at = nodes[at]!.parent!;
      }
      const root = nodes[at]!;
      const isBody = root.owner !== undefined;
      const left = now.total - contribution(now.count[at]!, isBody) + contribution(value, isBody) - now.within[id]!;
      if (left <= bound) {
        if (alone === undefined || node.size < alone.size) alone = { id, size: node.size };
      } else if (best === undefined || left < best.left || (left === best.left && node.size < best.size)) {
        best = { id, left, size: node.size };
      }
    }
    const chosen = alone?.id ?? (best !== undefined && best.left < now.total ? best.id : undefined);
    if (chosen === undefined) break;
    cut.add(chosen);
  }
  const remaining = counted(nodes, cut).total;
  const factors = factorsOf(expression).filter(item => item.ways > 1n);
  const product = factors.length > 1 ? `道筋は${factors.map(item => `${item.at}（${format(item.ways)}本）`).join("、")}の掛け算で増える。` : "";
  const head = `${decision}: 道筋が${format(ways)}本あり、上限の${format(bound)}本を超えるため計測しない。${product}`;
  const tail = `いまのまま計測するには上限（--feasibility-ways）を${format(ways)}以上にする。`;
  if (cut.size === 0 || remaining > bound) {
    return { decision, figure: "ways", limit, ways: ways.toString(), kind: "none", parts: [], message: `${head}上限の内に収まる部分をbehaviorとして切り出しても、残りが上限の内に収まらない。選択を減らすか、${tail}` };
  }
  const parts = [...cut].sort((a, b) => a - b).map((id): ModelChangePart => ({ at: nodes[id]!.at, conditions: conditionsIn(nodes[id]!.template), ways: own(id).toString() }));
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

function pathsIn(template: unknown): bigint {
  const node = nodeOf(template);
  if (node?.kind === "choose") {
    const { holds, fails } = outcomeCounts(node.condition as Rule);
    return holds * pathsIn(node.yes) + fails * pathsIn(node.no);
  }
  let product = 1n;
  for (const child of pathChildren(template)) product *= pathsIn(child);
  return product;
}

// The parts whose ways multiply at the top of the model: the children of
// every node a way goes through all of, down to the first choice.
function factorsOf(expression: unknown): readonly { readonly at: string; readonly ways: bigint }[] {
  const factors: { at: string; ways: bigint }[] = [];
  const walk = (template: unknown, at: string) => {
    const node = nodeOf(template);
    const children = pathChildren(template);
    if (node?.kind === "choose" || children.length === 0) {
      factors.push({ at, ways: pathsIn(template) });
      return;
    }
    if (children.filter(child => pathsIn(child) > 1n).length <= 1 && template !== expression) {
      factors.push({ at, ways: pathsIn(template) });
      return;
    }
    const labels = new Map(labelled(template, at).paths.map(([child, label]) => [child, label]));
    for (const child of children) walk(child, labels.get(child) ?? at);
  };
  walk(expression, "答え");
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

// --- guards ------------------------------------------------------------------

function guardsChange(decision: RulesDecision<unknown, unknown, unknown>, limit: number): ModelChange | undefined {
  const counts = decision.guards.map(guard => outcomeCounts(guard.condition as Rule));
  const { otherwise } = decision;
  const matched = typeof otherwise !== "function";
  const cases = matched ? BigInt(Object.keys(otherwise.cases).length) : 1n;
  const n = counts.length;
  // The items stages are cut from: each guard, then the match, which may be a stage of its own.
  const end = n + (matched ? 1 : 0);
  // The ways through items [from, to), continuing to `to` in one way unless
  // it is the end, where the match (if the stage holds it) divides them.
  const waysOf = (from: number, to: number) => {
    let through = 1n, sum = 0n;
    for (let index = from; index < Math.min(to, n); index++) {
      sum += through * counts[index]!.fails;
      through *= counts[index]!.holds;
    }
    return sum + through * (matched && to === end ? cases : 1n);
  };
  const ways = waysOf(0, end);
  const bound = BigInt(limit);
  if (ways <= bound) return undefined;
  const head = `${decision.id}: 道筋が${format(ways)}本あり、上限の${format(bound)}本を超えるため計測しない。guardを順に通る道筋は、各guardが成り立つ道筋の掛け算で増える。`;
  const tail = `いまのまま計測するには上限（--feasibility-ways）を${format(ways)}以上にする。`;
  const stages: { from: number; to: number; ways: bigint }[] = [];
  let from = 0;
  while (from < end) {
    if (waysOf(from, from + 1) > bound) { stages.length = 0; break; }
    let to = from + 1;
    while (to < end && waysOf(from, to + 1) <= bound) to++;
    stages.push({ from, to, ways: waysOf(from, to) });
    from = to;
  }
  const label = (stage: { from: number; to: number }) => {
    const last = Math.min(stage.to, n);
    const guards = stage.from >= n ? "" : stage.from + 1 === last ? `guard ${stage.from + 1}` : `guard ${stage.from + 1}〜${last}`;
    const match = matched && stage.to === end ? "match" : "";
    return [guards, match].filter(part => part !== "").join("と");
  };
  if (stages.length < 2) {
    return { decision: decision.id, figure: "ways", limit, ways: ways.toString(), kind: "none", parts: [], message: `${head}guardを段に分けても上限の内に収まらない。一つの条件の書き方を減らすか、${tail}` };
  }
  const parts = stages.map((stage): ModelChangePart => ({
    at: label(stage),
    conditions: decision.guards.slice(stage.from, Math.min(stage.to, n)).map(guard => describeRule(guard.condition as Rule)),
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
