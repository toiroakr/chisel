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
const TYPES = [["PlainDate", "date"], ["PlainTime", "time"], ["PlainDateTime", "datetime"], ["Instant", "instant"]] as const;
const temporalGlobal = () => (globalThis as unknown as { Temporal?: typeof TemporalTypes }).Temporal;

type Value = TemporalTypes.PlainDate | TemporalTypes.PlainTime | TemporalTypes.PlainDateTime | TemporalTypes.Instant;

// A value of one of Temporal's own types, as the schemas take it: an object that
// only calls itself one through Symbol.toStringTag is none.
export function temporalKindOf(value: unknown): TemporalKind | undefined {
  const temporal = temporalGlobal();
  if (!temporal || typeof value !== "object" || value === null) return undefined;
  return TYPES.find(([type]) => value instanceof temporal[type])?.[1];
}

export const takesUnit = (kind: TemporalKind, unit: string): boolean => (UNITS[kind] as readonly string[]).includes(unit);

function checkedUnit(kind: TemporalKind, unit: string, operation: string): TemporalUnit {
  if (!takesUnit(kind, unit)) {
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
  // A unit of fixed length counts alike in every calendar, so two dates or
  // date-times are read in the ISO calendar for it: Temporal refuses to count
  // between two calendars, which no schema rules out. Months and years differ
  // between calendars and are counted as Temporal counts them.
  if ((kind === "date" || kind === "datetime") && fixedLength(checked) !== undefined) {
    start = (start as TemporalTypes.PlainDate).withCalendar("iso8601");
    end = (end as TemporalTypes.PlainDate).withCalendar("iso8601");
  }
  const duration = (start as TemporalTypes.PlainDate).until(end as never, { largestUnit: checked as never, smallestUnit: checked as never, roundingMode: "trunc" });
  return (duration as unknown as Record<TemporalUnit, number>)[checked];
}

// ── The timeline the proofs measure on ──
// A date, date-time or instant is placed on one line of nanoseconds since
// 1970-01-01, a date and a date-time read as if in UTC, so a move by a unit of
// fixed length is an addition. Months and years have no fixed length, and a time
// of day wraps at midnight, so neither is placed.
const DAY = 86_400_000_000_000n;
const NANOSECONDS: Readonly<Partial<Record<TemporalUnit, bigint>>> = {
  milliseconds: 1_000_000n,
  seconds: 1_000_000_000n,
  minutes: 60_000_000_000n,
  hours: 3_600_000_000_000n,
  days: DAY,
  weeks: 7n * DAY,
};
export const fixedLength = (unit: string): Rational | undefined => {
  // Own units only: a unit an untyped caller names like "constructor" is no unit.
  const length = Object.hasOwn(NANOSECONDS, unit) ? NANOSECONDS[unit as TemporalUnit] : undefined;
  return length === undefined ? undefined : new Rational(length);
};
export const onTimeline = (kind: string): kind is "date" | "datetime" | "instant" =>
  kind === "date" || kind === "datetime" || kind === "instant";
// Where Temporal holds each type on that line: an instant within 10^8 days of
// 1970-01-01, a date from the day before the earliest instant to the day of the
// latest, and a date-time strictly within a day of the instants.
const INSTANT_LIMIT = 100_000_000n * DAY;
export const TIMELINE_RANGE: Readonly<Record<"date" | "datetime" | "instant", { readonly low: Rational; readonly high: Rational }>> = {
  instant: { low: new Rational(-INSTANT_LIMIT), high: new Rational(INSTANT_LIMIT) },
  date: { low: new Rational(-INSTANT_LIMIT - DAY), high: new Rational(INSTANT_LIMIT) },
  datetime: { low: new Rational(-INSTANT_LIMIT - DAY + 1n), high: new Rational(INSTANT_LIMIT + DAY - 1n) },
};
// Temporal refuses a duration of 2^53 seconds or more, whatever it is added to.
export const DURATION_LIMIT = new Rational(2n ** 53n * 1_000_000_000n);
export function timelineOf(value: unknown): Rational | undefined {
  const kind = temporalKindOf(value), temporal = temporalGlobal()!;
  // Read from a copy of what the value holds, as compare reads it, rather than
  // through methods a subclass may override.
  try {
    if (kind === "instant") return new Rational(temporal.Instant.from(value as TemporalTypes.Instant).epochNanoseconds);
    // A date or a date-time is counted from its own fields, not through an
    // instant in UTC, which Temporal refuses for the ones beyond the instants.
    if (kind === "datetime") {
      const at = temporal.PlainDateTime.from(value as TemporalTypes.PlainDateTime);
      return new Rational(epochDays(at.toPlainDate()) * DAY + nanosecondOfDay(at.toPlainTime()));
    }
    if (kind === "date") return new Rational(epochDays(temporal.PlainDate.from(value as TemporalTypes.PlainDate)) * DAY);
  } catch {
    // An object of the type's prototype that holds no value is placed nowhere.
  }
  return undefined;
}
function epochDays(date: TemporalTypes.PlainDate): bigint {
  const iso = date.withCalendar("iso8601");
  return BigInt(iso.with({ year: 1970, month: 1, day: 1 }).until(iso, { largestUnit: "days" }).days);
}
function nanosecondOfDay(time: TemporalTypes.PlainTime): bigint {
  return ((((BigInt(time.hour) * 60n + BigInt(time.minute)) * 60n + BigInt(time.second)) * 1000n + BigInt(time.millisecond)) * 1000n + BigInt(time.microsecond)) * 1000n + BigInt(time.nanosecond);
}
export type { Value as TemporalValue };
