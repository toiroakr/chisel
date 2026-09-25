#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { arg, defineCommand, runMain } from "@politty/valibot";
import { tsImport } from "tsx/esm/api";
import * as v from "valibot";
import { isBehavior } from "./behavior.js";
import type { AnyBehavior } from "./behavior.js";
import { formatKey, formatTypeScriptValue } from "./codegen.js";
import {
  spec,
  check,
  examples,
  generate,
  isSpecification,
} from "./specification.js";
import type { EnsuresClassification, EnsuresReport } from "./ensures.js";
import { reportDocument } from "./report-json.js";
import type {
  AdequacyReport,
  BorderCoverage,
  CoverageStatus,
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
  readonly synthesized: boolean;
}

const fileArg = arg(v.string(), {
  positional: true,
  description: "behaviorまたはspecificationをexportしたspecファイル",
});

const checkCommand = defineCommand({
  name: "check",
  description: "specificationの充足度を報告する",
  args: v.object({
    file: fileArg,
    strict: arg(v.optional(v.boolean(), false), {
      description: "充足度が不完全なら終了コード1で失敗する",
    }),
    json: arg(v.optional(v.boolean(), false), {
      description: "レポートをJSONで出力する",
    }),
  }),
  run: async args => {
    const targets = await loadTargets(args.file);
    const reports = await Promise.all(
      targets.map(target => check(target.specification)),
    );
    if (args.json) {
      const document = reportDocument(reports, { id: resolve(args.file), name: args.file });
      console.log(JSON.stringify(document, undefined, 2));
    } else {
      for (const report of reports) {
        console.log(formatReport(report));
      }
    }
    if (args.strict && reports.some(report => !report.adequate)) {
      throw new Error("充足度が不完全なspecificationがあります");
    }
  },
});

const generateCommand = defineCommand({
  name: "generate",
  description: "未網羅の入力variantに対するexampleの雛形を出力する",
  args: v.object({ file: fileArg }),
  run: async args => {
    const targets = await loadTargets(args.file);
    if (targets.some(target => target.synthesized)) {
      console.log('import * as c from "chisel";\n');
    }
    for (const target of targets) {
      const { rows: generated, notComposed } = generate(
        target.specification.examples,
        target.specification.implementation,
      );
      console.log(
        formatGeneratedExamples(target, generated),
      );
      for (const way of notComposed) {
        console.log(`// 組み立てられなかった道筋: ${way}`);
      }
    }
  },
});

