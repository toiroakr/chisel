import { Decimal } from "decimal.js";
import { expect, it } from "vitest";
import * as c from "../src/index.js";
import { provesNumeric } from "../src/interval.js";
import { positionTerm } from "../src/rule.js";

it("keeps a sum's scale unknown once a part of no declared scale is added, whatever the parts after it declare", () => {
  const scope = c.object({ a: c.decimal().min(new Decimal(0)).max(new Decimal(1)), b: c.decimal(2).min(new Decimal(0)).max(new Decimal(1)) });
  const sum = (positionTerm(["a"], "value") as unknown as c.TermOf<Decimal>).$plus(positionTerm(["b"], "value") as never);
  expect(provesNumeric(c.decimal(2), sum, scope, [])).toBe(false);
  expect(provesNumeric(c.decimal(), sum, scope, [])).toBe(true);
});
