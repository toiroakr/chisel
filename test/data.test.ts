import { expect, it } from "vitest";
import * as c from "../src/index.js";

it("requires a validated construction for named data and freezes it", () => {
  const Price = c.data("Price", c.object({ cents: c.int().min(1) }));
  const Quantity = c.data("Quantity", c.object({ cents: c.int().min(1) }));
  const price = Price.create({ cents: 100 });
  // @ts-expect-error Unconstructed objects lack the nominal brand.
  const raw: c.Infer<typeof Price> = { cents: 100 };
  // @ts-expect-error Different domain names cannot be substituted.
  const other: c.Infer<typeof Price> = Quantity.create({ cents: 100 });
  expect(price.cents).toBe(100);
  expect(() => Price.create({ cents: 0 })).toThrow("Cannot construct Price");
  expect(Object.isFrozen(price)).toBe(true);
  expect(c.decode(Price, { cents: 100 })).toStrictEqual({ success: true, value: price });
});
it("checks named constructions in expression models", () => {
  const Positive = c.data("Positive", c.object({ n: c.int().min(1) }));
  const behavior = c.behavior("positive", { input: c.variants("kind", { input: c.object({}) }), result: Positive, effects: c.variants("kind", {}) });
  const implementation = c.implement(behavior, { constructs: [Positive], cases: { input: c.model("make", () => ({ result: c.construct(Positive, { n: 1 }), effects: [] })) } });
  expect(() => c.implement(behavior, { cases: { input: c.model("unauthorized", () => ({ result: c.construct(Positive, { n: 1 }), effects: [] })) } })).toThrow("constructs");
  expect(c.verify(implementation).status).toBe("verified");
});
