import {
  behavior,
  boolean,
  spec,
  eq,
  example,
  examples,
  gte,
  int,
  object,
  variants,
} from "../../src/index.js";

const 数量を確定する = behavior("数量を確定する", {
  input: variants("状態", {
    入力済み: object({
      数量: int().invariant(v => gte(v, 1)),
      同意: boolean().invariant(v => eq(v, true)),
    }),
  }),
  result: object({}),
  effects: variants("種類", {}),
});

export const 数量確定 = spec("数量確定", {
  examples: examples(数量を確定する, {
    "数量1": {
      given: { 状態: "入力済み", 数量: 1, 同意: true },
      expect: { result: {}, effects: [] },
    },
  }),
});
