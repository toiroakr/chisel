#!/usr/bin/env node
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { runIsolated } from "./isolated.js";

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { arg, defineCommand, runCommand as executeCommand } from "@politty/zod";
import { tsImport } from "tsx/esm/api";
import { z } from "zod";
import { isBehavior, perform } from "./behavior.js";
import type { AnyBehavior, AnyImplementation } from "./behavior.js";
import { decode, encode } from "./codec.js";
import { array, object } from "./schema.js";
import type { Beside } from "./beside.js";
import { formatKey, formatTypeScriptValue } from "./codegen.js";
import {
  spec,
  check,
  examples,
  generate,
  isSpecification,
} from "./specification.js";
import type { EnsuresClassification, EnsuresReport } from "./ensures.js";
import { verify } from "./proof.js";
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
  readonly implementations?: readonly AnyImplementation[];
}

const fileArg = arg(z.string({ error: "Missing required argument <file>" }), {
  positional: true,
  description: "behaviorまたはspecificationをexportしたspecファイル",
});

const pairArgs = {
  pairObligations: arg(z.coerce.number().int().positive().optional(), { description: "検査する組み合わせ義務の上限（既定20000）" }),
  pairCandidates: arg(z.coerce.number().int().positive().optional(), { description: "組み合わせを構築する候補の上限（既定4096）" }),
};
function pairOptions(args: { pairObligations?: number | undefined; pairCandidates?: number | undefined }) {
  return { ...(args.pairObligations === undefined ? {} : { obligations: args.pairObligations }), ...(args.pairCandidates === undefined ? {} : { candidates: args.pairCandidates }) };
}

const behaviorArg = arg(z.string().optional(), {
  description: "宣言したbehavior名に一致するspecificationだけを対象にする",
});

const checkCommand = defineCommand({
  name: "check",
  description: "specificationの充足度を報告する",
  args: z.object({
    file: fileArg,
    behavior: behaviorArg,
    timeout: arg(z.coerce.number().int().positive().default(30000), { description: "モジュール読込を含む実行上限（ミリ秒）" }),
    strict: arg(z.boolean().default(false), {
      description: "充足度が不完全なら終了コード1で失敗する",
    }),
    json: arg(z.boolean().default(false), {
      description: "レポートをJSONで出力する",
    }),
    disregardCombinations: arg(z.coerce.number().int().positive().optional(), {
      description: "disregardsの確認で試す組み合わせの上限（既定は255）",
    }),
    disregardCandidates: arg(z.coerce.number().int().positive().optional(), {
      description: "disregardsの確認で数える候補の上限（既定は4096）",
    }),
    ...pairArgs,
    feasibilityCombinations: arg(z.coerce.number().int().positive().optional(), {
      description: "不変条件とあわせて道筋や境界点を確かめるときに試す値の組の上限（既定は4096）",
    }),
    feasibilityWays: arg(z.coerce.number().int().positive().optional(), {
      description: "decisionごとにたどる道筋の上限。超えたdecisionは計測しない（既定は10000）",
    }),
  }),
  run: async args => {
    const targets = await loadTargets(args.file, args.behavior);
    const disregards = {
      ...(args.disregardCombinations === undefined ? {} : { combinations: args.disregardCombinations }),
      ...(args.disregardCandidates === undefined ? {} : { candidates: args.disregardCandidates }),
    };
    const reports = await Promise.all(
      targets.map(target =>
        check(target.specification, {
          disregards,
          feasibility: feasibilityOptions(args),
          pairs: pairOptions(args),
        }),
      ),
    );
    if (args.json) {
      const document = reportDocument(reports, { id: resolve(args.file), name: args.file });
      console.log(JSON.stringify(document, undefined, 2));
    } else {
      for (const report of reports) {
        console.log(formatReport(report));
      }
    }
    if (args.strict && reports.some(report => report.verdict !== "satisfied")) {
      throw new Error("充足度が不完全なspecificationがあります");
    }
  },
});

