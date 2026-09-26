import {
  action,
  behavior,
  spec,
  examples,
  guard,
  implement,
  int,
  object,
  variants,
} from "../../src/index.js";

const 受け付ける = behavior("受け付ける", {
  input: variants("状態", { 入力済み: object({ 数量: int() }) }),
  result: variants("結果", { 受付: object({}), 却下: object({}) }),
  effects: variants("種類", {}),
});

const 二段 = implement(受け付ける, {
  cases: {
    入力済み: action("二段", {
      guards: 入力 => [
        guard(入力.数量.$gte(10).$and(入力.数量.$gte(5)), () => ({
          result: { 結果: "却下" },
          effects: [],
        })),
      ],
      run: () => ({ result: { 結果: "受付" }, effects: [] }),
    }),
  },
});

export const 受付 = spec("受付", {
  examples: examples(受け付ける, {}),
  implementation: 二段,
});
