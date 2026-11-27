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
it("says on stderr which phase a long run is on, once it has gone on a while", async () => {
  const lines: string[] = [];
  const result = await runIsolated(["check", fileURLToPath(new URL("../examples/verified.spec.ts", import.meta.url))], 30000, { after: 0, every: 1, write: line => lines.push(line) });
  expect(result.exitCode).toBe(0);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every(line => /^chisel: \S+: (例の行を実行中|分岐と道筋を計測中|foldの書き換えを確かめ中|構築を証明中|停止を調べ中)$/.test(line))).toBe(true);
});
it("says the phase at the default interval when every is zero, negative or NaN, instead of every millisecond", async () => {
  for (const every of [0, -5, Number.NaN]) {
    const lines: string[] = [];
    const result = await runIsolated(["check", fileURLToPath(new URL("../examples/verified.spec.ts", import.meta.url))], 30000, { after: 0, every, write: line => lines.push(line) });
    expect(result.exitCode).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(lines).size).toBe(lines.length);
  }
});
it("says nothing of a run that ends before the first saying", async () => {
  const lines: string[] = [];
  const result = await runIsolated(["check", fileURLToPath(new URL("../examples/verified.spec.ts", import.meta.url))], 30000, { after: 60000, write: line => lines.push(line) });
  expect(result.exitCode).toBe(0);
  expect(lines).toStrictEqual([]);
});
it("hands what to change in the model over before the report", async () => {
  const early: string[] = [];
  const result = await runIsolated(["check", fileURLToPath(new URL("./fixtures/many-ways.ts", import.meta.url)), "--feasibility-ways", "5"], 30000, { early: line => early.push(line) });
  expect(result.exitCode).toBe(0);
  expect(early.length).toBe(1);
  expect(early[0]).toMatch(/^計測の前に:/);
  expect(result.logs.some(entry => entry.message.includes("計測の前に"))).toBe(false);
  const kept = await runIsolated(["check", fileURLToPath(new URL("./fixtures/many-ways.ts", import.meta.url)), "--feasibility-ways", "5"]);
  expect(kept.exitCode).toBe(0);
  expect(kept.logs[0]!.message).toMatch(/^計測の前に:/);
});
it("holds what a run says before its result to the output limit too, whether or not a callback takes it", async () => {
  const flood = fileURLToPath(new URL("./fixtures/early-flood.ts", import.meta.url));
  const taken: string[] = [];
  const handed = await runIsolated(["check", flood], 30000, { early: line => taken.push(line) });
  expect(handed.error).toBe("Execution output exceeded 1 MiB");
  expect(taken.length).toBe(1);
  const kept = await runIsolated(["check", flood]);
  expect(kept.error).toBe("Execution output exceeded 1 MiB");
});
