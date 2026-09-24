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

describe("chisel check with a position the invariants leave empty", () => {
  it("prints the position as a model error", async () => {
    const result = await run(["check", fixture("test/fixtures/empty-position.ts")]);

    expect(stdoutOf(result)).toMatch(
      /^  ! モデルの誤り: @入力済み\.数量: 不変条件を満たす値がありません \(invariant \$ >= 10, invariant \$ <= 5\)$/m,
    );
  });
});

describe("chisel check with a way no row can take", () => {
  it("counts the way under its reason instead of listing it as a gap", async () => {
    const result = await run(["check", fixture("test/fixtures/infeasible-way.ts")]);

    expect(stdoutOf(result)).toMatch(
      /^    行は不要 \(no row owed\): ガードの条件がこの値について両立しない — 1件$/m,
    );
  });
});

describe("chisel check with an input case the input sum refuses", () => {
  it("prints the case as excluded beside the input coverage", async () => {
    const result = await run(["check", fixture("test/fixtures/refused-case.ts")]);

    expect(stdoutOf(result)).toMatch(/^  入力variant +0\/1; 未網羅 入力済み; 除外 廃止 \(excluded\)$/m);
  });
});

describe("chisel check with ensures clauses", () => {
  it("prints how much of each rule the check reads and the cases no rule states", async () => {
    const result = await run(["check", fixture("test/fixtures/ensures-readings.ts")]);
    const stdout = stdoutOf(result);

    expect([
      /^    入力を写す: value\.数量 >= input\.数量 — 導出可能 \(derivable\)$/m.test(stdout),
      /^    商品は同じ: value\.商品ID == input\.商品ID — 完全一致 \(exact match\)$/m.test(stdout),
      /^    述べられていない結果: 保留$/m.test(stdout),
    ]).toStrictEqual([true, true, true]);
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

  it("wraps rows for a behavior with no specification in imports and defineSpecification", async () => {
    const result = await run(["generate", fixture("test/fixtures/gap-coverage.ts")]);

    expect(stdoutOf(result).match(/^import .* from "chisel";$/gm)).toStrictEqual([
      'import { defineSpecification, example, examples, unanswered } from "chisel";',
    ]);
    expect(stdoutOf(result)).toContain(
      [
        "export const unreferencedBehaviorExamples = examples(unreferencedBehavior, [",
        '  example(unreferencedBehavior, "unreferenced: ready", {',
        "    given: {",
        '      state: "ready",',
        '      id: "<Id>",',
        "    },",
        '    expect: unanswered("readyの期待結果を人間が決める必要があります"),',
        "  }),",
      ].join("\n"),
    );
    expect(stdoutOf(result)).toContain(
      [
        "export const unreferencedBehaviorSpecification = defineSpecification({",
        '  name: "unreferenced",',
        "  examples: unreferencedBehaviorExamples,",
        "});",
      ].join("\n"),
    );
  });

  it("prints only rows, each with a trailing comma, for a specification that has examples", async () => {
    const result = await run(["generate", fixture("examples/order-cancellation.spec.ts")]);

    expect(stdoutOf(result)).toMatch(/^  \}\),$/m);
    expect(stdoutOf(result)).not.toMatch(/^import /m);
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
  }, 30_000);
});

describe("chisel check with classes", () => {
  async function report(): Promise<string> {
    const result = await run(["check", fixture("test/fixtures/classes.ts")]);
    return stdoutOf(result);
  }

  it("prints each divided position with the classes no row is in", async () => {
    expect(await report()).toMatch(/^    @商品あり\.クーポン +1\/2; 未網羅 あり$/m);
  });

  it("prints the positions the model draws no line through as not derivable", async () => {
    expect(await report()).toMatch(
      /^  導出できない位置 +@商品あり\.カートID, @商品あり\.クーポン\? \(not derivable\)$/m,
    );
  });

  it("prints how far the rows got for each input case", async () => {
    expect(await report()).toMatch(/^  証拠（入力） +商品あり: specified・executed・verified$/m);
  });

  it("prints how far the rows got for each effect case", async () => {
    expect(await report()).toMatch(/^  証拠（作用） +決済要求: specified・observed・verified$/m);
  });

  it("prints arms as not measured and names the decisions it could not read", async () => {
    expect(await report()).toMatch(
      /^  分岐 +計測不能 \(not measured\); 読めないdecision: 確定する$/m,
    );
  });

  it("prints the combinations of classes as counts without asking for rows", async () => {
    const result = await run(["check", fixture("test/fixtures/pairs.ts")]);

    expect(stdoutOf(result)).toMatch(
      /^  組み合わせ \(pairs\) +@入力済み\.ギフト × @入力済み\.速達 1\/4$/m,
    );
  });

  it("prints the verdict in both words", async () => {
    expect(await report()).toMatch(/^充足度: 不完全 \(not_satisfied\)$/m);
  });
});

