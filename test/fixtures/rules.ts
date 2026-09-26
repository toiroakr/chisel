import {
  action,
  array,
  behavior,
  spec,
  example,
  examples,
  guard,
  implement,
  int,
  object,
  string,
  variants,
} from "../../src/index.js";

const 注文を確定する = behavior("注文を確定する", {
  input: variants("状態", {
    商品あり: object({ 明細: array(object({ 数量: int(), 在庫数: int() })) }),
  }),
  result: variants("結果", { 確定: object({}), 不可: object({ 理由: string() }) }),
  effects: variants("種類", {}),
});

const 在庫を確かめる = implement(注文を確定する, {
  cases: {
    商品あり: action("在庫を確かめる", {
      guards: カート => [
        guard(カート.明細.$all(明細 => 明細.数量.$lte(明細.在庫数)), () => ({
          result: { 結果: "不可", 理由: "在庫不足" },
          effects: [],
        })),
      ],
      run: () => ({ result: { 結果: "確定" }, effects: [] }),
    }),
  },
});

export const 注文確定 = spec("注文確定", {
  examples: examples(注文を確定する, {
    "ちょうど在庫分": {
      given: { 状態: "商品あり", 明細: [{ 数量: 3, 在庫数: 3 }] },
      expect: { result: { 結果: "確定" }, effects: [] },
    },
  }),
  implementation: 在庫を確かめる,
});
