import { Decimal } from "decimal.js";
import { isRational } from "./exact.js";
import { isDecimal } from "./rule.js";
import { onTimeline, temporalKindOf } from "./temporal.js";

export function compatibleBound(value: unknown, kind: string): boolean {
  if (onTimeline(kind)) return temporalKindOf(value) === kind;
  if (kind === "number" || kind === "integer") return typeof value === "number" && Number.isFinite(value);
  if (kind === "bigint" || kind === "int64") return typeof value === "bigint";
  if (kind === "rational") return isRational(value);
  if (kind === "decimal") {
    if (!isDecimal(value) && typeof value !== "number" && typeof value !== "string" && typeof value !== "bigint") return false;
    try { return new Decimal(value as Decimal.Value).isFinite(); } catch { return false; }
  }
  return true;
}
