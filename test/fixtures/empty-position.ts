import { behavior, gte, int, lte, object, sum } from "../../src/index.js";

export const 数量を決める = behavior({
  name: "数量を決める",
  input: sum("状態", {
    入力済み: object({
      数量: int()
        .invariant(v => gte(v, 10))
        .invariant(v => lte(v, 5)),
    }),
  }),
  result: object({}),
  effects: sum("種類", {}),
});
