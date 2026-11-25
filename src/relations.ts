// What the relations of a way say together of the places they read (ADR-0129,
// ADR-0130): a string's prefixes, suffixes and pieces, a record's keys and an
// array's elements, each against a value the source writes. A contradiction
// among them is shown by the laws of the relations, a way they leave values
// for by a value the place's own schema takes, and anything else is said to be
// neither. Strings are read as having no greatest length: the only length a
// witness is held to is one the place's schema declares.
import { deepEqual } from "./equal.js";
import type { Relation, RelationRule, Term } from "./rule.js";
import { holds, isTerm, positionData, relationHolds } from "./rule.js";
import type { Rule } from "./rule.js";
import type { AnySchema } from "./schema.js";
import { schemaAtPath } from "./schema.js";
import { inheritedAt } from "./guard-scope.js";
import { integralBounds } from "./domain.js";

// The value a candidate parses to, where the place's schema takes it and every
// invariant an enclosing object writes on the place holds of it: what a row
// would hold, NFC and all, rather than what was written.
function taken(candidate: unknown, schema: AnySchema | undefined, inherited: readonly Rule[]): { readonly value: unknown } | undefined {
  const parsed = schema === undefined ? { success: true as const, value: candidate } : schema.parse(candidate);
  if (!parsed.success) return undefined;
  return inherited.every(rule => holds(rule, parsed.value)) ? { value: parsed.value } : undefined;
}

// Past this many relations on one place their combinations are not drawn.
export const RELATION_LIMIT = 12;

export interface RelationStep {
  readonly rule: RelationRule;
  readonly outcome: boolean;
}

export type RelationVerdict =
  | { readonly kind: "infeasible" }
  | { readonly kind: "feasible"; readonly paths: readonly (readonly string[])[] }
  // `searched`: written values no law refutes and no witness the schema takes
  // was found for, which is no proof there is none.
  | { readonly kind: "unknown"; readonly paths: readonly (readonly string[])[]; readonly searched?: true };

// The place a relation is a statement about, where it is a plain value of a
// position and the other side is written: otherwise undefined.
export function placeOf(rule: RelationRule): readonly string[] | undefined {
  if (isTerm(rule.other)) return undefined;
  const position = positionData(rule.subject as Term<unknown>);
  return position !== undefined && position.measure === "value" && !position.path.some(key => key.startsWith("#")) ? position.path : undefined;
}

export function relationsVerdict(steps: readonly RelationStep[], scope: AnySchema): readonly RelationVerdict[] {
  const byPlace = new Map<string, { path: readonly string[]; steps: RelationStep[] }>();
  const verdicts: RelationVerdict[] = [];
  for (const step of steps) {
    const path = placeOf(step.rule);
    if (path === undefined) {
      const paths = [step.rule.subject, step.rule.other].filter(isTerm).flatMap(term => {
        const position = positionData(term as Term<unknown>);
        return position === undefined ? [] : [position.path];
      });
      verdicts.push({ kind: "unknown", paths });
      continue;
    }
    const key = JSON.stringify(path);
    const group = byPlace.get(key) ?? { path, steps: [] };
    group.steps.push(step);
    byPlace.set(key, group);
  }
  for (const { path, steps: group } of byPlace.values()) {
    const schema = schemaAtPath(scope, path);
    const kinds = new Set(group.map(step => step.rule.relation === "hasKey" ? "record" : step.rule.relation === "includes" ? "array" : "string"));
    if (kinds.size > 1) { verdicts.push({ kind: "unknown", paths: [path] }); continue; }
    const kind = [...kinds][0]!;
    if (refuted(kind, group)) { verdicts.push({ kind: "infeasible" }); continue; }
    const holdsAll = (value: unknown) => group.every(step => relationHolds(step.rule.relation, value, step.rule.other) === step.outcome);
    const inherited = inheritedAt(scope, path);
    const witness = witnessesOf(kind, group, schema).map(candidate => taken(candidate, schema, inherited)).find(found => found !== undefined && holdsAll(found.value));
    verdicts.push(witness === undefined ? { kind: "unknown", paths: [path], searched: true } : { kind: "feasible", paths: [path] });
  }
  return verdicts;
}

