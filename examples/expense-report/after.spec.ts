import * as c from "../../src/index.js";
import { answer, NoEffects, Outcome, refuse, Report } from "./model.js";

export const submit = c.behavior("submit", {
  input: Report,
  result: Outcome,
  effects: NoEffects,
  disregards: { draft: () => [], $default: r => [r] },
});

export const submitImplementation = c.implement(submit, {
  cases: {
    draft: c.action("submit a draft whose lodging has receipts", {
      guards: r => [
        r.lines
          .$all(line => line.category.type.$ne("LODGING").$or(line.receipt.$eq(true)))
          .$else(refuse("lodging without a receipt")),
      ],
      run: answer("submitted"),
    }),
    $default: c.action("refuse unless draft", { run: refuse("not a draft") }),
  },
});

export const approve = c.behavior("approve", {
  input: Report,
  result: Outcome,
  effects: NoEffects,
  disregards: { submitted: r => [r.lines, r.urgent], $default: r => [r] },
});

export const approveImplementation = c.implement(approve, {
  cases: {
    submitted: c.action("approve within the limit", {
      guards: r => [r.amount.$lte(r.limit).$else(refuse("over the limit"))],
      run: answer("approved"),
    }),
    $default: c.action("refuse unless submitted", { run: refuse("not submitted") }),
  },
});

export const settle = c.behavior("settle", {
  input: Report,
  result: Outcome,
  effects: NoEffects,
  disregards: { $default: r => [r] },
});

export const settleImplementation = c.implement(settle, {
  cases: {
    approved: c.action("settle", { run: answer("settled") }),
    $default: c.action("refuse unless approved", { run: refuse("not approved") }),
  },
});

export const submitSpecification = c.spec("submit", { examples: c.examples(submit, {}), implementation: submitImplementation });
const refused = (reason: string) => ({ result: { outcome: "refused" as const, reason }, effects: [] });
const lodging = { category: { type: "LODGING" as const }, amount: 12000, receipt: true };

export const approveSpecification = c.spec("approve", {
  examples: c.examples(approve, {
    "a draft is not approved": { given: { status: "draft", id: "R-1", lines: [lodging] }, expect: refused("not submitted") },
    "a report within the limit is approved": {
      given: { status: "submitted", id: "R-2", lines: [lodging], amount: 12000, limit: 12000, urgent: false },
      expect: { result: { outcome: "approved" }, effects: [] },
    },
    "a report over the limit is refused": {
      given: { status: "submitted", id: "R-3", lines: [lodging], amount: 12001, limit: 12000, urgent: false },
      expect: refused("over the limit"),
    },
    "an approved report is not approved again": {
      given: { status: "approved", id: "R-4", lines: [lodging], approver: "manager" },
      expect: refused("not submitted"),
    },
    "a returned report is not approved": {
      given: { status: "returned", id: "R-5", lines: [lodging], reason: "missing receipt" },
      expect: refused("not submitted"),
    },
    "a settled report is not approved": {
      given: { status: "settled", id: "R-6", paidAt: Temporal.Instant.from("2026-09-01T00:00:00Z") },
      expect: refused("not submitted"),
    },
  }),
  implementation: approveImplementation,
});
export const settleSpecification = c.spec("settle", { examples: c.examples(settle, {}), implementation: settleImplementation });
