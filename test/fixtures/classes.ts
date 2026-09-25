import {
  behavior,
  spec,
  example,
  examples,
  implement,
  object,
  string,
  variants,
} from "../../src/index.js";

const 注文を確定する = behavior("注文を確定する", {
  input: variants("状態", {
    商品あり: object({
      カートID: string(),
      クーポン: string().optional(),
    }),
  }),
  result: variants("結果", { 確定: object({ カートID: string() }) }),
  effects: variants("種類", { 決済要求: object({ カートID: string() }) }),
});

export const 注文確定 = spec("注文確定", {
  examples: examples(注文を確定する, {
    "クーポンなしで確定する": {
      given: { 状態: "商品あり", カートID: "c-1" },
      expect: {
        result: { 結果: "確定", カートID: "c-1" },
        effects: [{ 種類: "決済要求", カートID: "c-1" }],
      },
    },
  }),
  implementation: implement(注文を確定する, {
    cases: {
      商品あり: {
        kind: "decision",
        id: "確定する",
        run: cart => ({
          result: { 結果: "確定", カートID: cart.カートID },
          effects: [{ 種類: "決済要求", カートID: cart.カートID }],
        }),
      },
    },
    controls: {
      決済要求: { execution: "queue", idempotency: "required", compensation: "manual" },
    },
  }),
});
