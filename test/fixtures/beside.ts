import { action, behavior, examples, implement, int, object, spec, variants } from "../../src/index.js";

const 判定する = behavior("判定する", {
  input: variants("状態", { 入力済み: object({ x: int(), y: int() }) }),
  result: variants("結果", { 真: object({}), 偽: object({}) }),
  effects: variants("種類", {}),
});
const 偽 = () => ({ result: { 結果: "偽" as const }, effects: [] });
const row = (x: number, y: number, answer: "真" | "偽") => ({
  given: { 状態: "入力済み" as const, x, y },
  expect: { result: { 結果: answer }, effects: [] },
});

export const 判定 = spec("判定", {
  examples: examples(判定する, {
    "(0, 0)": row(0, 0, "真"),
    "(0, 1)": row(0, 1, "偽"),
    "(0, -1)": row(0, -1, "真"),
    "(0, 3)": row(0, 3, "偽"),
  }),
  implementation: implement(判定する, {
    cases: {
      入力済み: action("倍まで", {
        guards: 入力 => [入力.y.$lte(入力.x.$plus(入力.x)).$else(偽)],
        run: () => ({ result: { 結果: "真" }, effects: [] }),
      }),
    },
  }),
});
