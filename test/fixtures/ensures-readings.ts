import { behavior, eq, gte, int, object, string, sum } from "../../src/index.js";

export const 見積もる = behavior({
  name: "見積もる",
  input: sum("状態", { 入力済み: object({ 数量: int(), 商品ID: string("商品ID") }) }),
  result: sum("結果", {
    見積: object({ 数量: int(), 商品ID: string("商品ID") }),
    保留: object({}),
  }),
  effects: sum("種類", {}),
  ensures: clause => [
    clause.when("入力を写す", ["見積"], (入力, 答え) => gte(答え.数量, 入力.数量)),
    clause.when("商品は同じ", ["見積"], (入力, 答え) => eq(答え.商品ID, 入力.商品ID)),
  ],
});
