import {
  behavior,
  boolean,
  defineSpecification,
  eq,
  example,
  examples,
  ge,
  integer,
  object,
  sum,
} from "../../src/index.js";

const 数量を確定する = behavior({
  name: "数量を確定する",
  input: sum("状態", {
    入力済み: object({
      数量: integer().invariant(v => ge(v, 1)),
      同意: boolean().invariant(v => eq(v, true)),
    }),
  }),
  result: object({}),
  effects: sum("種類", {}),
});

export const 数量確定 = defineSpecification({
  name: "数量確定",
  examples: examples(数量を確定する, [
    example(数量を確定する, "数量1", {
      given: { 状態: "入力済み", 数量: 1, 同意: true },
      expect: { result: {}, effects: [] },
    }),
  ]),
});
