import { behavior, int, object, string, variants } from "../../src/index.js";

export const 見積もる = behavior("見積もる", {
  input: variants("状態", { 入力済み: object({ 数量: int(), 商品ID: string() }) }),
  result: variants("結果", {
    見積: object({ 数量: int(), 商品ID: string() }),
    保留: object({}),
  }),
  effects: variants("種類", {}),
  ensures: clause => [
    clause.when("入力を写す", ["見積"], (入力, 答え) => 答え.数量.$gte(入力.数量)),
    clause.when("商品は同じ", ["見積"], (入力, 答え) => 答え.商品ID.$eq(入力.商品ID)),
  ],
});
