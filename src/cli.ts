#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { isBehavior } from "./behavior.js";
import type { AnyBehavior } from "./behavior.js";
import { formatTypeScriptValue } from "./codegen.js";
import {
  defineSpecification,
  evaluateSpecification,
  examples,
  generationReport,
  isSpecification,
} from "./specification.js";
import type {
  AdequacyReport,
  ArmCoverage,
  BorderCoverage,
  GeneratedExample,
  Measure,
  PartitionCoverage,
  RulesMeasure,
  Specification,
  Verdict,
} from "./specification.js";

interface LoadedTarget {
  readonly behaviorBinding: string;
  readonly specification: Specification;
  readonly existingRows: number;
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

export async function run(argv: readonly string[]): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const [command, file, ...flags] = argv;

  if ((command !== "check" && command !== "generate") || file === undefined) {
    stderr.push(usage());
    return { exitCode: 2, stdout, stderr };
  }

  const targets = await loadTargets(file);
  if (targets.length === 0) {
    stderr.push(`${file}にexportされたbehaviorまたはspecificationがありません`);
    return { exitCode: 2, stdout, stderr };
  }

  if (command === "check") {
    const reports = await Promise.all(
      targets.map(target => evaluateSpecification(target.specification)),
    );
    for (const report of reports) {
      stdout.push(formatReport(report));
    }
    const exitCode =
      flags.includes("--strict") && reports.some(report => !report.adequate) ? 1 : 0;
    return { exitCode, stdout, stderr };
  }

  for (const target of targets) {
    const { rows: generated, notComposed } = generationReport(
      target.specification.examples,
      target.specification.implementation,
    );
    stdout.push(
      formatGeneratedExamples(target.behaviorBinding, generated, target.existingRows),
    );
    for (const way of notComposed) {
      stdout.push(`// 組み立てられなかった道筋: ${way}`);
    }
  }
  return { exitCode: 0, stdout, stderr };
}

async function loadTargets(file: string): Promise<readonly LoadedTarget[]> {
  const url = pathToFileURL(resolve(file)).href;
  const module = (await tsImport(url, import.meta.url)) as Readonly<
    Record<string, unknown>
  >;
  const exportedBehaviors = new Map<AnyBehavior, string>();
  for (const [name, value] of Object.entries(module)) {
    if (isBehavior(value)) {
      exportedBehaviors.set(value, name);
    }
  }

  const targets: LoadedTarget[] = [];
  const referenced = new Set<AnyBehavior>();
  for (const value of Object.values(module)) {
    if (!isSpecification(value)) {
      continue;
    }
    const definition = value.examples.behavior;
    referenced.add(definition);
    targets.push({
      behaviorBinding:
        exportedBehaviors.get(definition) ?? toIdentifier(definition.name),
      specification: value,
      existingRows: value.examples.rows.length,
    });
  }

  for (const [definition, binding] of exportedBehaviors) {
    if (referenced.has(definition)) {
      continue;
    }
    targets.push({
      behaviorBinding: binding,
      specification: defineSpecification({
        name: definition.name,
        examples: examples(definition, []),
      }),
      existingRows: 0,
    });
  }

  return targets;
}

function formatReport(report: AdequacyReport): string {
  const implementation = report.implementation === "present" ? "あり" : "なし";
  const lines = [
    `${report.specification} (${report.behavior})`,
    formatCoverage("入力variant", report.input),
    formatCoverage("結果variant", report.result),
    formatCoverage("作用variant", report.effects),
    ...formatPartitions(report.partitions),
    ...formatBorders(report.borders),
    ...formatEvidence("証拠（入力）", report.evidence.input, ["specified", "executed", "verified"]),
    ...formatEvidence("証拠（結果）", report.evidence.result, ["specified", "observed", "verified"]),
    ...formatEvidence("証拠（作用）", report.evidence.effects, ["specified", "observed", "verified"]),
    `  実装                 ${implementation}`,
    `  分岐                 ${formatMeasure(report.measures.arms)}`,
    ...formatArms(report.measures.arms),
    `  道筋                 ${formatMeasure(report.measures.rules)}`,
    ...formatRules(report.measures.rules),
    `  比較                 ${
      report.measures.comparisons.status === "complete"
        ? "すべて読めた (complete)"
        : `一部のみ (partial); 読めない比較: ${report.measures.comparisons.notRead.join(", ")}`
    }`,
  ];

  for (const row of report.unanswered) {
    lines.push(`  ! 未回答のexample: ${row.name} — ${row.reason}`);
  }
  for (const pending of report.pendingDecisions) {
    lines.push(`  ! 実装保留: ${pending.variant} — ${pending.reason}`);
  }
  for (const gap of report.controlGaps) {
    lines.push(`  ! 制御未決定: ${gap.effect} — ${gap.reason}`);
  }
  for (const issue of report.dependencyIssues) {
    const scope = issue.variant === undefined ? "behavior" : issue.variant;
    lines.push(`  ! 依存関係の誤り (${scope}): ${issue.reason}`);
  }
  for (const failure of report.failures) {
    lines.push(`  ✗ ${failure.name}: ${failure.message}`);
  }

  lines.push(`充足度: ${verdictLabels[report.verdict]} (${report.verdict})`);
  return lines.join("\n");
}

const verdictLabels: Readonly<Record<Verdict, string>> = {
  satisfied: "完全",
  not_satisfied: "不完全",
  undetermined: "未確定",
};

