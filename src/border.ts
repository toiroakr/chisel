import type { Operator, Rule } from "./rule.js";
import { describeRule, isTerm, termData } from "./rule.js";

export type PointRole = "ON" | "OFF" | "IN" | "OUT";
export type PointStatus = "owed" | "excluded" | "not named" | "no point";

export interface BorderPoint {
  readonly role: PointRole;
  readonly relation: string;
  readonly status: PointStatus;
  readonly witness?: unknown;
  readonly region?: { readonly operator: Operator; readonly bound: unknown };
  contains(coordinate: unknown): boolean;
}

export interface Border {
  readonly source: "invariant" | "guard" | "ensures";
  readonly measure: "value" | "length";
  readonly rule: string;
  readonly closed: boolean;
  readonly points: readonly BorderPoint[];
}

export interface Carrier {
  readonly compare: (left: unknown, right: unknown) => number;
  readonly step?: (value: unknown, direction: 1 | -1) => unknown;
  readonly past?: (value: unknown, direction: 1 | -1) => unknown;
  readonly format: (value: unknown) => string;
  readonly floor?: { readonly value: unknown; readonly reason: string };
  readonly ceiling?: { readonly value: unknown; readonly reason: string };
}

export const integerCarrier: Carrier = {
  compare: (left, right) => (left as number) - (right as number),
  step: (value, direction) => (value as number) + direction,
  format: String,
};

export const lengthCarrier: Carrier = {
  ...integerCarrier,
  floor: { value: 0, reason: "a length is never negative" },
};

export const numberCarrier: Carrier = {
  compare: (left, right) => (left as number) - (right as number),
  past: (value, direction) => (value as number) + direction,
  format: String,
};

export const instantCarrier: Carrier = {
  compare: (left, right) => {
    const difference = epochNanoseconds(left) - epochNanoseconds(right);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  },
  step: (value, direction) =>
    (value as { add(duration: object): unknown }).add({ nanoseconds: direction }),
  format: String,
};

interface Plain {
  add(duration: object): unknown;
  readonly constructor: { compare(left: unknown, right: unknown): number };
}

const comparePlain = (left: unknown, right: unknown) => (left as Plain).constructor.compare(left, right);

export const dateCarrier: Carrier = {
  compare: comparePlain,
  step: (value, direction) => (value as Plain).add({ days: direction }),
  format: String,
};

export const dateTimeCarrier: Carrier = {
  compare: comparePlain,
  step: (value, direction) => (value as Plain).add({ nanoseconds: direction }),
  format: String,
};

const withinOneDay = "a time of day lies within one day";

// A plain time wraps past midnight when stepped, so the step stops at either end
// of the day instead, and the ends are named so a point beyond them is "no point".
export const timeCarrier: Carrier = {
  compare: comparePlain,
  step: (value, direction) => {
    const end = direction === 1 ? timeCarrier.ceiling! : timeCarrier.floor!;
    return comparePlain(value, end.value) === 0 ? undefined : (value as Plain).add({ nanoseconds: direction });
  },
  format: String,
  get floor() {
    return { value: plainTime("00:00"), reason: withinOneDay };
  },
  get ceiling() {
    return { value: plainTime("23:59:59.999999999"), reason: withinOneDay };
  },
};

function plainTime(text: string): unknown {
  return (globalThis as unknown as { readonly Temporal: { readonly PlainTime: { from(text: string): unknown } } })
    .Temporal.PlainTime.from(text);
}

function epochNanoseconds(value: unknown): bigint {
  return (value as { readonly epochNanoseconds: bigint }).epochNanoseconds;
}

export const nanosecondCarrier: Carrier = {
  compare: (left, right) => {
    const difference = (left as bigint) - (right as bigint);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  },
  step: (value, direction) => (value as bigint) + BigInt(direction),
  format: String,
};

export const stringCarrier: Carrier = {
  compare: (left, right) =>
    (left as string) < (right as string) ? -1 : (left as string) > (right as string) ? 1 : 0,
  past: (value, direction) =>
    direction === 1
      ? `${value as string}a`
      : (value as string).length > 0
        ? (value as string).slice(0, -1)
        : undefined,
  format: value => JSON.stringify(value),
};

