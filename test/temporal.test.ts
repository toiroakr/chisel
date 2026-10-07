import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import type { AnySchema } from "../src/schema.js";
import { timelineOf } from "../src/temporal.js";

const date = (text: string) => Temporal.PlainDate.from(text);
const time = (text: string) => Temporal.PlainTime.from(text);
const datetime = (text: string) => Temporal.PlainDateTime.from(text);
const instant = (text: string) => Temporal.Instant.from(text);

// A behavior answering one value the model builds from its input.
function answering<I extends AnySchema, R extends AnySchema>(input: I, result: R, build: (input: any) => unknown) {
  const behavior = c.behavior("answer", {
    input: c.variants("kind", { given: input as never }),
    result: c.variants("outcome", { ok: c.object({ value: result as never }) }),
    effects: c.variants("type", {}),
  });
  const implementation = c.implement(behavior, {
    cases: { given: c.model("answer", given => ({ result: { outcome: "ok" as const, value: build(given) as never }, effects: [] })) },
  } as never);
  const run = async (given: Record<string, unknown>) =>
    ((await c.perform(implementation as never, { kind: "given", ...given } as never)).result as { value: unknown }).value;
  return { implementation, run };
}

describe("plus and minus", () => {
  it("move a date by calendar units", async () => {
    const { run } = answering(c.object({ at: c.date(), by: c.int() }), c.date(), r => c.plus(r.at, r.by, "days"));
    expect(String(await run({ at: date("2026-01-31"), by: 14 }))).toBe("2026-02-14");
    expect(String(await run({ at: date("2026-03-01"), by: -1 }))).toBe("2026-02-28");
    const weeks = answering(c.object({ at: c.date() }), c.date(), r => c.minus(r.at, 2, "weeks"));
    expect(String(await weeks.run({ at: date("2026-01-14") }))).toBe("2025-12-31");
  });

  it("move a month past its last day to the month's last day, or refuse it", async () => {
    const constrain = answering(c.object({ at: c.date() }), c.date(), r => c.plus(r.at, 1, "months"));
    expect(String(await constrain.run({ at: date("2026-01-31") }))).toBe("2026-02-28");
    const reject = answering(c.object({ at: c.date() }), c.date(), r => c.plus(r.at, 1, "months", { overflow: "reject" }));
    await expect(reject.run({ at: date("2026-01-31") })).rejects.toThrow();
    expect(String(await reject.run({ at: date("2026-01-28") }))).toBe("2026-02-28");
  });

  it("wrap a time of day at midnight", async () => {
    const { run } = answering(c.object({ at: c.time() }), c.time(), r => c.plus(r.at, 90, "minutes"));
    expect(String(await run({ at: time("23:00") }))).toBe("00:30:00");
  });

  it("move a date-time by calendar and clock units, and an instant by clock units", async () => {
    const local = answering(c.object({ at: c.datetime() }), c.datetime(), (r: { at: c.Template<Temporal.PlainDateTime> }) => c.plus(c.plus(r.at, 1, "days"), 2, "hours"));
    expect(String(await local.run({ at: datetime("2026-03-08T01:30") }))).toBe("2026-03-09T03:30:00");
    const exact = answering(c.object({ at: c.instant() }), c.instant(), r => c.minus(r.at, 30, "seconds"));
    expect(String(await exact.run({ at: instant("2026-01-01T00:00:00Z") }))).toBe("2025-12-31T23:59:30Z");
  });

  it("refuse a unit the type does not take, and an amount that is not whole", async () => {
    const days = answering(c.object({ at: c.time() }), c.time(), r => (c.plus as (...args: unknown[]) => unknown)(r.at, 1, "days"));
    await expect(days.run({ at: time("10:00") })).rejects.toThrow(/cannot count a time in days/);
    const half = answering(c.object({ at: c.date(), by: c.number() }), c.date(), r => c.plus(r.at, r.by, "days"));
    await expect(half.run({ at: date("2026-01-01"), by: 1.5 })).rejects.toThrow(/whole number of days/);
  });
});

describe("between", () => {
  it("counts whole units from start to end, negative when end comes first", async () => {
    const { run } = answering(c.object({ from: c.date(), to: c.date() }), c.int(), r => c.between(r.from, r.to, "days"));
    expect(await run({ from: date("2026-02-16"), to: date("2026-02-19") })).toBe(3);
    expect(await run({ from: date("2026-02-16"), to: date("2026-02-14") })).toBe(-2);
  });

  it("drops a part of a unit", async () => {
    const months = answering(c.object({ from: c.date(), to: c.date() }), c.int(), r => c.between(r.from, r.to, "months"));
    expect(await months.run({ from: date("2026-01-31"), to: date("2026-03-30") })).toBe(1);
    const hours = answering(c.object({ from: c.instant(), to: c.instant() }), c.int(), r => c.between(r.from, r.to, "hours"));
    expect(await hours.run({ from: instant("2026-01-01T00:00:00Z"), to: instant("2026-01-01T02:59:59Z") })).toBe(2);
    expect(await hours.run({ from: instant("2026-01-01T02:59:59Z"), to: instant("2026-01-01T00:00:00Z") })).toBe(-2);
  });
});