function written(group: readonly RelationStep[], relation: Relation, outcome: boolean): readonly unknown[] {
  return group.filter(step => step.rule.relation === relation && step.outcome === outcome).map(step => step.rule.other);
}

// Shown by the laws of the relations alone, never by a search coming up empty.
function refuted(kind: string, group: readonly RelationStep[]): boolean {
  if (kind === "record") {
    const held = written(group, "hasKey", true), lacked = written(group, "hasKey", false);
    return held.some(key => lacked.includes(key));
  }
  if (kind === "array") {
    const held = written(group, "includes", true), lacked = written(group, "includes", false);
    return held.some(value => lacked.some(other => deepEqual(value, other)));
  }
  const strings = (relation: Relation, outcome: boolean) => written(group, relation, outcome).filter((value): value is string => typeof value === "string");
  const prefixes = strings("startsWith", true), suffixes = strings("endsWith", true), pieces = strings("contains", true);
  const notPrefixes = strings("startsWith", false), notSuffixes = strings("endsWith", false), notPieces = strings("contains", false);
  // Every string starts with, ends with and holds the empty string.
  if ([...notPrefixes, ...notSuffixes, ...notPieces].includes("")) return true;
  // Two prefixes of one string are one a prefix of the other, as two suffixes are.
  const longest = (values: readonly string[], within: (a: string, b: string) => boolean) => {
    let best = "";
    for (const value of values) {
      if (within(best, value)) best = value;
      else if (!within(value, best)) return undefined;
    }
    return best;
  };
  const prefix = longest(prefixes, (a, b) => b.startsWith(a));
  const suffix = longest(suffixes, (a, b) => b.endsWith(a));
  if (prefix === undefined || suffix === undefined) return true;
  if (notPrefixes.some(value => prefix.startsWith(value))) return true;
  if (notSuffixes.some(value => suffix.endsWith(value))) return true;
  // A piece of a prefix, a suffix or a held piece is held.
  return notPieces.some(value => [prefix, suffix, ...pieces].some(text => text.includes(value)));
}

function witnessesOf(kind: string, group: readonly RelationStep[], schema: AnySchema | undefined): readonly unknown[] {
  // The lengths the place's schema declares, which a witness is padded to.
  const { lower, upper } = schema === undefined ? { lower: 0, upper: undefined } : integralBounds(schema, "length");
  const lengths = [lower, lower + 1, ...(upper === undefined ? [] : [upper, upper - 1])].filter(size => size >= 0 && size <= 4096);
  if (kind === "record") {
    const held = written(group, "hasKey", true).filter((key): key is string => typeof key === "string");
    const lacked = new Set(written(group, "hasKey", false));
    const value = (schema as { readonly value?: AnySchema } | undefined)?.value?.placeholder();
    const base = Object.fromEntries(held.map(key => [key, value]));
    const padded = lengths.map(size => {
      const entries: Record<string, unknown> = { ...base };
      for (let index = 1; Object.keys(entries).length < size; index++) if (!lacked.has(`_${index}`)) entries[`_${index}`] = value;
      return entries;
    });
    return [base, ...padded];
  }
  if (kind === "array") {
    const held = written(group, "includes", true);
    const element = (schema as { readonly element?: AnySchema } | undefined)?.element?.placeholder();
    const padded = lengths.map(size => [...held, ...Array.from({ length: Math.max(0, size - held.length) }, () => element)]);
    return [held, [...held, ...held], ...padded];
  }
  const strings = (relation: Relation) => written(group, relation, true).filter((value): value is string => typeof value === "string");
  const prefix = strings("startsWith").reduce((a, b) => (b.length > a.length ? b : a), "");
  const suffix = strings("endsWith").reduce((a, b) => (b.length > a.length ? b : a), "");
  const pieces = strings("contains");
  const joined = (left: string, right: string) => {
    for (let overlap = Math.min(left.length, right.length); overlap > 0; overlap--) {
      if (left.endsWith(right.slice(0, overlap))) return left + right.slice(overlap);
    }
    return left + right;
  };
  const middles = ["", pieces.join(""), ...pieces.map(piece => `${piece}_`), "_", "__", "x"];
  const witnesses: string[] = [];
  for (const middle of middles) {
    witnesses.push(prefix + middle + suffix, joined(joined(prefix, middle), suffix));
  }
  // Then at the lengths the place's schema declares, filled in after the prefix.
  const core = prefix + pieces.join("") + suffix;
  for (const filler of ["_", "a", "0"]) {
    for (let size = 1; size <= 8; size++) witnesses.push(prefix + filler.repeat(size) + pieces.join("") + suffix);
    for (const size of lengths) if (size > core.length) witnesses.push(prefix + filler.repeat(size - core.length) + pieces.join("") + suffix);
  }
  return witnesses;
}