export function bordersOf(
  rules: readonly Rule[],
  carrierFor: (measure: Border["measure"]) => Carrier | undefined,
  drawing: Drawing = invariantDrawing,
): Border[] {
  const drawn = rules.flatMap(rule => {
    const border = borderOf(rule, carrierFor, drawing);
    return border === undefined ? [] : [border];
  });
  return drawn.map(current => {
    const sameMeasure = drawn.filter(
      other => other !== current && other.border.measure === current.border.measure,
    );
    if (current.namesValue === true) {
      return withoutRefusedPoints(current.border, sameMeasure);
    }
    const others = sameMeasure.filter(other => other.namesValue !== true);
    const border = oneValueWide(current, others)
      ? withoutInPoint(current.border)
      : withAdmittedInWitness(current, others);
    return withoutRefusedPoints(border, sameMeasure);
  });
}

function withoutRefusedPoints(border: Border, others: readonly Drawn[]): Border {
  return {
    ...border,
    points: border.points.map(point =>
      point.status === "owed" &&
      point.witness !== undefined &&
      !others.every(other => other.admits(point.witness))
        ? { ...point, status: "excluded" as const }
        : point,
    ),
  };
}

export function emptiedBy(borders: readonly Border[]): readonly Border[] | undefined {
  for (const measure of ["value", "length"] as const) {
    const invariants = borders.filter(
      border => border.source === "invariant" && border.measure === measure,
    );
    if (
      invariants.length > 0 &&
      invariants.every(border => border.points.every(point => point.status !== "owed"))
    ) {
      return invariants;
    }
  }
  return undefined;
}

function withAdmittedInWitness(current: Drawn, others: readonly Drawn[]): Border {
  const inPoint = current.border.points.find(point => point.role === "IN");
  const witness = inPoint?.witness;
  if (witness === undefined || others.every(other => other.admits(witness))) {
    return current.border;
  }
  const facing = others.find(other => other.lower !== current.lower);
  const between =
    typeof current.on === "number" && typeof facing?.on === "number"
      ? (current.on + facing.on) / 2
      : undefined;
  return {
    ...current.border,
    points: current.border.points.map(point =>
      point.role === "IN" ? { ...point, witness: between } : point,
    ),
  };
}

function oneValueWide(current: Drawn, others: readonly Drawn[]): boolean {
  const { carrier, on, lower } = current;
  const next = carrier.step?.(on, lower ? 1 : -1);
  if (next === undefined) {
    return others.some(
      other =>
        other.lower !== lower && other.border.closed && carrier.compare(other.on, on) === 0,
    );
  }
  return !others.every(other => other.admits(next));
}

function withoutInPoint(border: Border): Border {
  return {
    ...border,
    points: border.points.map(point =>
      point.role === "IN" ? { ...point, status: "excluded" as const } : point,
    ),
  };
}

interface Drawn {
  readonly namesValue?: boolean;
  readonly border: Border;
  readonly carrier: Carrier;
  readonly on: unknown;
  readonly lower: boolean;
  admits(value: unknown): boolean;
}

export interface Drawing {
  readonly source: Border["source"];
  readonly describe: (rule: Rule) => string;
  readonly admits: (coordinate: unknown) => boolean;
}

const invariantDrawing: Drawing = {
  source: "invariant",
  describe: rule => describeRule(rule),
  admits: () => true,
};

