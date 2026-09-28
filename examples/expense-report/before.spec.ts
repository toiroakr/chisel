import * as c from "../../src/index.js";
import { answer, NoEffects, Outcome, refuse, Report } from "./model.js";

export const submit = c.behavior("submit", { input: Report, result: Outcome, effects: NoEffects });

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
    submitted: c.action("refuse unless draft", { run: refuse("not a draft") }),
    approved: c.action("refuse unless draft", { run: refuse("not a draft") }),
    returned: c.action("refuse unless draft", { run: refuse("not a draft") }),
    settled: c.action("refuse unless draft", { run: refuse("not a draft") }),
  },
});

export const approve = c.behavior("approve", { input: Report, result: Outcome, effects: NoEffects });

export const approveImplementation = c.implement(approve, {
  cases: {
    draft: c.action("refuse unless submitted", { run: refuse("not submitted") }),
    submitted: c.action("approve within the limit", {
      guards: r => [r.amount.$lte(r.limit).$else(refuse("over the limit"))],
      run: answer("approved"),
    }),
    approved: c.action("refuse unless submitted", { run: refuse("not submitted") }),
    returned: c.action("refuse unless submitted", { run: refuse("not submitted") }),
    settled: c.action("refuse unless submitted", { run: refuse("not submitted") }),
  },
});

export const settle = c.behavior("settle", { input: Report, result: Outcome, effects: NoEffects });

export const settleImplementation = c.implement(settle, {
  cases: {
    draft: c.action("refuse unless approved", { run: refuse("not approved") }),
    submitted: c.action("refuse unless approved", { run: refuse("not approved") }),
    approved: c.action("settle", { run: answer("settled") }),
    returned: c.action("refuse unless approved", { run: refuse("not approved") }),
    settled: c.action("refuse unless approved", { run: refuse("not approved") }),
  },
});

export const submitSpecification = c.spec("submit", { examples: c.examples(submit, {}), implementation: submitImplementation });
export const approveSpecification = c.spec("approve", { examples: c.examples(approve, {}), implementation: approveImplementation });
export const settleSpecification = c.spec("settle", { examples: c.examples(settle, {}), implementation: settleImplementation });
