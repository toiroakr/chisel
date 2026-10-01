import {
  action,
  behavior,
  boolean,
  enum as enumOf,
  implement,
  object,
  variants,
  spec,
  examples,
} from "../../src/index.js";

const 判定する = behavior("判定する", {
  input: variants("状態", { 入力済み: object({ 甲: enumOf(["w", "x"]), 乙: boolean() }) }),
  result: object({}),
  effects: variants("種類", {}),
});

const 両方そろえば受け付ける = implement(判定する, {
  cases: {
    入力済み: action("両方そろえば", {
      guards: 入力 => [
        入力.甲.$eq("x").$and(入力.乙.$eq(true)).$else(() => ({ result: {}, effects: [] })),
      ],
      run: () => ({ result: {}, effects: [] }),
    }),
  },
});

export const 判定 = spec("判定", {
  examples: examples(判定する, {}),
  implementation: 両方そろえば受け付ける,
});
