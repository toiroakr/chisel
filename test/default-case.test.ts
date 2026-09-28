import { describe, expect, it } from "vitest";
import {
  action,
  behavior,
  check,
  examples,
  implement,
  int,
  object,
  perform,
  spec,
  string,
  todo,
  variants,
} from "../src/index.js";

const 承認する = behavior("承認する", {
  input: variants("状態", {
    下書き: object({ ID: string() }),
    提出済み: object({ ID: string(), 金額: int() }),
    承認済み: object({ ID: string() }),
  }),
  result: variants("結果", { 承認: object({}), 却下: object({ 理由: string() }) }),
  effects: variants("種類", {}),
});

const 却下 = (理由: string) => () => ({ result: { 結果: "却下" as const, 理由 }, effects: [] });

const 提出済みだけ承認する = implement(承認する, {
  cases: {
    提出済み: action("上限内なら承認", {
      guards: r => [r.金額.$lte(100).$else(却下("上限超過"))],
      run: () => ({ result: { 結果: "承認" }, effects: [] }),
    }),
    $default: action("提出済みでなければ却下", { run: 却下("未提出") }),
  },
});

describe("cases.$default", () => {
  it("answers every case cases leaves out with $default", async () => {
    expect(await perform(提出済みだけ承認する, { 状態: "承認済み", ID: "R-1" })).toStrictEqual({
      result: { 結果: "却下", 理由: "未提出" },
      effects: [],
    });
  });

  it("answers a written case with its own decision rather than $default", async () => {
    expect(await perform(提出済みだけ承認する, { 状態: "提出済み", ID: "R-1", 金額: 50 })).toStrictEqual({
      result: { 結果: "承認" },
      effects: [],
    });
  });

  it("refuses $default beside cases that already decide every case", () => {
    expect(() =>
      implement(承認する, {
        cases: {
          下書き: todo(),
          提出済み: todo(),
          承認済み: todo(),
          $default: todo(),
        },
      }),
    ).toThrow("$default of 承認する decides no case");
  });

  it("lists each case a todo $default leaves open among the pending decisions", async () => {
    const report = await check(
      spec("承認", {
        examples: examples(承認する, {}),
        implementation: implement(承認する, {
          cases: { 提出済み: todo("上限を決める"), $default: todo("却下の理由を決める") },
        }),
      }),
    );

    expect(report.pendingDecisions).toStrictEqual([
      { variant: "下書き", reason: "却下の理由を決める" },
      { variant: "提出済み", reason: "上限を決める" },
      { variant: "承認済み", reason: "却下の理由を決める" },
    ]);
  });

  it("measures the arms of $default once however many cases it decides", async () => {
    const 分岐する既定 = implement(承認する, {
      cases: {
        提出済み: action("承認", { run: () => ({ result: { 結果: "承認" }, effects: [] }) }),
        $default: action("IDで分ける", {
          guards: r => [r.ID.$ne("").$else(却下("IDなし"))],
          run: 却下("未提出"),
        }),
      },
    });
    const report = await check(
      spec("承認", {
        examples: examples(承認する, {
          下書き: { given: { 状態: "下書き", ID: "R-1" }, expect: { result: { 結果: "却下", 理由: "未提出" }, effects: [] } },
        }),
        implementation: 分岐する既定,
      }),
    );

    expect(
      report.measures.arms.status === "complete"
        ? report.measures.arms.arms.map(arm => [arm.decision, arm.arm, arm.status])
        : report.measures.arms,
    ).toStrictEqual([
      ["IDで分ける", "holds", "met"],
      ["IDで分ける", "else", "gap"],
    ]);
  });

  it("still owes a row for each case $default decides", async () => {
    const report = await check(
      spec("承認", { examples: examples(承認する, {}), implementation: 提出済みだけ承認する }),
    );

    expect(report.input.missing).toStrictEqual(["下書き", "提出済み", "承認済み"]);
  });
});
