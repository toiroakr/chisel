import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// The modules an entry reaches through its imports, type-only ones aside.
function reached(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!file.startsWith("src/")) return;
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const [, specifier] of source.matchAll(/^(?:import|export) (?!type )[^;]*?from "([^"]+)"/gms)) {
      visit(specifier!.startsWith("./") ? `src/${specifier!.slice(2).replace(/\.js$/, ".ts")}` : specifier!);
    }
  };
  visit(entry);
  return seen;
}

it("chisel imports no Node module, so it runs where only Web APIs exist", () => {
  expect([...reached("src/index.ts")].filter(module => module.startsWith("node:"))).toEqual([]);
});

it("chisel/isolated is the entry that needs Node", () => {
  expect([...reached("src/isolated.ts")]).toContain("node:worker_threads");
});
