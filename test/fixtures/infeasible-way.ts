import {
  and,
  behavior,
  spec,
  examples,
  gte,
  guard,
  implement,
  int,
  object,
  rules,
  variants,
} from "../../src/index.js";

const 受け付ける = behavior({
  name: "受け付ける",
  input: variants("状態", { 入力済み: object({ 数量: int() }) }),
  result: variants("結果", { 受付: object({}), 却下: object({}) }),
  effects: variants("種類", {}),
});

const 二段 = implement(受け付ける, {
  cases: {
    入力済み: rules(
      "二段",
      入力 => [
        guard(and(gte(入力.数量, 10), gte(入力.数量, 5)), () => ({
          result: { 結果: "却下" },
          effects: [],
        })),
      ],
      () => ({ result: { 結果: "受付" }, effects: [] }),
    ),
  },
});

export const 受付 = spec({
  name: "受付",
  examples: examples(受け付ける, []),
  implementation: 二段,
});
