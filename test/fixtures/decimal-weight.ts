import { Decimal } from "decimal.js";
import * as c from "../../src/index.js";

export const ship = c.behavior("ship", {
  input: c.variants("state", { requested: c.object({ weight: c.decimal(3).min(new Decimal("0")) }) }),
  result: c.variants("outcome", { shipped: c.object({}) }),
  effects: c.variants("type", {}),
});
