import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

async function dependencies(entry: string): Promise<Set<string>> {
  const result = await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm",
    write: false, metafile: true });
  return new Set(Object.keys(result.metafile.inputs));
}

describe("production import graph", () => {
  const excluded = ["src/machine-check.ts", "src/world.ts", "src/tla.ts", "src/domain.ts", "src/proof.ts", "src/specification.ts", "src/verification.ts"];
  function expectRuntimeOnly(imports: ReadonlySet<string>): void {
    const normalized = [...imports].map(path => path.replaceAll("\\", "/").replace(/^\.\//, ""));
    for (const name of excluded) expect(normalized.some(path => path === name || path.endsWith(`/${name}`)), name).toBe(false);
    expect(normalized.some(path => path.includes("node_modules/tla-ts/")), "tla-ts").toBe(false);
  }
  it("points the package root at the production entry", () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));
    expect(manifest.exports["."].import).toBe("./dist/runtime.js");
    expect(manifest.exports["."].types).toBe("./dist/runtime.d.ts");
    expect(manifest.exports["./full"].import).toBe("./dist/index.js");
  });
  it("excludes verification tools and TLA+ from the runtime entry", async () => {
    const entry = resolve(import.meta.dirname, "../src/runtime.ts");
    const imports = await dependencies(entry);
    expectRuntimeOnly(imports);
    expect([...imports].some(path => path.endsWith("src/machine.ts"))).toBe(true);
  });

  it("keeps the production example independent from its specification", async () => {
    const imports = await dependencies(resolve(import.meta.dirname, "../examples/order-machine.ts"));
    expectRuntimeOnly(imports);
    expect([...imports].some(path => path.endsWith("/order-machine.spec.ts"))).toBe(false);
    expect([...imports].some(path => path.endsWith("/src/verification.ts"))).toBe(false);
  });
});
