import {
  all,
  array,
  behavior,
  defineSpecification,
  example,
  examples,
  ge,
  guard,
  implement,
  integer,
  le,
  length,
  number,
  object,
  optional,
  rules,
  string,
  sum,
} from "../../src/index.js";

const カートID = string("カートID");
const 商品ID = string("商品ID");
const クーポンコード = string("クーポンコード");

const 明細 = object({
  商品ID,
  数量: integer().invariant(v => ge(v, 1)),
  単価: integer().invariant(v => ge(v, 0)),
  在庫数: integer().invariant(v => ge(v, 0)),
});

const カート = sum("状態", {
  空: object({ カートID }),
  商品あり: object({
    カートID,
    明細: array(明細).invariant(v => ge(length(v), 1)),
    クーポン: optional(クーポンコード),
  }),
  確定済み: object({ カートID }),
});

const 確定結果 = sum("結果", {
  確定: object({ カートID, 合計金額: number() }),
  不可: object({ 理由: string("確定不可理由") }),
});

const 確定作用 = sum("種類", {
  在庫引当: object({ 商品ID, 数量: number() }),
  決済要求: object({ カートID, 金額: number() }),
  クーポン消費: object({ クーポンコード }),
});

export const 注文を確定する = behavior({
  name: "注文を確定する",
  input: カート,
  result: 確定結果,
  effects: 確定作用,
  dependsOn: ["在庫引当", "決済要求", "クーポン消費"],
});

const 具体例 = examples(注文を確定する, [
  example(注文を確定する, "空のカートは確定できない", {
    given: { 状態: "空", カートID: "カート-1" },
    expect: {
      result: { 結果: "不可", 理由: "カートが空" },
      effects: [],
    },
  }),
  example(注文を確定する, "在庫が足りれば明細ごとに在庫を引き当ててから決済する", {
    given: {
      状態: "商品あり",
      カートID: "カート-2",
      明細: [
        { 商品ID: "商品-A", 数量: 2, 単価: 500, 在庫数: 10 },
        { 商品ID: "商品-B", 数量: 1, 単価: 1500, 在庫数: 3 },
      ],
    },
    expect: {
      result: { 結果: "確定", カートID: "カート-2", 合計金額: 2500 },
      effects: [
        { 種類: "在庫引当", 商品ID: "商品-A", 数量: 2 },
        { 種類: "在庫引当", 商品ID: "商品-B", 数量: 1 },
        { 種類: "決済要求", カートID: "カート-2", 金額: 2500 },
      ],
    },
  }),
  example(注文を確定する, "在庫が足りない明細が1件でもあれば確定しない", {
    given: {
      状態: "商品あり",
      カートID: "カート-3",
      明細: [
        { 商品ID: "商品-A", 数量: 2, 単価: 500, 在庫数: 10 },
        { 商品ID: "商品-B", 数量: 4, 単価: 1500, 在庫数: 3 },
      ],
    },
    expect: {
      result: { 結果: "不可", 理由: "在庫不足" },
      effects: [],
    },
  }),
  example(注文を確定する, "確定済みのカートは二重に確定できない", {
    given: { 状態: "確定済み", カートID: "カート-3" },
    expect: {
      result: { 結果: "不可", 理由: "確定済み" },
      effects: [],
    },
  }),
]);

const 実装 = implement(注文を確定する, {
  cases: {
    空: rules(
      "空のカートは確定しない",
      () => [],
      () => ({ result: { 結果: "不可", 理由: "カートが空" }, effects: [] }),
    ),
    商品あり: rules(
      "在庫を確かめて確定する",
      カート => [
        guard(all(カート.明細, 明細 => le(明細.数量, 明細.在庫数)), () => ({
          result: { 結果: "不可", 理由: "在庫不足" },
          effects: [],
        })),
      ],
      カート => {
        const 合計金額 = カート.明細.reduce((合計, 明細) => 合計 + 明細.数量 * 明細.単価, 0);
        return {
          result: { 結果: "確定", カートID: カート.カートID, 合計金額 },
          effects: [
            ...カート.明細.map(明細 => ({
              種類: "在庫引当" as const,
              商品ID: 明細.商品ID,
              数量: 明細.数量,
            })),
            { 種類: "決済要求", カートID: カート.カートID, 金額: 合計金額 },
          ],
        };
      },
    ),
    確定済み: rules(
      "確定済みは二重に確定しない",
      () => [],
      () => ({ result: { 結果: "不可", 理由: "確定済み" }, effects: [] }),
    ),
  },
  controls: {
    在庫引当: { execution: "outbox", idempotency: "required", compensation: "automatic" },
    決済要求: { execution: "queue", idempotency: "required", compensation: "manual" },
    クーポン消費: { execution: "outbox", idempotency: "required", compensation: "automatic" },
  },
});

export const 注文確定の仕様 = defineSpecification({
  name: "注文確定",
  examples: 具体例,
  implementation: 実装,
});
