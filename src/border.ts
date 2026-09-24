import type { Operator, Rule } from "./rule.js";
import { describeRule, isTerm, termData } from "./rule.js";

export type PointRole = "ON" | "OFF" | "IN" | "OUT";
export type PointStatus = "owed" | "excluded" | "not named";

export interface BorderPoint {
  readonly role: PointRole;
  readonly relation: string;
  readonly status: PointStatus;
  contains(coordinate: unknown): boolean;
}

export interface Border {
  readonly source: "invariant";
  readonly measure: "value" | "length";
  readonly rule: string;
  readonly closed: boolean;
  readonly points: readonly BorderPoint[];
}

export interface Carrier {
  readonly compare: (left: unknown, right: unknown) => number;
  readonly step?: (value: unknown, direction: 1 | -1) => unknown;
  readonly format: (value: unknown) => string;
}

export const integerCarrier: Carrier = {
  compare: (left, right) => (left as number) - (right as number),
  step: (value, direction) => (value as number) + direction,
  format: String,
};

export const numberCarrier: Carrier = {
  compare: (left, right) => (left as number) - (right as number),
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

function epochNanoseconds(value: unknown): bigint {
  return (value as { readonly epochNanoseconds: bigint }).epochNanoseconds;
}

export const stringCarrier: Carrier = {
  compare: (left, right) =>
    (left as string) < (right as string) ? -1 : (left as string) > (right as string) ? 1 : 0,
  format: value => JSON.stringify(value),
};

export function bordersOf(
  rules: readonly Rule[],
  carrierFor: (measure: Border["measure"]) => Carrier | undefined,
): Border[] {
  const drawn = rules.flatMap(rule => {
    const border = borderOf(rule, carrierFor);
    return border === undefined ? [] : [border];
  });
  return drawn.map(current => {
    const others = drawn.filter(
      other => other !== current && other.border.measure === current.border.measure,
    );
    return oneValueWide(current, others) ? withoutInPoint(current.border) : current.border;
  });
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
  readonly border: Border;
  readonly carrier: Carrier;
  readonly on: unknown;
  readonly lower: boolean;
  admits(value: unknown): boolean;
}

function borderOf(
  rule: Rule,
  carrierFor: (measure: Border["measure"]) => Carrier | undefined,
): Drawn | undefined {
  const normalized = normalize(rule);
  if (normalized === undefined) {
    return undefined;
  }
  const { operator, bound, measure } = normalized;
  const carrier = carrierFor(measure);
  if (carrier === undefined || operator === "==" || operator === "!=") {
    return undefined;
  }
  const lower = operator === ">" || operator === ">=";
  const closed = operator === ">=" || operator === "<=";
  const inward: 1 | -1 = lower ? 1 : -1;
  const { step } = carrier;
  if (!closed && step === undefined) {
    return undefined;
  }
  const on = closed ? bound : step!(bound, inward);
  const off = closed ? (step === undefined ? undefined : step(bound, -inward as 1 | -1)) : bound;
  const beyond = (value: unknown) => (lower ? ">" : "<") + " " + carrier.format(value);
  const before = (value: unknown) => (lower ? "<" : ">") + " " + carrier.format(value);
  const inside = (edge: unknown) => (value: unknown) =>
    lower ? carrier.compare(value, edge) > 0 : carrier.compare(value, edge) < 0;
  const outside = (edge: unknown) => (value: unknown) =>
    lower ? carrier.compare(value, edge) < 0 : carrier.compare(value, edge) > 0;
  const at = (edge: unknown) => (value: unknown) => carrier.compare(value, edge) === 0;

  const points: BorderPoint[] = [
    { role: "ON", relation: `= ${carrier.format(on)}`, status: "owed", contains: at(on) },
    off === undefined
      ? { role: "OFF", relation: "neighbour not named", status: "not named", contains: () => false }
      : { role: "OFF", relation: `= ${carrier.format(off)}`, status: "excluded", contains: at(off) },
    { role: "IN", relation: beyond(on), status: "owed", contains: inside(on) },
    {
      role: "OUT",
      relation: before(off ?? bound),
      status: "excluded",
      contains: outside(off ?? bound),
    },
  ];
  return {
    border: {
      source: "invariant",
      measure,
      rule: `invariant ${describeRule(rule)}`,
      closed,
      points,
    },
    carrier,
    on,
    lower,
    admits: value => at(on)(value) || inside(on)(value),
  };
}

const mirrored: Readonly<Record<Operator, Operator>> = {
  "<": ">",
  "<=": ">=",
  ">": "<",
  ">=": "<=",
  "==": "==",
  "!=": "!=",
};

function normalize(
  rule: Rule,
): { operator: Operator; bound: unknown; measure: Border["measure"] } | undefined {
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
