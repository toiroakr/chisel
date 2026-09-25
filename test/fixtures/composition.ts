import {
  action,
  behavior,
  compose,
  spec,
  example,
  examples,
  gte,
  guard,
  implement,
  implementComposition,
  int,
  object,
  string,
  variants,
} from "../../src/index.js";

const 検証する = behavior({
  name: "検証する",
  input: variants("状態", { 申込: object({ 数量: int() }) }),
  result: variants("結果", { 有効: object({ 数量: int() }), 無効: object({ 理由: string("理由") }) }),
  effects: variants("種類", {}),
});

const 価格を付ける = behavior({
  name: "価格を付ける",
  input: variants("結果", { 有効: object({ 数量: int() }) }),
  result: variants("結果", { 見積: object({ 金額: int() }) }),
  effects: variants("種類", {}),
});

export const 見積もる = compose(検証する, 価格を付ける);

export const 見積 = spec({
  name: "見積",
  examples: examples(見積もる, [
    example(見積もる, "2個", {
      given: { 状態: "申込", 数量: 2 },
      expect: { result: { 結果: "見積", 金額: 200 }, effects: [] },
    }),
  ]),
  implementation: implementComposition(
    見積もる,
    implement(検証する, {
      cases: {
        申込: action("数量を確かめる", {
          guards: 申込 => [
            guard(gte(申込.数量, 1), () => ({ result: { 結果: "無効", 理由: "数量なし" }, effects: [] })),
          ],
          run: 申込 => ({ result: { 結果: "有効", 数量: 申込.数量 }, effects: [] }),
        }),
      },
    }),
    implement(価格を付ける, {
      cases: {
        有効: {
          kind: "decision",
          id: "単価100円",
          run: 有効 => ({ result: { 結果: "見積", 金額: 有効.数量 * 100 }, effects: [] }),
        },
      },
    }),
  ),
});