describe("chisel check with borders", () => {
  async function report(): Promise<string> {
    const result = await run(["check", fixture("test/fixtures/borders.ts")]);
    return stdoutOf(result);
  }

  it("prints a class the rules refuse as excluded", async () => {
    expect(await report()).toMatch(/^    @入力済み\.同意 +1\/1; 除外 false \(excluded\)$/m);
  });

  it("prints each border with the rule that drew it", async () => {
    expect(await report()).toMatch(/^    @入力済み\.数量 +invariant \$ >= 1$/m);
  });

  it("prints each point with its role, relation and what became of it", async () => {
    const text = await report();

    expect([
      /^      ON  = 1 +met$/m.test(text),
      /^      OFF = 0 +除外 \(excluded\)$/m.test(text),
      /^      IN  > 1 +! 行がない \(gap\)$/m.test(text),
      /^      OUT < 0 +除外 \(excluded\)$/m.test(text),
    ]).toStrictEqual([true, true, true, true]);
  });
});

describe("chisel check and generate with a rules decision", () => {
  async function output(command: "check" | "generate"): Promise<string> {
    const result = await run([command, fixture("test/fixtures/rules.ts")]);
    return stdoutOf(result);
  }

  it("prints the arms as measured and marks each one", async () => {
    const text = await output("check");

    expect([
      /^  分岐 +計測済み \(complete\)$/m.test(text),
      /^    在庫を確かめる: guard all\(\$\.明細, \$\.明細\[\]\.数量 <= \$\.明細\[\]\.在庫数\) holds +met$/m.test(text),
      /^    在庫を確かめる: guard all\(\$\.明細, \$\.明細\[\]\.数量 <= \$\.明細\[\]\.在庫数\) else +! 行がない \(gap\)$/m.test(text),
    ]).toStrictEqual([true, true, true]);
  });

  it("prints the rules of the decision with the way each one goes", async () => {
    const text = await output("check");

    expect([
      /^  道筋 +計測済み \(complete\)$/m.test(text),
      /^    在庫を確かめる: all\(\$\.明細, \$\.明細\[\]\.数量 <= \$\.明細\[\]\.在庫数\) holds → otherwise +met$/m.test(text),
    ]).toStrictEqual([true, true]);
  });

  it("says every comparison in the guards could be read", async () => {
    expect(await output("check")).toMatch(/^  比較 +すべて読めた \(complete\)$/m);
  });

  it("generates rows at the points of a guard border", async () => {
    expect(await output("generate")).toMatch(/在庫数 OFF \(= 1\)/);
  });
});

describe("chisel generate with a way it could not compose", () => {
  it("names the way as a comment instead of leaving it out", async () => {
    const result = await run(["generate", fixture("test/fixtures/uncomposable.ts")]);

    expect(stdoutOf(result)).toMatch(
      /^\/\/ 組み立てられなかった道筋: 並び: \$\.姓 < \$\.名 holds → otherwise$/m,
    );
  });
});

describe("chisel check --json", () => {
  it("writes the reports as one JSON document with a schema version", async () => {
    const result = await run(["check", fixture("test/fixtures/rules.ts"), "--json"]);
    const document = JSON.parse(stdoutOf(result)) as {
      readonly schemaVersion: number;
      readonly reports: readonly { readonly specification: string; readonly verdict: string }[];
    };

    expect({
      schemaVersion: document.schemaVersion,
      reports: document.reports.map(({ specification, verdict }) => ({ specification, verdict })),
    }).toStrictEqual({
      schemaVersion: 1,
      reports: [{ specification: "注文確定", verdict: "not_satisfied" }],
    });
  });

  it("keeps the exit status --strict decides", async () => {
    const result = await run(["check", fixture("test/fixtures/rules.ts"), "--json", "--strict"]);

    expect(result.exitCode).toBe(1);
  });
});
