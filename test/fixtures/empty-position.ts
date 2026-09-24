import { behavior, ge, integer, le, object, sum } from "../../src/index.js";

export const 数量を決める = behavior({
  name: "数量を決める",
  input: sum("状態", {
    入力済み: object({
      数量: integer()
        .invariant(v => ge(v, 10))
        .invariant(v => le(v, 5)),
    }),
  }),
  result: object({}),
  effects: sum("種類", {}),
});
