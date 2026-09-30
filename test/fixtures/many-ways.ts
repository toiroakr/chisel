import { action, behavior, enum as enumOf, examples, implement, int, object, spec, variants } from "../../src/index.js";

const 数える = behavior("数える", {
  input: variants("状態", { 入力済み: object({ 数: int(), 甲: enumOf(["w", "x"]), 乙: enumOf(["w", "x"]) }) }),
  result: object({}),
  effects: variants("種類", {}),
});

const 却下 = () => ({ result: {}, effects: [] });

const 多い = implement(数える, {
  cases: {
    入力済み: action("多い", {
      guards: v => [
        v.数.$gte(1).$or(v.甲.$eq("w")).$or(v.乙.$eq("w")).$else(却下),
        v.数.$gte(2).$or(v.甲.$eq("x")).$or(v.乙.$eq("x")).$else(却下),
      ],
      run: () => ({ result: {}, effects: [] }),
    }),
  },
});

export const 多さ = spec("多さ", { examples: examples(数える, {}), implementation: 多い });