const generateCommand = defineCommand({
  name: "generate",
  description: "未網羅の入力variantに対するexampleの雛形を出力する",
  args: z.object({
    file: fileArg,
    behavior: behaviorArg,
    timeout: arg(z.coerce.number().int().positive().default(30000), { description: "モジュール読込を含む実行上限（ミリ秒）" }),
    ways: arg(z.boolean().default(false), {
      description: "1か所を動かすだけでは通れない道筋も、有限の値をまとめて書き込んで行を出力する",
    }),
    ...pairArgs,
    feasibilityCombinations: arg(z.coerce.number().int().positive().optional(), {
      description: "不変条件とあわせて行を組み立てるときに試す値の組の上限（既定は4096）",
    }),
    feasibilityWays: arg(z.coerce.number().int().positive().optional(), {
      description: "decisionごとにたどる道筋の上限。超えたdecisionの道筋は組み立てない（既定は10000）",
    }),
  }),
  run: async args => {
    const targets = await loadTargets(args.file, args.behavior);
    const printed = targets.map(target => {
      const { rows: generated, notComposed } = generate(
        target.specification.examples,
        target.specification.implementation,
        {
          ways: args.ways,
          feasibility: feasibilityOptions(args),
          pairs: pairOptions(args),
        },
      );
      return [
        formatGeneratedExamples(target, generated),
        ...notComposed.map(way => `// 組み立てられなかった道筋: ${way}`),
      ];
    });
    if (targets.some(target => target.synthesized)) {
      // A decimal's rows are written with decimal.js, which the file then imports.
      const decimal = printed.flat().some(line => line.includes("new Decimal("));
      console.log(`import * as c from "chisel";\n${decimal ? 'import { Decimal } from "decimal.js";\n' : ""}`);
    }
    for (const line of printed.flat()) {
      console.log(line);
    }
  },
});

const runCommand = defineCommand({
  name: "run",
  description: "JSON入力で実装を1回実行し、結果と副作用をJSONで出力する",
  args: z.object({
    file: fileArg,
    behavior: behaviorArg,
    timeout: arg(z.coerce.number().int().positive().default(30000), { description: "モジュール読込を含む実行上限（ミリ秒）" }),
    input: arg(z.string({ error: "Missing required option --input" }), {
      description: "入力のJSON。DecimalとTemporalは文字列で指定する",
    }),
  }),
  run: async args => {
    const targets = await loadTargets(args.file, args.behavior, true);
    const implementations = [...new Set(targets.flatMap(target => target.implementations ?? []))];
    if (implementations.length !== 1) {
      throw new Error(implementations.length === 0
        ? "実行できるimplementationがありません。specに実装を指定するかimplementationをexportしてください"
        : "implementationを一意に選べません。--behaviorで実装が1つのbehaviorを指定してください");
    }
    const implementation = implementations[0]!;
    const definition = implementation.behavior;
    if (Object.keys(definition.requires).length > 0) {
      throw new Error(`${definition.name}には依存関係があります。performで依存関係を渡して実行してください`);
    }
    let json: unknown;
    try {
      json = JSON.parse(args.input);
    } catch {
      throw new Error("--inputは有効なJSONで指定してください");
    }
    const input = decode(definition.input, json);
    if (!input.success) {
      throw new Error(input.issues.map(issue => `${issue.path}: ${issue.message}`).join("\n"));
    }
    const execution = await perform(implementation, input.value);
    const output = encode(object({ result: definition.result, effects: array(definition.effects) }), execution);
    if (!output.success) {
      throw new Error(output.issues.map(issue => `${issue.path}: ${issue.message}`).join("\n"));
    }
    console.log(JSON.stringify(output.value, undefined, 2));
  },
});

const verifyCommand = defineCommand({
  name: "verify",
  description: "全入力で構築と事後条件を証明できるか検査する（未判定も失敗）",
  args: z.object({
    file: fileArg, behavior: behaviorArg,
    json: arg(z.boolean().default(false), { description: "証明結果をJSONで出力する" }),
    timeout: arg(z.coerce.number().int().positive().default(30000), { description: "モジュール読込を含む実行上限（ミリ秒）" }),
    candidates: arg(z.coerce.number().int().positive().default(4096), { description: "全入力の列挙上限" }),
    ways: arg(z.coerce.number().int().positive().default(10000), { description: "構築経路の列挙上限" }),
  }),
  run: async args => {
    const targets = await loadTargets(args.file, args.behavior, true);
    const implementations = [...new Set(targets.flatMap(target => target.implementations ?? []))];
    if (!implementations.length) throw new Error("検証するimplementationがありません");
    const proofs = implementations.map(implementation => ({ behavior: implementation.behavior.name, ...verify(implementation, { candidates: args.candidates, ways: args.ways }) }));
    if (args.json) console.log(JSON.stringify(proofs, jsonReplacer, 2));
    else for (const proof of proofs) for (const decision of proof.decisions) {
      console.log(decision.status === "verified" ? `${proof.behavior}/${decision.decision}: verified` : `${resolve(args.file)}: error CHISEL001: ${proof.behavior}/${decision.decision}: ${decision.status}: ${decision.reason}`);
    }
    if (proofs.some(proof => proof.status !== "verified")) throw new Error("構築の保証を証明できないimplementationがあります");
  },
});

function jsonReplacer(_key: string, value: unknown): unknown { return typeof value === "bigint" ? String(value) : value; }

