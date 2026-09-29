import { describe, expect, it } from "vitest";
import { behavior, int, object, string, variants } from "../src/index.js";

describe("describe", () => {
  it("says what a value means without changing what it takes", () => {
    const 合計 = int().min(0).describe("明細の合計金額（円）");

    expect(合計.description).toBe("明細の合計金額（円）");
    expect(合計.parse(-1).success).toBe(false);
    expect(合計.parse(1200)).toStrictEqual({ success: true, value: 1200 });
  });

  it("is kept by a rule written after it, and replaced by a later description", () => {
    const 金額 = int().describe("金額").min(1);

    expect(金額.description).toBe("金額");
    expect(金額.parse(0).success).toBe(false);
    expect(金額.describe("立て替えた金額").description).toBe("立て替えた金額");
  });

  it("is carried by an optional field", () => {
    expect(string().describe("差し戻しの理由").optional().description).toBe("差し戻しの理由");
    expect(string().optional().describe("メモ").description).toBe("メモ");
    expect(string().optional().description).toBeUndefined();
  });

  it("names each case of a sum", () => {
    const 報告書 = variants("状態", {
      下書き: object({ 申請者: string() }).describe("まだ申請していない"),
      申請中: object({ 申請者: string() }).describe("承認を待っている"),
    }).describe("経費報告書");

    expect(報告書.description).toBe("経費報告書");
    expect(Object.values(報告書.variants).map(each => each.description)).toStrictEqual([
      "まだ申請していない",
      "承認を待っている",
    ]);
  });
});

describe("a behavior's description", () => {
  const 入力 = variants("状態", { 申請中: object({}) });
  const 結果 = variants("結果", { 承認した: object({}) });
  const 作用 = variants("種類", {});

  it("says what it does", () => {
    const 承認する = behavior("approve", { description: "申請中の報告書を承認する", input: 入力, result: 結果, effects: 作用 });

    expect(承認する.description).toBe("申請中の報告書を承認する");
  });

  it("is left out when none is given", () => {
    const 承認する = behavior("approve", { input: 入力, result: 結果, effects: 作用 });

    expect("description" in 承認する).toBe(false);
  });
});
