// Arithmetic on calendar dates, times of day, wall-clock date-times and exact
// instants, as Temporal does it: `plus` and `minus` move a value by a whole
// number of one unit, and `between` counts the whole units from one value to
// another. The units a type takes are the ones Temporal keeps exact for it: a
// date moves by calendar units, a time of day and an instant by clock units,
// and a date-time by both.
import type { Temporal as TemporalTypes } from "temporal-spec";
import { Rational } from "./exact.js";

export type CalendarUnit = "years" | "months" | "weeks" | "days";
export type ClockUnit = "hours" | "minutes" | "seconds" | "milliseconds";
export type TemporalUnit = CalendarUnit | ClockUnit;
export type TemporalKind = "date" | "time" | "datetime" | "instant";
// What a month added to the 31st does: "constrain" moves to the month's last
// day (Temporal's default), "reject" refuses the value.
export type Overflow = "constrain" | "reject";

const UNITS: Readonly<Record<TemporalKind, readonly TemporalUnit[]>> = {
  date: ["years", "months", "weeks", "days"],
  time: ["hours", "minutes", "seconds", "milliseconds"],
  datetime: ["years", "months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"],
  instant: ["hours", "minutes", "seconds", "milliseconds"],
};
const TAGS: Readonly<Record<string, TemporalKind>> = {
  "Temporal.PlainDate": "date",
  "Temporal.PlainTime": "time",
  "Temporal.PlainDateTime": "datetime",
  "Temporal.Instant": "instant",
};

type Value = TemporalTypes.PlainDate | TemporalTypes.PlainTime | TemporalTypes.PlainDateTime | TemporalTypes.Instant;

export function temporalKindOf(value: unknown): TemporalKind | undefined {
  return typeof value === "object" && value !== null ? TAGS[Object.prototype.toString.call(value).slice(8, -1)] : undefined;
}

function checkedUnit(kind: TemporalKind, unit: string, operation: string): TemporalUnit {
  if (!(UNITS[kind] as readonly string[]).includes(unit)) {
    throw new Error(`${operation} cannot count a ${kind === "datetime" ? "date-time" : kind} in ${unit}; it takes ${UNITS[kind].join(", ")}`);
  }
  return unit as TemporalUnit;
}

export function moveTemporal(operator: "plus" | "minus", value: unknown, amount: unknown, unit: string, overflow: Overflow): unknown {
  const kind = temporalKindOf(value);
  if (!kind) throw new Error(`${operator} expects a date, time, date-time or instant`);
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) throw new Error(`${operator} expects a whole number of ${unit}`);
  const duration = { [checkedUnit(kind, unit, operator)]: operator === "plus" ? amount : -amount };
  return kind === "date" || kind === "datetime"
    ? (value as TemporalTypes.PlainDate).add(duration, { overflow })
    : (value as TemporalTypes.PlainTime).add(duration);
}

export function countBetween(start: unknown, end: unknown, unit: string): number {
  const kind = temporalKindOf(start);
  if (!kind || temporalKindOf(end) !== kind) throw new Error("between expects two values of one temporal type");
  const checked = checkedUnit(kind, unit, "between");
  const duration = (start as TemporalTypes.PlainDate).until(end as never, { largestUnit: checked as never, smallestUnit: checked as never, roundingMode: "trunc" });
  return (duration as unknown as Record<TemporalUnit, number>)[checked];
}

// ── The timeline the proofs measure on ──
// A date, date-time or instant is placed on one line of nanoseconds since
// 1970-01-01, a date and a date-time read in UTC, so a move by a unit of fixed
// length is an addition. Months and years have no fixed length, and a time of
// day wraps at midnight, so neither is placed.
const NANOSECONDS: Readonly<Partial<Record<TemporalUnit, bigint>>> = {
  milliseconds: 1_000_000n,
  seconds: 1_000_000_000n,
  minutes: 60_000_000_000n,
  hours: 3_600_000_000_000n,
  days: 86_400_000_000_000n,
  weeks: 604_800_000_000_000n,
};
export const fixedLength = (unit: string): Rational | undefined => {
  const length = NANOSECONDS[unit as TemporalUnit];
  return length === undefined ? undefined : new Rational(length);
};
export const onTimeline = (kind: string): kind is "date" | "datetime" | "instant" =>
  kind === "date" || kind === "datetime" || kind === "instant";
export function timelineOf(value: unknown): Rational | undefined {
  const kind = temporalKindOf(value);
  if (kind === "instant") return new Rational((value as TemporalTypes.Instant).epochNanoseconds);
  if (kind === "datetime") return new Rational((value as TemporalTypes.PlainDateTime).toZonedDateTime("UTC").epochNanoseconds);
  if (kind === "date") return new Rational((value as TemporalTypes.PlainDate).toZonedDateTime({ timeZone: "UTC" }).epochNanoseconds);
  return undefined;
}
export type { Value as TemporalValue };
