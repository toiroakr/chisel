#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import {
  evaluateSpecification,
  generateTodos,
  isSpecification,
} from "./specification.js";
import type { AdequacyReport, Specification } from "./specification.js";

const [command, file, ...flags] = process.argv.slice(2);

if ((command !== "check" && command !== "generate") || file === undefined) {
  usage();
  process.exitCode = 2;
} else {
  const specifications = await loadSpecifications(file);
  if (specifications.length === 0) {
    console.error(`No exported specification found in ${file}`);
    process.exitCode = 2;
  } else if (command === "check") {
    const reports = await Promise.all(specifications.map(evaluateSpecification));
    for (const report of reports) {
      console.log(formatReport(report));
    }
    if (flags.includes("--strict") && reports.some(report => !report.adequate)) {
      process.exitCode = 1;
    }
  } else {
    for (const specification of specifications) {
      const generated = generateTodos(specification);
      console.log(
        JSON.stringify(
          {
            specification: specification.name,
            todos: generated,
          },
          null,
          2,
        ),
      );
    }
  }
}

async function loadSpecifications(file: string): Promise<readonly Specification[]> {
  const url = pathToFileURL(resolve(file)).href;
  const module = (await tsImport(url, import.meta.url)) as Readonly<
    Record<string, unknown>
  >;
  return Object.values(module).filter(isSpecification);
}

function formatReport(report: AdequacyReport): string {
  const lines = [
    `${report.specification} (${report.behavior})`,
    formatCoverage("input variants", report.input),
    formatCoverage("result variants", report.result),
    formatCoverage("effect variants", report.effects),
    "  internal decisions  undetermined (free-form TypeScript)",
  ];

  for (const pending of report.pendingDecisions) {
    lines.push(`  ! pending decision: ${pending.variant} — ${pending.reason}`);
  }
  for (const gap of report.controlGaps) {
    lines.push(`  ! control gap: ${gap.effect} — ${gap.reason}`);
  }
  for (const todo of report.todos) {
    lines.push(`  ! unanswered example: ${todo}`);
  }
  for (const failure of report.failures) {
    lines.push(`  ✗ ${failure.name}: ${failure.message}`);
  }

  lines.push(`adequacy: ${report.adequate ? "complete" : "incomplete"}`);
  return lines.join("\n");
}

function formatCoverage(
  label: string,
  coverage: AdequacyReport["input"],
): string {
  const suffix =
    coverage.missing.length === 0
      ? ""
      : `; missing ${coverage.missing.join(", ")}`;
  return `  ${label.padEnd(19)} ${coverage.covered.length}/${coverage.total}${suffix}`;
}

function usage(): void {
  console.error("Usage: chisel <check|generate> <spec.ts> [--strict]");
}
