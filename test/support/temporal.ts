if ((globalThis as { Temporal?: unknown }).Temporal === undefined) await import("temporal-polyfill/full/global");
