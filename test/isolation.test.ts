import { expect, it } from "vitest";
import { runIsolated } from "../src/isolated.js";
import { fileURLToPath } from "node:url";

it("terminates a module that never finishes loading", async () => {
  const result = await runIsolated(["check", fileURLToPath(new URL("./fixtures/nonterminating.ts", import.meta.url))], 500);
  expect(result.exitCode).toBe(1);
  expect(result.error).toContain("worker was terminated");
});
it("returns normal CLI output from an isolated worker", async () => {
  const result = await runIsolated(["run", fileURLToPath(new URL("./fixtures/run.ts", import.meta.url)), "--input", '{}']);
  expect(result.exitCode).toBe(1);
  expect(result.error).toBeDefined();
});
it("emits exactly one JSON document across the worker boundary", async () => {
  const result = await runIsolated(["verify", fileURLToPath(new URL("../examples/verified.spec.ts", import.meta.url)), "--json"]);
  expect(result.exitCode).toBe(0);
  const text = result.logs.filter(entry => entry.stream === "stdout").map(entry => entry.message).join("\n");
  expect(JSON.parse(text)[0].status).toBe("verified");
});
