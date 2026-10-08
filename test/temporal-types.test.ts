import { it } from "vitest";
import * as c from "../src/index.js";

const shape = c.object({ day: c.date(), clock: c.time(), local: c.datetime(), moment: c.instant(), by: c.int() });
const typed = c.behavior("typed", {
  input: c.variants("kind", { given: shape }),
  result: c.variants("outcome", { ok: c.object({ day: c.date(), clock: c.time(), local: c.datetime(), moment: c.instant(), days: c.int() }) }),
  effects: c.variants("type", {}),
});

it("types each operation by the value it moves", () => {
  c.implement(typed, { cases: { given: c.model("typed", r => {
    const day: c.Expression<Temporal.PlainDate> = c.plus(r.day, r.by, "days");
    const local: c.Expression<Temporal.PlainDateTime> = c.plus(c.plus(r.local, 1, "days"), 2, "hours");
    // @ts-expect-error a date moved is a date, not a date-time
    const notLocal: c.Expression<Temporal.PlainDateTime> = c.plus(r.day, 1, "days");
    void [day, local, notLocal];
    // @ts-expect-error a time of day takes clock units only
    c.plus(r.clock, 1, "days");
    // @ts-expect-error an instant takes clock units only
    c.minus(r.moment, 1, "months");
    // @ts-expect-error between takes two values of one type
    c.between(r.day, r.local, "days");
    return {
      result: {
        outcome: "ok" as const,
        day: c.minus(r.day, 1, "months"),
        clock: c.plus(r.clock, 90, "minutes"),
        local: c.plus(r.local, 1, "weeks"),
        moment: c.plus(r.moment, 30, "seconds"),
        days: c.between(r.day, c.plus(r.day, r.by, "days"), "days"),
      },
      effects: [],
    };
  }) } });
});