describe("proofs", () => {
  const bounded = c.object({
    at: c.date().min(date("2000-01-01")).max(date("2099-12-31")),
    by: c.int().min(0).max(365),
    to: c.date().min(date("2000-01-01")).max(date("2099-12-31")),
  });

  it("prove a date moved by fixed units from the bounds of its parts", () => {
    expect(c.verify(answering(bounded, c.date(), r => c.plus(r.at, r.by, "days")).implementation).status).toBe("verified");
    expect(c.verify(answering(bounded, c.date().max(date("2101-01-01")), r => c.plus(r.at, r.by, "days")).implementation).status).toBe("verified");
    expect(c.verify(answering(bounded, c.date().max(date("2099-12-31")), r => c.plus(r.at, r.by, "days")).implementation).status).toBe("refuted");
  });

  it("leave a date unproved when it may leave the range Temporal holds", () => {
    const unbounded = c.object({ at: c.date(), by: c.int().min(0).max(365) });
    expect(c.verify(answering(unbounded, c.date(), r => c.plus(r.at, r.by, "days")).implementation).status).toBe("undetermined");
  });

  it("leave months and years unproved, since they have no fixed length", () => {
    expect(c.verify(answering(bounded, c.date(), r => c.plus(r.at, 1, "months")).implementation).status).toBe("undetermined");
  });

  it("prove a count between two dates within the integers it can reach", () => {
    expect(c.verify(answering(bounded, c.int(), r => c.between(r.at, r.to, "days")).implementation).status).toBe("verified");
    expect(c.verify(answering(bounded, c.int().min(-36_524).max(36_524), r => c.between(r.at, r.to, "days")).implementation).status).toBe("verified");
    expect(c.verify(answering(bounded, c.int().min(0), r => c.between(r.at, r.to, "days")).implementation).status).toBe("refuted");
  });

  it("count between date-times over the range Temporal holds them in, beyond the instants", () => {
    const span = c.object({ at: c.datetime(), to: c.datetime() });
    const hours = (result: AnySchema) => c.verify(answering(span, result, r => c.between(r.at, r.to, "hours")).implementation).status;
    expect(hours(c.int().min(-4_800_000_047).max(4_800_000_047))).toBe("verified");
    expect(hours(c.int().min(-4_800_000_000).max(4_800_000_000))).not.toBe("verified");
  });

  it("place the dates and date-times beyond the instants on the timeline", () => {
    const day = 86_400_000_000_000n;
    expect(timelineOf(datetime("+275760-09-13T23:59:59.999999999"))?.numerator).toBe(100_000_001n * day - 1n);
    expect(timelineOf(datetime("-271821-04-19T00:00:00.000000001"))?.numerator).toBe(-100_000_001n * day + 1n);
    expect(timelineOf(date("-271821-04-19"))?.numerator).toBe(-100_000_001n * day);
    expect(timelineOf(datetime("2020-01-02T03:04:05.006007008"))?.numerator).toBe(instant("2020-01-02T03:04:05.006007008Z").epochNanoseconds);
  });

  it("prove a time of day moved by clock units, since it wraps", () => {
    expect(c.verify(answering(c.object({ at: c.time() }), c.time(), r => c.plus(r.at, 90, "minutes")).implementation).status).toBe("verified");
  });

  it("leave a time of day unproved when its amount may not be whole or may be too long a duration", async () => {
    const half = answering(c.object({ at: c.time(), by: c.number() }), c.time(), r => c.plus(r.at, r.by, "hours"));
    expect(c.verify(half.implementation).status).not.toBe("verified");
    await expect(half.run({ at: time("10:00"), by: 1.5 })).rejects.toThrow(/whole number of hours/);
    // 2^53 seconds and more is no duration Temporal takes.
    const long = (by: AnySchema) => answering(c.object({ at: c.time(), by }), c.time(), r => c.plus(r.at, r.by, "hours"));
    expect(c.verify(long(c.int()).implementation).status).not.toBe("verified");
    await expect(long(c.int()).run({ at: time("10:00"), by: 2_501_999_792_984 })).rejects.toThrow();
    expect(c.verify(long(c.int().min(-2_501_999_792_983).max(2_501_999_792_983)).implementation).status).toBe("verified");
  });

  it("leave weeks between unproved when the end may lie within a week of the range Temporal holds", async () => {
    const weeks = (end: AnySchema) => answering(c.object({ from: c.date(), to: end }), c.int(), r => c.between(r.from, r.to, "weeks"));
    // Temporal rounds the count by placing the week past the end, which lies beyond the latest date.
    expect(c.verify(weeks(c.date()).implementation).status).not.toBe("verified");
    await expect(weeks(c.date()).run({ from: date("+275760-09-12"), to: date("+275760-09-13") })).rejects.toThrow();
    const roomy = weeks(c.date().min(date("-271821-04-26")).max(date("+275760-09-06")));
    expect(c.verify(roomy.implementation).status).toBe("verified");
    expect(await roomy.run({ from: date("+275760-09-13"), to: date("+275760-09-06") })).toBe(-1);
    expect(await roomy.run({ from: date("-271821-04-19"), to: date("-271821-04-26") })).toBe(1);
  });
});
