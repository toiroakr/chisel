import {
  action,
  behavior,
  implement,
  object,
  string,
  variants,
  spec,
  examples,
} from "../../src/index.js";

const 並べる = behavior("並べる", {
  input: variants("状態", { 入力済み: object({ 姓: string(), 名: string() }) }),
  result: object({}),
  effects: variants("種類", {}),
});

const 名前順 = implement(並べる, {
  cases: {
    入力済み: action("並び", {
      guards: 入力 => [入力.姓.$lt(入力.名).$else(() => ({ result: {}, effects: [] }))],
      run: () => ({ result: {}, effects: [] }),
    }),
  },
});

export const 並び = spec("並び", {
  examples: examples(並べる, {}),
  implementation: 名前順,
});