export const cli = defineCommand({
  name: "chisel",
  description: "実行可能な業務仕様を段階的に育てるツールキット",
  subCommands: {
    check: checkCommand,
    generate: generateCommand,
    run: runCommand,
    verify: verifyCommand,
  },
});

async function loadTargets(file: string, behavior?: string, includeImplementations = false): Promise<readonly LoadedTarget[]> {
  const url = pathToFileURL(resolve(file)).href;
  const module = (await tsImport(url, import.meta.url)) as Readonly<
    Record<string, unknown>
  >;
  const exportedImplementations = Object.values(module).filter((value): value is AnyImplementation =>
    typeof value === "object" && value !== null && "kind" in value && value.kind === "implementation" &&
    "behavior" in value && isBehavior(value.behavior),
  );
  const exportedBehaviors = new Map<AnyBehavior, string>();
  for (const [name, value] of Object.entries(module)) {
    if (isBehavior(value)) {
      exportedBehaviors.set(value, name);
    }
  }

  if (includeImplementations) {
    for (const implementation of exportedImplementations) {
      if (!exportedBehaviors.has(implementation.behavior)) {
        exportedBehaviors.set(implementation.behavior, toIdentifier(implementation.behavior.name));
      }
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
  const loaded = targets.map(target => ({
    ...target,
    implementations: [...new Set([
      ...(target.specification.implementation === undefined ? [] : [target.specification.implementation]),
      ...exportedImplementations.filter(implementation => implementation.behavior === target.specification.examples.behavior),
    ])],
  }));
  if (behavior !== undefined) {
    const selected = loaded.filter(target => target.specification.examples.behavior.name === behavior);
    if (selected.length === 0) {
      const names = [...new Set(targets.map(target => target.specification.examples.behavior.name))];
      throw new Error(`behavior ${behavior}がありません。選択できるbehavior: ${names.join(", ")}`);
    }
    return selected;
  }
  return loaded;
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
    ...report.measures.pairs.obligations.filter(pair => pair.status !== "met").map(pair => `    ${pair.status === "gap" || pair.status === "answer owed" ? "!" : "?"} ${pair.positions.join(" × ")}: ${pair.classes.join(" × ")} (${pair.status})${pair.reason === undefined ? "" : ` — ${pair.reason}`}`),
    ...report.measures.pairs.notRead.map(reason => `    ? 組み合わせ未計測: ${reason}`),
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
    `  構築の保証           ${report.measures.constructions.status}`,
    ...report.measures.constructions.decisions.map(proof => `    ${proof.decision}: ${proof.status} — ${proof.reason}`),
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
  for (const item of report.incompleteness) {
    if (item.kind === "disregards not checked") {
      lines.push(`  ! disregardsを確かめていない行: ${item.subject} — ${item.reason}`);
    } else if (!report.failures.some(failure => failure.name === item.subject)) {
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

function besideLabel(beside: Beside): string {
  switch (beside.status) {
    case "told":
      return "見分けた (told)";
    case "not told":
      return `! ${beside.another} と見分ける行がない${beside.input === undefined ? "" : `: ${beside.input} に行を書く`}`;
    case "undecided":
      return `未決 (undecided): ${beside.reason}`;
  }
}

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
      ...(border.beside === undefined ? [] : [`      ${padDisplay("隣の線", 24)} ${besideLabel(border.beside)}`]),
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

if (!isMainThread && workerData?.chisel === true) {
  const result = await executeCommand(cli, workerData.argv, { captureLogs: true });
  parentPort!.postMessage({ exitCode: result.exitCode, logs: result.logs.entries.map(entry => ({ stream: entry.stream, message: entry.message })), ...(result.error ? { error: result.error.message } : {}) });
} else if (isRunAsScript()) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--timeout");
  const assigned = argv.find(arg => arg.startsWith("--timeout="));
  const timeout = Number(assigned?.slice("--timeout=".length) ?? (at >= 0 ? argv[at + 1] : 30000));
  const result = await runIsolated(argv, Number.isSafeInteger(timeout) && timeout > 0 ? timeout : 30000);
  for (const entry of result.logs) (entry.stream === "stderr" ? console.error : console.log)(entry.message);
  if (result.error) console.error(`Error: ${result.error}`);
  process.exitCode = result.exitCode;
}

function feasibilityOptions(args: {
  readonly feasibilityCombinations?: number | undefined;
  readonly feasibilityWays?: number | undefined;
}): { readonly combinations?: number; readonly ways?: number } {
  return {
    ...(args.feasibilityCombinations === undefined ? {} : { combinations: args.feasibilityCombinations }),
    ...(args.feasibilityWays === undefined ? {} : { ways: args.feasibilityWays }),
  };
}