function borderOf(
  rule: Rule,
  carrierFor: (measure: Border["measure"]) => Carrier | undefined,
  drawing: Drawing,
): Drawn | undefined {
  const normalized = normalize(rule);
  if (normalized === undefined) {
    return undefined;
  }
  const { operator, bound, measure } = normalized;
  const carrier = carrierFor(measure);
  if (carrier === undefined) {
    return undefined;
  }
  if (operator === "==" || operator === "!=") {
    return namedValueBorder(rule, operator, bound, measure, carrier, drawing);
  }
  const lower = operator === ">" || operator === ">=";
  const closed = operator === ">=" || operator === "<=";
  const inward: 1 | -1 = lower ? 1 : -1;
  const outward: 1 | -1 = lower ? -1 : 1;
  const { step } = carrier;
  const on = closed ? bound : step?.(bound, inward);
  const off = closed ? step?.(bound, outward) : bound;
  const guarded = drawing.source !== "invariant";
  const floored = belowFloor(carrier);
  const ceiled = aboveCeiling(carrier);
  const pastEnd = (edge: unknown, direction: 1 | -1) =>
    direction === -1 ? floored.under(edge) : ceiled.over(edge);
  if (on === undefined && !guarded && !pastEnd(bound, inward)) {
    return undefined;
  }
  const inner = on ?? bound;
  const outer = off ?? bound;
  const beyond = (value: unknown) => (lower ? ">" : "<") + " " + carrier.format(value);
  const before = (value: unknown) => (lower ? "<" : ">") + " " + carrier.format(value);
  const inside = (edge: unknown) => (value: unknown) =>
    lower ? carrier.compare(value, edge) > 0 : carrier.compare(value, edge) < 0;
  const outside = (edge: unknown) => (value: unknown) =>
    lower ? carrier.compare(value, edge) < 0 : carrier.compare(value, edge) > 0;
  const at = (edge: unknown) => (value: unknown) => carrier.compare(value, edge) === 0;
  const past = (value: unknown, direction: 1 | -1) =>
    step?.(value, direction) ?? carrier.past?.(value, direction);
  const owedUnlessRefused = (witness: unknown): PointStatus =>
    witness === undefined || !drawing.admits(witness) ? "excluded" : "owed";
  const outsideStatus = (witness: unknown): PointStatus =>
    guarded ? owedUnlessRefused(witness) : "excluded";

  const outWitness = past(outer, outward);
  const points: BorderPoint[] = [
    on === undefined
      ? { role: "ON", relation: "neighbour not named", status: "not named", contains: () => false }
      : {
          role: "ON",
          relation: `= ${carrier.format(on)}`,
          status: owedUnlessRefused(on),
          witness: on,
          region: { operator: "==", bound: on },
          contains: at(on),
        },
    off === undefined
      ? { role: "OFF", relation: "neighbour not named", status: "not named", contains: () => false }
      : {
          role: "OFF",
          relation: `= ${carrier.format(off)}`,
          status: outsideStatus(off),
          witness: off,
          region: { operator: "==", bound: off },
          contains: at(off),
        },
    {
      ...inPoint(beyond(inner), past(inner, inward), inside(inner)),
      region: { operator: lower ? ">" : "<", bound: inner },
    },
    {
      role: "OUT",
      relation: before(outer),
      status: outsideStatus(outWitness),
      witness: outWitness,
      region: { operator: lower ? "<" : ">", bound: outer },
      contains: outside(outer),
    },
  ];
  const reaching: readonly [boolean, boolean, boolean, boolean] = [
    on === undefined ? pastEnd(bound, inward) : floored.at(on),
    off === undefined ? closed && pastEnd(bound, outward) : floored.at(off),
    lower ? ceiled.over(inner) : floored.under(inner),
    lower ? floored.under(outer) : ceiled.over(outer),
  ];
  return {
    border: {
      source: drawing.source,
      measure,
      rule: `${drawing.source} ${drawing.describe(rule)}`,
      closed,
      points: points.map((point, index) =>
        reaching[index] === true ? noPointBelow(point.role, carrier) : point,
      ),
    },
    carrier,
    on: inner,
    lower,
    admits: value => at(inner)(value) || inside(inner)(value),
  };
}

