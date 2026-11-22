import type { Temporal as TemporalTypes } from "temporal-spec";

export const TEMPORAL_UNAVAILABLE =
  "Temporal is unavailable; use Node.js 26 or later, or install a Temporal polyfill such as temporal-polyfill/global";

export function temporalGlobal(): typeof TemporalTypes | undefined {
  return (globalThis as { readonly Temporal?: typeof TemporalTypes }).Temporal;
}

export function requireTemporal(): typeof TemporalTypes {
  const temporal = temporalGlobal();
  if (temporal === undefined) throw new Error(TEMPORAL_UNAVAILABLE);
  return temporal;
}
