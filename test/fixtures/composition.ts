import {
  behavior,
  compose,
  defineSpecification,
  example,
  examples,
  ge,
  guard,
  implement,
  implementComposition,
  integer,
  object,
  rules,
  string,
  sum,
} from "../../src/index.js";

const 検証する = behavior({
  name: "検証する",
  input: sum("状態", { 申込: object({ 数量: integer() }) }),
  result: sum("結果", { 有効: object({ 数量: integer() }), 無効: object({ 理由: string("理由") }) }),
  effects: sum("種類", {}),
});

const 価格を付ける = behavior({
  name: "価格を付ける",
  input: sum("結果", { 有効: object({ 数量: integer() }) }),
  result: sum("結果", { 見積: object({ 金額: integer() }) }),
  effects: sum("種類", {}),
});

export const 見積もる = compose(検証する, 価格を付ける);

export const 見積 = defineSpecification({
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
        申込: rules(
          "数量を確かめる",
          申込 => [
            guard(ge(申込.数量, 1), () => ({ result: { 結果: "無効", 理由: "数量なし" }, effects: [] })),
          ],
          申込 => ({ result: { 結果: "有効", 数量: 申込.数量 }, effects: [] }),
        ),
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
