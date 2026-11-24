// The stages hold dates; before Node.js 26 a polyfill stands in for Temporal.
if ((globalThis as { Temporal?: unknown }).Temporal === undefined) await import("temporal-polyfill/global");
