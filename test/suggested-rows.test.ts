import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const 在庫を照会する = c.behavior("在庫を照会する", {
  input: c.variants("種別", { 商品: c.object({ 商品ID: c.string() }) }),
  result: c.object({ 在庫数: c.int().min(0) }),
  effects: c.variants("種類", {}),
});
const 在庫照会の例 = c.examples(在庫を照会する, {
  "商品-Bは0個": { given: { 種別: "商品", 商品ID: "商品-B" }, expect: { result: { 在庫数: 0 }, effects: [] } },
  "商品-Cは5個": { given: { 種別: "商品", 商品ID: "商品-C" }, expect: { result: { 在庫数: 5 }, effects: [] } },
});
const 注文する = c.behavior("注文する", {
  input: c.variants("状態", { 入力済み: c.object({ 商品ID: c.string() }) }),
  result: c.boolean(),
  effects: c.variants("種類", {}),
  dependencies: { 在庫: c.dependency(在庫照会の例) },
});
const 在庫で決める = c.implement(注文する, {
  cases: {
    入力済み: c.model("在庫で決める", (注文, 依存) => ({
      result: c.bind(在庫を照会する.result, c.call(依存.在庫, { 種別: "商品", 商品ID: 注文.商品ID }), 答え => c.choose(答え.在庫数.$gt(0), true, false)),
      effects: [],
    })),
  },
});

describe("rows suggested from a called behavior's recorded rows", () => {
  it("offers the inputs its rows were written with, asked in the caller, as owing nothing", () => {
    const rows = c.examples(注文する, {
      "商品-A": { given: { 状態: "入力済み", 商品ID: "商品-A" }, expect: { result: true, effects: [] } },
    });
    const { rows: generated } = c.generate(rows, 在庫で決める);

    expect(generated.filter(row => row.suggested === true).map(row => [row.name, row.given, row.reason])).toStrictEqual([
      ["注文する: 在庫()の記録行「商品-Bは0個」の入力を尋ねる", { 状態: "入力済み", 商品ID: "商品-B" }, "提案する入力（満たしていない義務はない）"],
      ["注文する: 在庫()の記録行「商品-Cは5個」の入力を尋ねる", { 状態: "入力済み", 商品ID: "商品-C" }, "提案する入力（満たしていない義務はない）"],
    ]);
  });

  it("does not suggest an input a row already asks", () => {
    const rows = c.examples(注文する, {
      "商品-B": { given: { 状態: "入力済み", 商品ID: "商品-B" }, expect: { result: false, effects: [] } },
    });
    const { rows: generated } = c.generate(rows, 在庫で決める);

    expect(generated.filter(row => row.suggested === true).map(row => row.given)).toStrictEqual([{ 状態: "入力済み", 商品ID: "商品-C" }]);
  });
});