export const cli = defineCommand({
  name: "chisel",
  description: "実行可能な業務仕様を段階的に育てるツールキット",
  subCommands: {
    check: checkCommand,
    generate: generateCommand,
  },
});

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
      synthesized: false,
    });
  }

  for (const [definition, binding] of exportedBehaviors) {
    if (referenced.has(definition)) {
      continue;
    }
    targets.push({
      behaviorBinding: binding,
      specification: spec(definition.name, {
        examples: examples(definition, {}),
      }),
      synthesized: true,
    });
  }

  if (targets.length === 0) {
    throw new Error(`${file}にexportされたbehaviorまたはspecificationがありません`);
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
    ...formatPairs(report.pairs),
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
    ...formatEnsures(report.ensures),
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
  for (const item of report.incompleteness) {
    if (!report.failures.some(failure => failure.name === item.subject)) {
      lines.push(`  ! 実行できなかった行: ${item.subject} — ${item.reason}`);
    }
  }
  for (const issue of report.modelIssues) {
    lines.push(`  ! モデルの誤り: ${issue}`);
  }
  for (const issue of report.fakeIssues) {
    lines.push(`  ! fake の誤り: ${issue}`);
  }
  for (const warning of report.fakeWarnings) {
    lines.push(`  ! fake と記録済みの例の不一致（警告）: ${warning}`);
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
  "no row owed": "行は不要 (no row owed)",
  undecided: "未決 (undecided)",
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

function formatPairs(pairs: AdequacyReport["pairs"]): string[] {
  if (pairs.length === 0) {
    return [];
  }
  const counts = pairs.map(
    pair => `${pair.positions[0]} × ${pair.positions[1]} ${pair.reached}/${pair.total}`,
  );
  return [`  ${padDisplay("組み合わせ (pairs)", 21)} ${counts.join(", ")}`];
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

const armStatusLabels: Readonly<Record<"met" | "gap" | "answer owed", string>> = {
  met: "met",
  gap: "! 行がない (gap)",
  "answer owed": "! 期待結果が未回答 (answer owed)",
};

const countedLabels: Readonly<Record<"no row owed" | "undecided", string>> = {
  "no row owed": "行は不要 (no row owed)",
  undecided: "未決 (undecided)",
};

function formatLines<T extends { readonly status: CoverageStatus; readonly reason?: string }>(
  items: readonly T[],
  describe: (item: T) => string,
): string[] {
  const lines: string[] = [];
  const counted = new Map<string, number>();
  for (const item of items) {
    if (item.status === "no row owed" || item.status === "undecided") {
      const key = `${countedLabels[item.status]}: ${item.reason ?? ""}`;
      counted.set(key, (counted.get(key) ?? 0) + 1);
    } else {
      lines.push(`    ${describe(item)} ${armStatusLabels[item.status]}`);
    }
  }
  for (const [key, count] of counted) {
    lines.push(`    ${key} — ${count}件`);
  }
  return lines;
}

function formatArms(measure: Measure): string[] {
  if (measure.status === "unavailable") {
    return [];
  }
  return formatLines(measure.arms, arm => `${arm.decision}: guard ${arm.guard} ${arm.arm.padEnd(5)}`);
}

function formatRules(measure: RulesMeasure): string[] {
  if (measure.status === "unavailable") {
    return [];
  }
  return formatLines(measure.rules, rule => `${rule.decision}: ${rule.way}`);
}

const classificationLabels: Readonly<Record<EnsuresClassification, string>> = {
  derivable: "導出可能 (derivable)",
  "exact match": "完全一致 (exact match)",
  "always holds": "常に成立 (always holds)",
  "never holds": "決して成立しない (never holds)",
  "runtime only": "実行時のみ (runtime only)",
};

function formatEnsures(ensures: EnsuresReport): string[] {
  if (ensures.rules.length === 0) {
    return [];
  }
  return [
    "  ensures",
    ...ensures.rules.map(
      rule =>
        `    ${rule.clause}: ${rule.conjunct} — ${classificationLabels[rule.classification]}`,
    ),
    ...(ensures.unstated.length === 0
      ? []
      : [`    述べられていない結果: ${ensures.unstated.join(", ")}`]),
  ];
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
  const missing =
    coverage.missing.length === 0 ? "" : `; 未網羅 ${coverage.missing.join(", ")}`;
  const excluded =
    coverage.excluded.length === 0 ? "" : `; 除外 ${coverage.excluded.join(", ")} (excluded)`;
  return `  ${label.padEnd(19)} ${coverage.covered.length}/${coverage.total}${missing}${excluded}`;
}

function formatGeneratedExamples(
  target: LoadedTarget,
  generated: readonly GeneratedExample[],
): string {
  const binding = target.behaviorBinding;
  if (generated.length === 0) {
    return `${binding}: 未網羅の入力variantはありません`;
  }

  const rows = generated.map(row => `${formatGeneratedExample(row)},\n`).join("");
  if (!target.synthesized) {
    return target.specification.implementation === undefined
      ? `${rows.trimEnd()}\n\n${formatImplementationScaffold(target)}`
      : rows.trimEnd();
  }

  return [
    `export const ${binding}Examples = c.examples(${binding}, {\n${rows}});`,
    "",
    formatImplementationScaffold(target),
    "",
    `export const ${binding}Specification = c.spec(${JSON.stringify(target.specification.name)}, {`,
    `  examples: ${binding}Examples,`,
    `  implementation: ${binding}Implementation,`,
    "});",
  ].join("\n");
}

function formatImplementationScaffold(target: LoadedTarget): string {
  const definition = target.specification.examples.behavior;
  const entries = (tags: readonly string[], what: string) =>
    tags.map(tag => `    ${formatKey(tag)}: c.todo(${JSON.stringify(`${tag}の${what}を決める必要があります`)}),`);
  const controls = definition.effects.variantTags;
  return [
    `export const ${target.behaviorBinding}Implementation = c.implement(${target.behaviorBinding}, {`,
    "  cases: {",
    ...entries(definition.input.variantTags, "判断"),
    "  },",
    ...(controls.length === 0 ? [] : ["  controls: {", ...entries(controls, "制御"), "  },"]),
    "});",
  ].join("\n");
}

function formatGeneratedExample(generated: GeneratedExample): string {
  const given = indent(formatTypeScriptValue(generated.given), 4);
  const written =
    generated.with === undefined
      ? ""
      : `\n    with: ${indent(formatTypeScriptValue(generated.with), 4).trimStart()},`;
  return `  ${JSON.stringify(generated.name)}: {\n    given: ${given.trimStart()},${written}\n    expect: c.todo(${JSON.stringify(generated.reason)}),\n  }`;
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
  await runMain(cli);
}
