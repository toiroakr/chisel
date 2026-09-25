import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  spec,
  evaluateSpecification,
  examples,
  formatTypeScriptValue,
  generateExamples,
} from "../../src/index.js";
import type {
  AdequacyReport,
  GeneratedExample,
  Specification,
} from "../../src/index.js";
import { 予約をキャンセルする as 段階1の振る舞い } from "./stage-01-sketch.spec.js";
import { 最初の回答 } from "./stage-02-first-answer.spec.js";
import { 詳細化した仕様 } from "./stage-03-refined.spec.js";
import { 完成した仕様 } from "./stage-04-complete.spec.js";

const 段階1のスケッチ = spec({
  name: "段階1: dataとbehaviorの宣言",
  examples: examples(段階1の振る舞い, []),
});

await show(
  "STEP 1 — dataとbehaviorの外形を書く",
  "まだ実装もexampleも書かない。Chiselが入力variantごとの未回答exampleを生成する。",
  段階1のスケッチ,
  "予約をキャンセルする",
);

await show(
  "STEP 2 — 人間が期待値を埋める",
  "生成された入力に対して期待するresultとeffectsを人間が決める。この時点では実装がなくてもよい。",
  最初の回答,
  "予約をキャンセルする",
);

showTypeBreak();

await show(
  "STEP 3 — dataとbehaviorを更新する",
  "予約確定に宿泊開始日時とキャンセル要求日時を追加する。古いexampleは型エラーになり、更新後の入力形を持つexampleが生成される。",
  詳細化した仕様,
  "予約をキャンセルする",
);

await show(
  "STEP 4 — exampleを満たすmodelを実装する",
  "生成された雛形を期限前・期限ちょうど・期限後の3例へ展開し、24時間前まで返金するmodelを実装する。",
  完成した仕様,
);

async function show(
  title: string,
  description: string,
  specification: Specification,
  behaviorBinding?: string,
): Promise<void> {
  console.log(`\n${title}`);
  console.log(description);
  const report = await evaluateSpecification(specification);
  console.log(formatReport(report));

  if (behaviorBinding !== undefined) {
    const generated = generateExamples(specification.examples);
    if (generated.length > 0) {
      console.log("生成されたexample:");
      console.log(formatGeneratedRows(behaviorBinding, generated));
    }
  }
}

function showTypeBreak(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const tsc = resolve(here, "../../node_modules/typescript/bin/tsc");
  const config = resolve(here, "type-break/tsconfig.json");
  const result = spawnSync(
    process.execPath,
    [tsc, "-p", config, "--pretty", "false"],
    { encoding: "utf8" },
  );
  const diagnostic = `${result.stdout}${result.stderr}`
    .split("\n")
    .filter(line => line.includes("stale-example.ts"))
    .join("\n");

  console.log("\nMODEL CHANGE — 古いexampleをそのまま残す");
  console.log(`TypeScript終了コード: ${result.status ?? "不明"}`);
  console.log(diagnostic || "想定したTypeScriptの型エラーが出力されませんでした");
}

function formatReport(report: AdequacyReport): string {
  const verdictLabels: Readonly<Record<AdequacyReport["verdict"], string>> = {
    satisfied: "完全",
    not_satisfied: "不完全",
    undetermined: "未確定",
  };
  const implementation = report.implementation === "present" ? "あり" : "なし";
  const lines = [
    `入力variant    ${report.input.covered.length}/${report.input.total}`,
    `結果variant    ${report.result.covered.length}/${report.result.total}`,
    `作用variant    ${report.effects.covered.length}/${report.effects.total}`,
    `実装             ${implementation}`,
  ];

  if (report.input.missing.length > 0) {
    lines.push(`未網羅           入力: ${report.input.missing.join(", ")}`);
  }
  for (const row of report.unanswered) {
    lines.push(`未回答           ${row.name}: ${row.reason}`);
  }
  for (const decision of report.pendingDecisions) {
    lines.push(`実装保留         ${decision.variant}: ${decision.reason}`);
  }
  for (const gap of report.controlGaps) {
    lines.push(`制御未決定       ${gap.effect}: ${gap.reason}`);
  }
  for (const failure of report.failures) {
    lines.push(`不一致           ${failure.name}: ${failure.message}`);
  }
  lines.push(`充足度           ${verdictLabels[report.verdict]} (${report.verdict})`);
  return lines.join("\n");
}

function formatGeneratedRows(
  behaviorBinding: string,
  generated: readonly GeneratedExample[],
): string {
  return generated
    .map(
      row =>
        `example(${behaviorBinding}, ${JSON.stringify(row.name)}, {\n` +
        `  given: ${formatTypeScriptValue(row.given).replaceAll("\n", "\n  ")},\n` +
        `  expect: unanswered(${JSON.stringify(row.reason)}),\n` +
        "})",
    )
    .join(",\n");
}
