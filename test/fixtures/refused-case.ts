import { behavior, object, variants } from "../../src/index.js";

export const 注文を処理する = behavior("注文を処理する", {
  input: variants("状態", { 入力済み: object({}), 廃止: object({}) }).refine(v => v.状態.$ne("廃止")),
  result: object({}),
  effects: variants("種類", {}),
});
