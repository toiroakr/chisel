import {
  behavior,
  guard,
  implement,
  lt,
  object,
  rules,
  string,
  sum,
  spec,
  examples,
} from "../../src/index.js";

const 並べる = behavior({
  name: "並べる",
  input: sum("状態", { 入力済み: object({ 姓: string("姓"), 名: string("名") }) }),
  result: object({}),
  effects: sum("種類", {}),
});

const 名前順 = implement(並べる, {
  cases: {
    入力済み: rules(
      "並び",
      入力 => [guard(lt(入力.姓, 入力.名), () => ({ result: {}, effects: [] }))],
      () => ({ result: {}, effects: [] }),
    ),
  },
});

export const 並び = spec({
  name: "並び",
  examples: examples(並べる, []),
  implementation: 名前順,
});
