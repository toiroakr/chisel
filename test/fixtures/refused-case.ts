import { behavior, ne, object, sum } from "../../src/index.js";

export const 注文を処理する = behavior({
  name: "注文を処理する",
  input: sum("状態", { 入力済み: object({}), 廃止: object({}) }).invariant(v => ne(v.状態, "廃止")),
  result: object({}),
  effects: sum("種類", {}),
});
