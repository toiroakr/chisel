import { behavior, int, object, variants } from "../../src/index.js";

export const 数量を決める = behavior("数量を決める", {
  input: variants("状態", {
    入力済み: object({
      数量: int()
        .refine(v => v.gte(10))
        .refine(v => v.lte(5)),
    }),
  }),
  result: object({}),
  effects: variants("種類", {}),
});
