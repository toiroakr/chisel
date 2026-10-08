import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { expect, it } from "vitest";

// The modules an entry reaches through its imports, type-only ones aside and
// side-effect ones (`import "node:fs";`) and dynamic ones (`import("node:fs")`)
// included: a bundler resolves a dynamic import of a literal too. A specifier
// may be quoted either way.
function reached(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (!file.startsWith("src/")) return;
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const imports = [
      ...source.matchAll(/^(?:import|export) (?!type )[^;]*?from (["'])([^"']+)\1/gms),
      ...source.matchAll(/^import (["'])([^"']+)\1/gm),
      ...source.matchAll(/\bimport\((["'])([^"']+)\1\)/g),
    ];
    for (const [, , specifier] of imports) {
      visit(specifier!.startsWith("./") ? `src/${specifier!.slice(2).replace(/\.js$/, ".ts")}` : specifier!);
    }
  };
  visit(entry);
  return seen;
}

it("chisel imports no Node module, so it runs where only Web APIs exist", () => {
  // A builtin named without `node:` (`from "fs"`) is a Node module too.
  expect([...reached("src/index.ts")].filter(module => module.startsWith("node:") || builtinModules.includes(module))).toEqual([]);
});

it("chisel/isolated is the entry that needs Node", () => {
  expect([...reached("src/isolated.ts")]).toContain("node:worker_threads");
});
