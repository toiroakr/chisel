import { isDeepStrictEqual } from "node:util";
import type { AnyBehavior, AnyImplementation } from "./behavior.js";
import { isTodo } from "./behavior.js";
import type { Example, CoverageStatus } from "./specification.js";
import type { GuardPartition } from "./guard-borders.js";
import { feasibilityScope } from "./guard-borders.js";
import { keepingInvariants, keepingOrderings } from "./feasibility.js";
import type { Position } from "./partition.js";
import { constantsOf, domainOf } from "./domain.js";

export interface PairObligation {
  readonly positions: readonly [string, string];
  readonly classes: readonly [string, string];
  readonly status: CoverageStatus;
  readonly reason?: string;
}

export interface PairMeasure {
  readonly status: "complete" | "partial";
  readonly obligations: readonly PairObligation[];
  readonly notRead: readonly string[];
}

interface Axis {
  readonly position: Position;
  readonly classes: readonly string[];
  classify(given: unknown): readonly string[];
  instances(given: unknown): readonly { readonly segments: readonly string[]; readonly classes: readonly string[] }[];
  place(given: unknown, name: string): unknown;
}

export const PAIR_LIMIT = 20000;

export function pairCoverage(
  definition: AnyBehavior,
  implementation: AnyImplementation | undefined,
  positions: readonly Position[],
  partitions: readonly GuardPartition[],
  rows: readonly Example<AnyBehavior>[],
  limits: { readonly obligations: number; readonly candidates: number },
): { readonly measure: PairMeasure; readonly witnesses: readonly { readonly obligation: PairObligation; readonly given: unknown }[] } {
  const axes = axesOf(positions, partitions);
  if (axes.length < 2) return { measure: { status: "complete", obligations: [], notRead: [] }, witnesses: [] };
  const obligations: PairObligation[] = [];
  const witnesses: { obligation: PairObligation; given: unknown }[] = [];
  const notRead: string[] = [];
  const rules = Object.values(implementation?.cases ?? {}).flatMap(decision => decision.kind === "rules" ? decision.guards.map(guard => guard.condition) : []);
  let searched: ReturnType<typeof domainOf> | undefined;
  const validRows = rows.filter(row => definition.input.parse(row.given).success);
  let attempted = 0;
  for (let leftIndex = 0; leftIndex < axes.length; leftIndex++) {
    const left = axes[leftIndex]!;
    for (const right of axes.slice(leftIndex + 1)) {
      if (!coexist(left.position.segments, right.position.segments)) continue;
      for (const first of left.classes) for (const second of right.classes) {
        if (obligations.length >= limits.obligations) {
          notRead.push(`組み合わせが上限の${limits.obligations}通りを超える`);
          return result();
        }
        let sharedCollection = -1;
        for (let index = 0; index < Math.min(left.position.segments.length, right.position.segments.length); index++) {
          if (left.position.segments[index] !== right.position.segments[index]) break;
          if (["[]", "{}"].includes(left.position.segments[index]!)) sharedCollection = index;
        }
        const matches = (given: unknown) => sharedCollection < 0
          ? left.classify(given).includes(first) && right.classify(given).includes(second)
          : left.instances(given).some(a => a.classes.includes(first) && right.instances(given).some(b => b.classes.includes(second) && isDeepStrictEqual(a.segments.slice(0, sharedCollection + 1), b.segments.slice(0, sharedCollection + 1))));
        const matching = validRows.filter(row => matches(row.given));
        const base = { positions: [left.position.path, right.position.path] as const, classes: [first, second] as const };
        if (matching.some(row => !isTodo(row.expect))) {
          obligations.push({ ...base, status: "met" });
          continue;
        }
        if (matching.length > 0) {
          obligations.push({ ...base, status: "answer owed" });
          continue;
        }
        const domain = searched ??= domainOf(definition.input, limits.candidates, constantsOf(rules));
        let given = domain.values.find(matches);
        if (given === undefined && !domain.exhaustive) {
          const tag = left.position.segments[0]!.slice(1);
          const scope = feasibilityScope(definition, tag);
          const seeds = [...validRows.map(row => row.given), ...domain.values, definition.input.placeholderFor(tag)];
          for (const seed of seeds) {
            if (attempted++ >= limits.candidates) break;
            const placed = right.place(left.place(seed, first), second);
            const kept = definition.input.parse(placed).success ? placed : keepingInvariants(scope, seed, placed, limits.candidates);
            const candidate = kept === undefined ? keepingOrderings(scope, seed, placed) : keepingOrderings(scope, seed, kept);
            if (definition.input.parse(candidate).success && matches(candidate)) { given = candidate; break; }
          }
        }
        const obligation: PairObligation = given !== undefined ? { ...base, status: "gap" }
          : domain.exhaustive ? { ...base, status: "no row owed", reason: "入力の全値を調べ、この組み合わせを持つ値がない" }
          : { ...base, status: "undecided", reason: attempted >= limits.candidates ? `候補探索が上限の${limits.candidates}回に達した` : "組み合わせの証拠を構築できず、実現不能とも証明できない" };
        obligations.push(obligation);
        if (given !== undefined) witnesses.push({ obligation, given });
      }
    }
  }
  return result();

  function result() {
    return { measure: { status: notRead.length > 0 || obligations.some(pair => pair.status === "undecided") ? "partial" as const : "complete" as const, obligations, notRead }, witnesses };
  }
}

function axesOf(positions: readonly Position[], partitions: readonly GuardPartition[]): Axis[] {
  return positions.flatMap((position): Axis[] => {
    if (position.kind === "divided") return [{ position, classes: position.classes.filter(name => !position.excluded.includes(name)), classify: given => position.classify(given), instances: given => position.instancesIn(given).map(instance => ({ segments: instance.segments, classes: instance.classify(given) })), place: (given, name) => position.place(given, name) }];
    const drawn = partitions.find(partition => isDeepStrictEqual(partition.segments, position.segments));
    if (drawn === undefined) return [];
    return [{
      position, classes: drawn.classes.map(item => item.name),
      instances: given => position.instancesIn(given).map(instance => ({ segments: instance.segments, classes: instance.valuesIn(given).flatMap(value => value === undefined ? [] : drawn.classes.filter(item => item.contains(value)).map(item => item.name)) })),
      classify: given => position.valuesIn(given).flatMap(value => value === undefined ? [] : drawn.classes.filter(item => item.contains(value)).map(item => item.name)),
      place: (given, name) => {
        const item = drawn.classes.find(item => item.name === name);
        return item?.witness === undefined ? given : position.write(given, "value", item.witness);
      },
    }];
  });
}

function coexist(left: readonly string[], right: readonly string[]): boolean {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return !(left[index]!.startsWith("@") && right[index]!.startsWith("@"));
  }
  return false;
}
