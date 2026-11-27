import * as c from "../../src/index.js";

const 割る = c.behavior("割る", {
  input: c.variants("種別", { 入力済み: c.object({ 合計: c.int().min(0).max(10) }) }),
  result: c.rational(),
  effects: c.variants("種類", {}),
  dependencies: { 人数: c.dependency(c.int().min(0).max(3)) },
});

export const 平均 = c.spec("平均", {
  examples: c.examples(割る, {}),
  implementation: c.implement(割る, {
    cases: { 入力済み: c.model("平均を出す", (入力, 依存) => ({ result: c.quotient(入力.合計, 依存.人数), effects: [] })) },
  }),
});
