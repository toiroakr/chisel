import { describe, expect, it } from "vitest";
import {
  defineSpecification,
  evaluateSpecification,
  examples,
  generateExamples,
} from "../src/index.js";
import { 予約をキャンセルする as 段階1の振る舞い } from "../examples/progressive-demo/stage-01-sketch.spec.js";
import { 最初の回答 } from "../examples/progressive-demo/stage-02-first-answer.spec.js";
import { 詳細化した仕様 } from "../examples/progressive-demo/stage-03-refined.spec.js";
import {
  完成した仕様,
  予約をキャンセルする as 完成した振る舞い,
} from "../examples/progressive-demo/stage-04-complete.spec.js";

describe("progressive specification demo", () => {
  it("moves from explicit gaps to an accepted specification", async () => {
    const 段階1のスケッチ = defineSpecification({
      name: "段階1",
      examples: examples(段階1の振る舞い, []),
    });
    const 段階1 = await evaluateSpecification(段階1のスケッチ);
    const 段階2 = await evaluateSpecification(最初の回答);
    const 段階3 = await evaluateSpecification(詳細化した仕様);
    const 段階4 = await evaluateSpecification(完成した仕様);

    expect(段階1.adequate).toBe(false);
    expect(段階1.input.missing).toStrictEqual([
      "受付済み",
      "予約確定",
      "チェックイン済み",
      "キャンセル済み",
    ]);
    expect(generateExamples(段階1の振る舞い).map(row => row.given)).toStrictEqual([
      { 状態: "受付済み", 予約ID: "<予約ID>" },
      {
        状態: "予約確定",
        予約ID: "<予約ID>",
        決済ID: "<決済ID>",
      },
      { 状態: "チェックイン済み", 予約ID: "<予約ID>" },
      { 状態: "キャンセル済み", 予約ID: "<予約ID>" },
    ]);

    expect(段階2.adequate).toBe(false);
    expect(段階2.input.missing).toStrictEqual([]);
    expect(段階2.implementation).toBe("missing");

    expect(段階3.adequate).toBe(false);
    expect(段階3.input.missing).toStrictEqual(["予約確定"]);
    expect(段階3.implementation).toBe("missing");

    expect(段階4.adequate).toBe(true);
    expect(段階4.verdict).toBe("undetermined");
  });

  it("derives refund eligibility from timestamps at the 24-hour boundary", () => {
    const 予約確定の具体例 = 完成した仕様.examples.rows.filter(
      row => (row.given as { readonly 状態: string }).状態 === "予約確定",
    );

    expect(予約確定の具体例.map(row => {
        const given = row.given as {
          readonly 状態: "予約確定";
          readonly 予約ID: string;
          readonly 決済ID: string;
          readonly 宿泊開始日時: Temporal.Instant;
          readonly キャンセル要求日時: Temporal.Instant;
        };
        return {
          ...given,
          宿泊開始日時: given.宿泊開始日時.toString(),
          キャンセル要求日時: given.キャンセル要求日時.toString(),
        };
      })).toStrictEqual([
        {
          状態: "予約確定",
          予約ID: "予約-2",
          決済ID: "決済-2",
          宿泊開始日時: "2026-10-10T15:00:00Z",
          キャンセル要求日時: "2026-10-09T14:59:59Z",
        },
        {
          状態: "予約確定",
          予約ID: "予約-3",
          決済ID: "決済-3",
          宿泊開始日時: "2026-10-10T15:00:00Z",
          キャンセル要求日時: "2026-10-09T15:00:00Z",
        },
        {
          状態: "予約確定",
          予約ID: "予約-4",
          決済ID: "決済-4",
          宿泊開始日時: "2026-10-10T15:00:00Z",
          キャンセル要求日時: "2026-10-09T15:00:01Z",
        },
      ]);
    expect(予約確定の具体例.map(row =>
        "effects" in row.expect
          ? row.expect.effects.map(effect => effect.種類)
          : [],
      )).toStrictEqual([
        ["返金", "部屋を解放"],
        ["返金", "部屋を解放"],
        ["部屋を解放"],
      ]);
  });

  it("accepts Temporal.Instant timestamps and rejects strings", () => {
    const valid = 完成した振る舞い.input.parse({
      状態: "予約確定",
      予約ID: "予約-日時",
      決済ID: "決済-日時",
      宿泊開始日時: Temporal.Instant.from("2026-10-10T15:00:00Z"),
      キャンセル要求日時: Temporal.Instant.from("2026-10-09T15:00:00Z"),
    });
    const invalid = 完成した振る舞い.input.parse({
      状態: "予約確定",
      予約ID: "予約-文字列",
      決済ID: "決済-文字列",
      宿泊開始日時: "2026-10-10T15:00:00Z",
      キャンセル要求日時: "2026-10-09T15:00:00Z",
    });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });
});
