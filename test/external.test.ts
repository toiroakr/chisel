import { describe, expect, it } from "vitest";
import {
  action,
  behavior,
  check,
  compose,
  examples,
  external,
  implement,
  int,
  object,
  perform,
  spec,
  SpecificationError,
  string,
  variants,
} from "../src/index.js";

const 在庫を照会する = behavior("在庫を照会する", {
  input: variants("種別", { 商品: object({ 商品ID: string() }) }),
  result: variants("結果", { 在庫: object({ 在庫数: int() }) }),
  effects: variants("種類", {}),
});

const 在庫照会の実装 = external(在庫を照会する, "在庫サービスが答える");

const 在庫の例 = examples(在庫を照会する, {
  "商品Aは10個": {
    given: { 種別: "商品", 商品ID: "A" },
    expect: { result: { 結果: "在庫", 在庫数: 10 }, effects: [] },
  },
});

describe("an external implementation", () => {
  it("is not run, and says so instead of failing", async () => {
    const report = await check(spec("在庫", { examples: 在庫の例, implementation: 在庫照会の実装 }));

    expect({
      failures: report.failures,
      incompleteness: report.incompleteness,
      pending: report.pendingDecisions,
      verdict: report.verdict,
    }).toStrictEqual({
      failures: [],
      incompleteness: [
        {
          kind: "row not run",
          subject: "商品Aは10個",
          reason: "外部の段のため実行できない（在庫を照会する: 在庫サービスが答える）",
        },
      ],
      pending: [],
      verdict: "undetermined",
    });
  });

  it("cannot be performed", async () => {
    await expect(perform(在庫照会の実装, { 種別: "商品", 商品ID: "A" })).rejects.toThrow(
      new SpecificationError("在庫を照会する is implemented outside Chisel: 在庫サービスが答える"),
    );
  });

  it("leaves a composition it takes part in unrun and undetermined", async () => {
    const 在庫で判断する = behavior("在庫で判断する", {
      input: variants("結果", { 在庫: object({ 在庫数: int() }) }),
      result: variants("結果", { 注文可: object({}), 品切れ: object({}) }),
      effects: variants("種類", {}),
    });
    const 在庫で判断するの実装 = implement(在庫で判断する, {
      cases: {
        在庫: action("在庫数で分ける", {
          run: 在庫 => ({
            result: 在庫.在庫数 > 0 ? { 結果: "注文可" as const } : { 結果: "品切れ" as const },
            effects: [],
          }),
        }),
      },
    });
    const [注文できるか, 注文できるかの実装] = compose("注文できるか", [在庫照会の実装, 在庫で判断するの実装]);

    const report = await check(
      spec("注文可否", {
        examples: examples(注文できるか, {
          "在庫があれば注文可": {
            given: { 種別: "商品", 商品ID: "A" },
            expect: { result: { 結果: "注文可" }, effects: [] },
          },
          "在庫がなければ品切れ": {
            given: { 種別: "商品", 商品ID: "B" },
            expect: { result: { 結果: "品切れ" }, effects: [] },
          },
        }),
        implementation: 注文できるかの実装,
      }),
    );

    expect({ failures: report.failures, verdict: report.verdict, notRun: report.incompleteness.length }).toStrictEqual({
      failures: [],
      verdict: "undetermined",
      notRun: 2,
    });
  });
});
