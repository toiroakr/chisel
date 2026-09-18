#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { isBehavior } from "./behavior.js";
import type { AnyBehavior } from "./behavior.js";
import {
  defineSpecification,
  evaluateSpecification,
  examples,
  generateExamples,
  isSpecification,
} from "./specification.js";
import type {
  AdequacyReport,
  GeneratedExample,
  Specification,
} from "./specification.js";

interface LoadedTarget {
  readonly behaviorBinding: string;
  readonly specification: Specification;
  readonly existingRows: number;
}

const [command, file, ...flags] = process.argv.slice(2);

if ((command !== "check" && command !== "generate") || file === undefined) {
  usage();
  process.exitCode = 2;
} else {
  const targets = await loadTargets(file);
  if (targets.length === 0) {
    console.error(`${file}にexportされたbehaviorまたはspecificationがありません`);
    process.exitCode = 2;
  } else if (command === "check") {
    const reports = await Promise.all(
      targets.map(target => evaluateSpecification(target.specification)),
    );
    for (const report of reports) {
      console.log(formatReport(report));
    }
    if (flags.includes("--strict") && reports.some(report => !report.adequate)) {
      process.exitCode = 1;
    }
  } else {
    for (const target of targets) {
      const generated = generateExamples(target.specification.examples);
      console.log(
        formatGeneratedExamples(
          target.behaviorBinding,
          generated,
          target.existingRows,
        ),
      );
    }
  }
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
    `  実装                 ${implementation}`,
    "  内部分岐             判定不能（自由記述のTypeScript）",
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
  for (const failure of report.failures) {
    lines.push(`  ✗ ${failure.name}: ${failure.message}`);
  }

  lines.push(`充足度: ${report.adequate ? "完全" : "不完全"}`);
  return lines.join("\n");
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
  const given = indent(JSON.stringify(generated.given, null, 2), 4);
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

function usage(): void {
  console.error("Usage: chisel <check|generate> <spec.ts> [--strict]");
}
