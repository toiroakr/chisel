import type { Operator, Rule } from "./rule.js";
import { describeRule, isTerm, termData } from "./rule.js";

export type PointRole = "ON" | "OFF" | "IN" | "OUT";
export type PointStatus = "owed" | "excluded" | "not named" | "no point";

export interface BorderPoint {
  readonly role: PointRole;
  readonly relation: string;
  readonly status: PointStatus;
  readonly witness?: unknown;
  contains(coordinate: unknown): boolean;
}

export interface Border {
  readonly source: "invariant" | "guard";
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
}

export const integerCarrier: Carrier = {
  compare: (left, right) => (left as number) - (right as number),
  step: (value, direction) => (value as number) + direction,
  format: String,
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

function epochNanoseconds(value: unknown): bigint {
  return (value as { readonly epochNanoseconds: bigint }).epochNanoseconds;
}

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
    if (current.namesValue === true) {
      return current.border;
    }
    const others = drawn.filter(
      other =>
        other !== current &&
        other.namesValue !== true &&
        other.border.measure === current.border.measure,
    );
    return oneValueWide(current, others)
      ? withoutInPoint(current.border)
      : withAdmittedInWitness(current, others);
  });
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
  const guarded = drawing.source === "guard";
  if (on === undefined && !guarded) {
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
          contains: at(on),
        },
    off === undefined
      ? { role: "OFF", relation: "neighbour not named", status: "not named", contains: () => false }
      : {
          role: "OFF",
          relation: `= ${carrier.format(off)}`,
          status: outsideStatus(off),
          witness: off,
          contains: at(off),
        },
    inPoint(beyond(inner), past(inner, inward), inside(inner)),
    {
      role: "OUT",
      relation: before(outer),
      status: outsideStatus(outWitness),
      witness: outWitness,
      contains: outside(outer),
    },
  ];
  return {
    border: {
      source: drawing.source,
      measure,
      rule: `${drawing.source} ${drawing.describe(rule)}`,
      closed,
      points,
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
  const guarded = drawing.source === "guard";
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
      contains: value => carrier.compare(value, edge) * direction > 0,
    };
  };
  const points: BorderPoint[] = keeps
    ? [
        neighbour("ON", bound, true),
        neighbour("OFF", below, false),
        neighbour("OFF", above, false),
        {
          role: "IN",
          relation: "none: the rule keeps a single value",
          status: "no point",
          contains: () => false,
        },
        run("OUT", -1, false),
        run("OUT", 1, false),
      ]
    : [
        neighbour("ON", below, true),
        neighbour("ON", above, true),
        neighbour("OFF", bound, false),
        run("IN", -1, true),
        run("IN", 1, true),
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
