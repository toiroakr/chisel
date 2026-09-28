import * as c from "../../src/index.js";

const Line = c.object({
  category: c.variants("type", {
    LODGING: c.object({}),
    TRANSPORT: c.object({}),
    MEAL: c.object({}),
  }),
  amount: c.int().min(0),
  receipt: c.boolean(),
});

export const Report = c.variants("status", {
  draft: c.object({ id: c.string(), lines: c.array(Line) }),
  submitted: c.object({
    id: c.string(),
    lines: c.array(Line),
    amount: c.int(),
    limit: c.int(),
    urgent: c.boolean(),
  }),
  approved: c.object({ id: c.string(), lines: c.array(Line), approver: c.string() }),
  returned: c.object({ id: c.string(), lines: c.array(Line), reason: c.string() }),
  settled: c.object({ id: c.string(), paidAt: c.instant() }),
});

export const Outcome = c.variants("outcome", {
  submitted: c.object({}),
  approved: c.object({}),
  settled: c.object({}),
  refused: c.object({ reason: c.string() }),
});

export const NoEffects = c.variants("type", {});

export const refuse = (reason: string) => () => ({
  result: { outcome: "refused" as const, reason },
  effects: [],
});

export const answer = <const Tag extends "submitted" | "approved" | "settled">(outcome: Tag) => () => ({
  result: { outcome },
  effects: [],
});
