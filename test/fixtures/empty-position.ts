import { behavior, gte, int, lte, object, variants } from "../../src/index.js";

export const 数量を決める = behavior("数量を決める", {
  input: variants("状態", {
    入力済み: object({
      数量: int()
        .invariant(v => gte(v, 10))
        .invariant(v => lte(v, 5)),
    }),
  }),
  result: object({}),
  effects: variants("種類", {}),
});