export interface RelationClass {
  readonly name: string;
  // A value of the class the place's schema takes, or undefined where none
  // was found though no law refutes the class: it is still owed (ADR-0130).
  readonly witness: unknown;
  contains(value: unknown): boolean;
}

const symbols: Readonly<Record<Relation, string>> = {
  startsWith: "startsWith",
  endsWith: "endsWith",
  contains: "contains",
  hasKey: "hasKey",
  includes: "includes",
};

function show(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `${item}n` : item)) ?? String(value);
}

// The classes the relations written against one place divide it into: each
// way the relations can come out together, within each class `base` already
// divides it into. A combination the laws refute is excluded; past four
// relations each is a class of its own, holding and failing.
export function relationClasses(
  rules: readonly RelationRule[],
  schema: AnySchema,
  base: readonly RelationClass[] = [],
  inherited: readonly Rule[] = [],
): { readonly classes: readonly RelationClass[]; readonly excluded: readonly string[] } {
  const distinct = rules.filter((rule, index) => rules.findIndex(other => other.relation === rule.relation && deepEqual(other.other, rule.other)) === index);
  const kind = distinct.every(rule => rule.relation === "hasKey") ? "record" : distinct.every(rule => rule.relation === "includes") ? "array" : "string";
  const label = (rule: RelationRule, outcome: boolean) => `${outcome ? "" : "¬"}${symbols[rule.relation]}(${show(rule.other)})`;
  const combos: { readonly rule: RelationRule; readonly outcome: boolean }[][] = [];
  // Every way they come out together, up to RELATION_LIMIT relations; past it
  // each holds and fails apart, and the place is said to be read no further
  // (comparisonsNotReadOf), since those classes are not a partition.
  if (distinct.length <= RELATION_LIMIT) {
    for (let mask = 0; mask < 1 << distinct.length; mask++) combos.push(distinct.map((rule, index) => ({ rule, outcome: (mask & (1 << index)) === 0 })));
  } else {
    for (const rule of distinct) combos.push([{ rule, outcome: true }], [{ rule, outcome: false }]);
  }
  const universal: RelationClass = { name: "", witness: undefined, contains: () => true };
  const classes: RelationClass[] = [];
  const excluded: string[] = [];
  for (const outer of base.length === 0 ? [universal] : base) {
    for (const combo of combos) {
      const name = [outer.name, combo.map(item => label(item.rule, item.outcome)).join(" ∧ ")].filter(part => part !== "").join(" ∧ ");
      const steps = combo.map(item => ({ rule: item.rule, outcome: item.outcome }));
      if (refuted(kind, steps)) { excluded.push(name); continue; }
      const contains = (value: unknown) => outer.contains(value) && combo.every(item => relationHolds(item.rule.relation, value, item.rule.other) === item.outcome);
      const candidates = [...(outer.witness === undefined ? [] : [outer.witness]), ...witnessesOf(kind, steps, schema)];
      const witness = candidates.map(candidate => taken(candidate, schema, inherited)).find(found => found !== undefined && contains(found.value))?.value;
      classes.push({ name, witness, contains });
    }
  }
  return { classes, excluded };
}
