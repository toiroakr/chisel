import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runCommand } from "@politty/valibot";
import type { RunResult } from "@politty/valibot";
import { describe, expect, it } from "vitest";
import { cli } from "../src/cli.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function fixture(path: string): string {
  return resolve(repoRoot, path);
}

function run(argv: string[]): Promise<RunResult> {
  return runCommand(cli, argv, { captureLogs: true });
}

function stdoutOf(result: RunResult): string {
  return result.logs.entries
    .filter(entry => entry.stream === "stdout")
    .map(entry => entry.message)
    .join("\n");
}

describe("chisel check", () => {
  it("prints a report and exits 0 when the specification is inadequate but not strict", async () => {
    const result = await run(["check", fixture("examples/order-cancellation.spec.ts")]);

    expect(result.exitCode).toBe(0);
    expect(stdoutOf(result)).toMatch(/order cancellation \(cancel-order\)/);
    expect(stdoutOf(result)).toMatch(/充足度: 不完全/);
  });

  it("exits 1 in --strict mode when the specification is inadequate", async () => {
    const result = await run([
      "check",
      fixture("examples/order-cancellation.spec.ts"),
      "--strict",
    ]);

    expect(result.exitCode).toBe(1);
    expect(stdoutOf(result)).toMatch(/充足度: 不完全/);
    expect(result.error?.message).toMatch(/充足度が不完全なspecificationがあります/);
  });

  it("fails with a missing-argument message when no file is given", async () => {
    const result = await run(["check"]);

    expect(result.exitCode).toBe(1);
    expect(result.error?.message).toMatch(/Missing required argument <file>/);
  });

  it("fails when the file exports no behavior or specification", async () => {
    const result = await run(["check", fixture("test/fixtures/empty-spec.ts")]);

    expect(result.exitCode).toBe(1);
    expect(result.error?.message).toMatch(
      /exportされたbehaviorまたはspecificationがありません/,
    );
  });

  it("fails when the spec file cannot be found", async () => {
    const result = await run(["check", fixture("test/fixtures/does-not-exist.ts")]);

    expect(result.exitCode).toBe(1);
    expect(result.error?.message).toMatch(/Cannot find module/);
  });

  it("synthesizes an empty specification for a behavior exported without one", async () => {
    const result = await run(["check", fixture("test/fixtures/gap-coverage.ts")]);

    expect(result.exitCode).toBe(0);
    expect(stdoutOf(result)).toMatch(/unreferenced \(unreferenced\)/);
    expect(stdoutOf(result)).toMatch(/実装\s+なし/);
  });

  it("lists unanswered examples, dependency issues, and failures in the report", async () => {
    const result = await run(["check", fixture("test/fixtures/gap-coverage.ts")]);
    const stdout = stdoutOf(result);

    expect(stdout).toMatch(/! 未回答のexample: ready — undecided/);
    expect(stdout).toMatch(
      /! 依存関係の誤り \(behavior\): 未知の作用'mail'に依存すると宣言されています/,
    );
    expect(stdout).toMatch(/✗ archived: Expected/);
  });
});

describe("chisel generate", () => {
  it("prints ready-to-paste example rows for uncovered input variants", async () => {
    const result = await run([
      "generate",
      fixture("examples/order-cancellation.spec.ts"),
    ]);

    expect(result.exitCode).toBe(0);
    const stdout = stdoutOf(result);
    expect(stdout).toMatch(/example\(cancelOrder, "cancel-order: preparing"/);
    expect(stdout).toMatch(/expect: unanswered\(/);
  });

  it("derives a binding name from the behavior when it has no exported name of its own", async () => {
    const result = await run(["generate", fixture("test/fixtures/gap-coverage.ts")]);

    expect(result.exitCode).toBe(0);
    expect(stdoutOf(result)).toMatch(/^inlineCheck: 未網羅の入力variantはありません$/m);
  });
});

describe("chisel (root command)", () => {
  it("fails for an unknown subcommand", async () => {
    const result = await run([
      "frobnicate",
      fixture("examples/order-cancellation.spec.ts"),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.error?.message).toMatch(/Unknown subcommand: frobnicate/);
  });
});

describe("cli entry point (subprocess)", () => {
  it("runs check end-to-end through the shebang entry point and honours --strict", () => {
    const result = spawnSync(
      "npx",
      ["tsx", "src/cli.ts", "check", "examples/order-cancellation.spec.ts", "--strict"],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/order cancellation \(cancel-order\)/);
    expect(result.stdout).toMatch(/充足度: 不完全/);
    expect(result.stderr).toMatch(/充足度が不完全なspecificationがあります/);
  });
});
