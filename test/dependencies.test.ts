import { describe, expect, it } from "vitest";
import {
  behavior,
  defineSpecification,
  dependency,
  evaluateSpecification,
  example,
  examples,
  implement,
  instant,
  object,
  string,
  sum,
} from "../src/index.js";

const 受付する = behavior({
  name: "受付する",
  input: sum("状態", { 申込済み: object({ 申込ID: string("申込ID") }) }),
  result: object({ 受付日時: instant() }),
  effects: sum("種類", {}),
  requires: { 現在時刻: dependency(instant()) },
});

const 今で受け付ける = implement(受付する, {
  cases: {
    申込済み: {
      kind: "decision",
      id: "今で受け付ける",
      run: (_, 依存) => ({ result: { 受付日時: 依存.現在時刻 }, effects: [] }),
    },
  },
});

describe("a value dependency", () => {
  it("is stood in for by the value a row writes with with", async () => {
    const 時刻 = Temporal.Instant.from("2026-10-01T09:00:00Z");
    const report = await evaluateSpecification(
      defineSpecification({
        name: "受付",
        examples: examples(受付する, [
          example(受付する, "今の時刻で受け付ける", {
            given: { 状態: "申込済み", 申込ID: "a-1" },
            with: { 現在時刻: 時刻 },
            expect: { result: { 受付日時: 時刻 }, effects: [] },
          }),
        ]),
        implementation: 今で受け付ける,
      }),
    );

    expect(report.failures).toStrictEqual([]);
  });

  it("reports a row that runs the model without standing in for a dependency it needs", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "受付",
        examples: examples(受付する, [
          example(受付する, "時刻を書き忘れた", {
            given: { 状態: "申込済み", 申込ID: "a-1" },
            expect: {
              result: { 受付日時: Temporal.Instant.from("2026-10-01T09:00:00Z") },
              effects: [],
            },
          }),
        ]),
        implementation: 今で受け付ける,
      }),
    );

    expect(report.failures).toStrictEqual([
      { name: "時刻を書き忘れた", message: "No stand-in for dependency 現在時刻" },
    ]);
  });
});
