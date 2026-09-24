import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function fixture(path: string): string {
  return resolve(repoRoot, path);
}

describe("cli run() check", () => {
  it("prints a report and exits 0 when the specification is inadequate but not strict", async () => {
    const result = await run(["check", fixture("examples/order-cancellation.spec.ts")]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toMatch(/order cancellation \(cancel-order\)/);
    expect(result.stdout.join("\n")).toMatch(/充足度: 不完全/);
  });

  it("exits 1 in --strict mode when the specification is inadequate", async () => {
    const result = await run([
      "check",
      fixture("examples/order-cancellation.spec.ts"),
      "--strict",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.join("\n")).toMatch(/充足度: 不完全/);
  });

  it("exits 2 and prints usage when no file is given", async () => {
    const result = await run([]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr.join("\n")).toMatch(/Usage: chisel <check\|generate>/);
  });

  it("exits 2 and prints usage for an unknown command", async () => {
    const result = await run([
      "frobnicate",
      fixture("examples/order-cancellation.spec.ts"),
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr.join("\n")).toMatch(/Usage: chisel <check\|generate>/);
  });

  it("exits 2 when the file exports no behavior or specification", async () => {
    const result = await run(["check", fixture("test/fixtures/empty-spec.ts")]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr.join("\n")).toMatch(
      /exportされたbehaviorまたはspecificationがありません/,
    );
  });

  it("rejects when the spec file cannot be found", async () => {
    await expect(
      run(["check", fixture("test/fixtures/does-not-exist.ts")]),
    ).rejects.toThrow(/Cannot find module/);
  });

  it("synthesizes an empty specification for a behavior exported without one", async () => {
    const result = await run(["check", fixture("test/fixtures/gap-coverage.ts")]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toMatch(/unreferenced \(unreferenced\)/);
    expect(result.stdout.join("\n")).toMatch(/実装\s+なし/);
  });

  it("lists unanswered examples, dependency issues, and failures in the report", async () => {
    const result = await run(["check", fixture("test/fixtures/gap-coverage.ts")]);
    const stdout = result.stdout.join("\n");

    expect(stdout).toMatch(/! 未回答のexample: ready — undecided/);
    expect(stdout).toMatch(
      /! 依存関係の誤り \(behavior\): 未知の作用'mail'に依存すると宣言されています/,
    );
    expect(stdout).toMatch(/✗ archived: Expected/);
  });
});

describe("cli run() generate", () => {
  it("prints ready-to-paste example rows for uncovered input variants", async () => {
    const result = await run([
      "generate",
      fixture("examples/order-cancellation.spec.ts"),
    ]);

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.join("\n");
    expect(stdout).toMatch(/example\(cancelOrder, "cancel-order: preparing"/);
    expect(stdout).toMatch(/expect: unanswered\(/);
  });

  it("derives a binding name from the behavior when it has no exported name of its own", async () => {
    const result = await run(["generate", fixture("test/fixtures/gap-coverage.ts")]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toMatch(
      /^inlineCheck: 未網羅の入力variantはありません$/m,
    );
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
  });
});

describe("cli run() check with classes", () => {
  async function report(): Promise<string> {
    const result = await run(["check", fixture("test/fixtures/classes.ts")]);
    return result.stdout.join("\n");
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

  it("prints the verdict in both words", async () => {
    expect(await report()).toMatch(/^充足度: 不完全 \(not_satisfied\)$/m);
  });
});

describe("cli run() check with borders", () => {
  async function report(): Promise<string> {
    const result = await run(["check", fixture("test/fixtures/borders.ts")]);
    return result.stdout.join("\n");
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

describe("cli run() with a rules decision", () => {
  async function output(command: "check" | "generate"): Promise<string> {
    const result = await run([command, fixture("test/fixtures/rules.ts")]);
    return result.stdout.join("\n");
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

describe("cli run() generate with a way it could not compose", () => {
  it("names the way as a comment instead of leaving it out", async () => {
    const result = await run(["generate", fixture("test/fixtures/uncomposable.ts")]);

    expect(result.stdout.join("\n")).toMatch(
      /^\/\/ 組み立てられなかった道筋: 並び: \$\.姓 < \$\.名 holds → otherwise$/m,
    );
  });
});
