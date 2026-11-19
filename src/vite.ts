import { compileTlaSource } from "./tla-source.js";

/** Vite-compatible plugin; use alongside the TypeScript content mapper for .tla imports. */
export function chiselTla(): { name: string; enforce: "pre"; transform(code: string, id: string): string | null } {
  return { name: "chisel-tla", enforce: "pre", transform(code, id) {
    return id.split("?", 1)[0]?.endsWith(".tla") ? compileTlaSource(code).code : null;
  } };
}