function formatPartitions(partitions: readonly PartitionCoverage[]): string[] {
  const lines: string[] = [];
  const divided = partitions.flatMap(partition =>
    partition.kind === "divided" ? [partition] : [],
  );
  if (divided.length > 0) {
    lines.push("  クラス");
    for (const partition of divided) {
      const total = partition.covered.length + partition.missing.length;
      const missing =
        partition.missing.length === 0 ? "" : `; 未網羅 ${partition.missing.join(", ")}`;
      const excluded =
        partition.excluded.length === 0
          ? ""
          : `; 除外 ${partition.excluded.join(", ")} (excluded)`;
      lines.push(
        `    ${padDisplay(partition.path, 19)} ${partition.covered.length}/${total}${missing}${excluded}`,
      );
    }
  }
  const undivided = partitions.filter(partition => partition.kind === "not-derivable");
  if (undivided.length > 0) {
    lines.push(
      `  ${padDisplay("導出できない位置", 21)} ${undivided.map(partition => partition.path).join(", ")} (not derivable)`,
    );
  }
  return lines;
}

const pointStatusLabels: Readonly<Record<BorderCoverage["points"][number]["status"], string>> = {
  met: "met",
  gap: "! 行がない (gap)",
  excluded: "除外 (excluded)",
  "not named": "隣の値なし (not named)",
  "no point": "点なし (no point)",
};

function formatBorders(borders: readonly BorderCoverage[]): string[] {
  if (borders.length === 0) {
    return [];
  }
  return [
    "  境界",
    ...borders.flatMap(border => [
      `    ${padDisplay(border.path, 19)} ${border.rule}`,
      ...border.points.map(
        point =>
          `      ${point.role.padEnd(3)} ${padDisplay(point.relation, 20)} ${pointStatusLabels[point.status]}`,
      ),
    ]),
  ];
}

function formatEvidence<Grade extends string>(
  label: string,
  evidence: readonly ({ readonly case: string } & Readonly<Record<Grade, boolean>>)[],
  grades: readonly Grade[],
): string[] {
  if (evidence.length === 0) {
    return [];
  }
  const cases = evidence.map(item => {
    const reached = grades.filter(grade => item[grade]);
    return `${item.case}: ${reached.length === 0 ? "なし" : reached.join("・")}`;
  });
  return [`  ${padDisplay(label, 21)} ${cases.join(", ")}`];
}

function padDisplay(value: string, width: number): string {
  const displayWidth = [...value].reduce(
    (sum, char) => sum + (/[\u3000-\u30ff\u4e00-\u9fff\uff00-\uffef]/u.test(char) ? 2 : 1),
    0,
  );
  return value + " ".repeat(Math.max(width - displayWidth, 0));
}

const armStatusLabels: Readonly<Record<ArmCoverage["status"], string>> = {
  met: "met",
  gap: "! 行がない (gap)",
  "answer owed": "! 期待結果が未回答 (answer owed)",
};

function formatArms(measure: Measure): string[] {
  if (measure.status === "unavailable") {
    return [];
  }
  return measure.arms.map(
    arm => `    ${arm.decision}: guard ${arm.guard} ${arm.arm.padEnd(5)} ${armStatusLabels[arm.status]}`,
  );
}

function formatRules(measure: RulesMeasure): string[] {
  if (measure.status === "unavailable") {
    return [];
  }
  return measure.rules.map(
    rule => `    ${rule.decision}: ${rule.way} ${armStatusLabels[rule.status]}`,
  );
}

function formatMeasure(measure: Measure | RulesMeasure): string {
  switch (measure.status) {
    case "complete":
      return "計測済み (complete)";
    case "partial":
      return `一部のみ (partial); 読めないdecision: ${measure.notRead.join(", ")}`;
    case "unavailable":
      return measure.reason === "not applicable"
        ? "対象なし (not applicable)"
        : `計測不能 (not measured); 読めないdecision: ${measure.notRead.join(", ")}`;
  }
}

function formatCoverage(
  label: string,
  coverage: AdequacyReport["input"],
): string {
  const suffix =
    coverage.missing.length === 0
      ? ""
      : `; 未網羅 ${coverage.missing.join(", ")}`;
  return `  ${label.padEnd(19)} ${coverage.covered.length}/${coverage.total}${suffix}`;
}

function formatGeneratedExamples(
  binding: string,
  generated: readonly GeneratedExample[],
  existingRows: number,
): string {
  if (generated.length === 0) {
    return `${binding}: 未網羅の入力variantはありません`;
  }

  const rows = generated
    .map(row => formatGeneratedExample(binding, row))
    .join(",\n");
  if (existingRows > 0) {
    return rows;
  }

  return `export const ${binding}Examples = examples(${binding}, [\n${rows}\n]);`;
}

function formatGeneratedExample(
  binding: string,
  generated: GeneratedExample,
): string {
  const given = indent(formatTypeScriptValue(generated.given), 4);
  return `  example(${binding}, ${JSON.stringify(generated.name)}, {\n    given: ${given.trimStart()},\n    expect: unanswered(${JSON.stringify(generated.reason)}),\n  })`;
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line, index) => (index === 0 ? line : `${prefix}${line}`))
    .join("\n");
}

function toIdentifier(value: string): string {
  const words = value.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  const [first = "behavior", ...rest] = words;
  return [first, ...rest.map(word => word[0]?.toUpperCase() + word.slice(1))].join("");
}

function usage(): string {
  return "Usage: chisel <check|generate> <spec.ts> [--strict]";
}

function isRunAsScript(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isRunAsScript()) {
  const result = await run(process.argv.slice(2));
  for (const line of result.stdout) {
    console.log(line);
  }
  for (const line of result.stderr) {
    console.error(line);
  }
  process.exitCode = result.exitCode;
}
