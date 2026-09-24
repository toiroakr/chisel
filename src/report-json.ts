import type {
  AdequacyReport,
  ComparisonsMeasure,
  Measure,
  RulesMeasure,
} from "./specification.js";

export const reportSchemaVersion = 1;

export interface ReportSource {
  readonly id: string;
  readonly name: string;
}

export interface Weakening {
  readonly kind: "decision not read" | "comparison not read";
  readonly subject: string;
}

export function reportDocument(
  reports: readonly AdequacyReport[],
  source: ReportSource,
): unknown {
  return {
    schemaVersion: reportSchemaVersion,
    sources: [source],
    reports: reports.map(report => reportJson(report, source.id)),
  };
}

function reportJson(report: AdequacyReport, source: string): unknown {
  const identities = new Identities();
  return {
    source,
    ...report,
    borders: report.borders.map(border => ({
      ...border,
      points: border.points.map(point => ({
        obligationId: identities.claim(
          `point ${border.path} | ${border.rule} | ${point.role} ${point.relation}`,
        ),
        ...point,
      })),
    })),
    measures: {
      arms: armsJson(report.measures.arms, identities),
      rules: rulesJson(report.measures.rules, identities),
      comparisons: comparisonsJson(report.measures.comparisons),
    },
  };
}

function armsJson(measure: Measure, identities: Identities): unknown {
  switch (measure.status) {
    case "complete":
    case "partial":
      return {
        ...measure,
        arms: measure.arms.map(arm => ({
          obligationId: identities.claim(`arm ${arm.decision} | ${arm.guard} | ${arm.arm}`),
          ...arm,
        })),
        ...weakeningOf(measure),
      };
    case "unavailable":
      return { ...measure, ...weakeningOf(measure) };
  }
}

function rulesJson(measure: RulesMeasure, identities: Identities): unknown {
  switch (measure.status) {
    case "complete":
    case "partial":
      return {
        ...measure,
        rules: measure.rules.map(rule => ({
          obligationId: identities.claim(`way ${rule.decision} | ${rule.way}`),
          ...rule,
        })),
        ...weakeningOf(measure),
      };
    case "unavailable":
      return { ...measure, ...weakeningOf(measure) };
  }
}

function comparisonsJson(measure: ComparisonsMeasure): unknown {
  return measure.status === "complete"
    ? measure
    : {
        ...measure,
        weakening: measure.notRead.map(
          (subject): Weakening => ({ kind: "comparison not read", subject }),
        ),
      };
}

function weakeningOf(measure: Measure | RulesMeasure): { readonly weakening?: readonly Weakening[] } {
  return "notRead" in measure
    ? {
        weakening: measure.notRead.map(
          (subject): Weakening => ({ kind: "decision not read", subject }),
        ),
      }
    : {};
}

class Identities {
  readonly #taken = new Map<string, number>();

  claim(identity: string): string {
    const seen = this.#taken.get(identity) ?? 0;
    this.#taken.set(identity, seen + 1);
    return seen === 0 ? identity : `${identity} #${seen + 1}`;
  }
}