function namedValueBorder(
  rule: Rule,
  operator: "==" | "!=",
  bound: unknown,
  measure: Border["measure"],
  carrier: Carrier,
  drawing: Drawing,
): Drawn {
  const keeps = operator === "==";
  const guarded = drawing.source !== "invariant";
  const at = (edge: unknown) => (value: unknown) => carrier.compare(value, edge) === 0;
  const below = carrier.step?.(bound, -1);
  const above = carrier.step?.(bound, 1);
  const beyond = (edge: unknown, direction: 1 | -1) =>
    carrier.step?.(edge, direction) ?? carrier.past?.(edge, direction);
  const statusFor = (witness: unknown, inside: boolean): PointStatus =>
    witness === undefined || !drawing.admits(witness)
      ? "excluded"
      : inside || guarded
        ? "owed"
        : "excluded";
  const neighbour = (role: PointRole, edge: unknown, inside: boolean): BorderPoint =>
    edge === undefined
      ? { role, relation: "neighbour not named", status: "not named", contains: () => false }
      : {
          role,
          relation: `= ${carrier.format(edge)}`,
          status: statusFor(edge, inside),
          witness: edge,
          region: { operator: "==", bound: edge },
          contains: at(edge),
        };
  const run = (role: PointRole, direction: 1 | -1, inside: boolean): BorderPoint => {
    const edge = (direction === 1 ? above : below) ?? bound;
    const witness = beyond(edge, direction);
    return {
      role,
      relation: `${direction === 1 ? ">" : "<"} ${carrier.format(edge)}`,
      status: statusFor(witness, inside),
      witness,
      region: { operator: direction === 1 ? ">" : "<", bound: edge },
      contains: value => carrier.compare(value, edge) * direction > 0,
    };
  };
  const floored = belowFloor(carrier);
  const ceiled = aboveCeiling(carrier);
  const neighbourOrNone = (role: PointRole, edge: unknown, direction: 0 | 1 | -1, inside: boolean): BorderPoint =>
    (edge !== undefined && floored.at(edge)) ||
    (edge === undefined && direction !== 0 && (direction === -1 ? floored.under(bound) : ceiled.over(bound)))
      ? noPointBelow(role, carrier)
      : neighbour(role, edge, inside);
  const runOrNone = (role: PointRole, direction: 1 | -1, inside: boolean): BorderPoint =>
    direction === -1 ? (floored.under(below ?? bound) ? noPointBelow(role, carrier) : run(role, direction, inside))
      : ceiled.over(above ?? bound) ? noPointBelow(role, carrier) : run(role, direction, inside);
  const points: BorderPoint[] = keeps
    ? [
        neighbourOrNone("ON", bound, 0, true),
        neighbourOrNone("OFF", below, -1, false),
        neighbourOrNone("OFF", above, 1, false),
        {
          role: "IN",
          relation: "none: the rule keeps a single value",
          status: "no point",
          contains: () => false,
        },
        runOrNone("OUT", -1, false),
        runOrNone("OUT", 1, false),
      ]
    : [
        neighbourOrNone("ON", below, -1, true),
        neighbourOrNone("ON", above, 1, true),
        neighbourOrNone("OFF", bound, 0, false),
        runOrNone("IN", -1, true),
        runOrNone("IN", 1, true),
        {
          role: "OUT",
          relation: "none: the rule leaves out a single value",
          status: "no point",
          contains: () => false,
        },
      ];
  return {
    border: {
      source: drawing.source,
      measure,
      rule: `${drawing.source} ${drawing.describe(rule)}`,
      closed: keeps,
      points,
    },
    carrier,
    on: bound,
    lower: true,
    namesValue: true,
    admits: value => at(bound)(value) === keeps,
  };
}

function belowFloor(carrier: Carrier): {
  readonly at: (value: unknown) => boolean;
  readonly under: (edge: unknown) => boolean;
} {
  const { floor } = carrier;
  if (floor === undefined) {
    return { at: () => false, under: () => false };
  }
  return {
    at: value => carrier.compare(value, floor.value) < 0,
    under: edge => carrier.compare(edge, floor.value) <= 0,
  };
}

function aboveCeiling(carrier: Carrier): { readonly over: (edge: unknown) => boolean } {
  const { ceiling } = carrier;
  return ceiling === undefined
    ? { over: () => false }
    : { over: edge => carrier.compare(edge, ceiling.value) >= 0 };
}

function noPointBelow(role: PointRole, carrier: Carrier): BorderPoint {
  return {
    role,
    relation: `none: ${carrier.floor?.reason ?? carrier.ceiling?.reason ?? "no value lies there"}`,
    status: "no point",
    contains: () => false,
  };
}

function inPoint(
  relation: string,
  witness: unknown,
  contains: (value: unknown) => boolean,
): BorderPoint {
  return witness === undefined
    ? { role: "IN", relation, status: "excluded", contains }
    : { role: "IN", relation, status: "owed", witness, contains };
}

const mirrored: Readonly<Record<Operator, Operator>> = {
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
  "==": "==",
  "!=": "!=",
};

export function normalize(
  rule: Rule,
): { operator: Operator; bound: unknown; measure: Border["measure"] } | undefined {
  if (rule.kind !== "compare") {
    return undefined;
  }
  if (isTerm(rule.left) && !isTerm(rule.right)) {
    return { operator: rule.operator, bound: rule.right, measure: termData(rule.left).measure };
  }
  if (isTerm(rule.right) && !isTerm(rule.left)) {
    return {
      operator: mirrored[rule.operator],
      bound: rule.left,
      measure: termData(rule.right).measure,
    };
  }
  return undefined;
}
