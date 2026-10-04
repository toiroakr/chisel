import { describe, expect, it } from "vitest";
import { 注文を確定する } from "../examples/cart-checkout/注文確定.spec.js";

describe("cart checkout numeric contracts", () => {
  it("rejects fractional yen in the confirmed total", () => {
    expect(注文を確定する.result.parse({
      結果: "確定", カートID: "cart-1", 合計金額: 2500.5,
    }).success).toBe(false);
  });

  it("rejects fractional pieces in stock allocation", () => {
    expect(注文を確定する.effects.parse({
      種類: "在庫引当", 商品ID: "product-1", 数量: 1.5,
    }).success).toBe(false);
  });

  it("rejects fractional yen in payment requests", () => {
    expect(注文を確定する.effects.parse({
      種類: "決済要求", カートID: "cart-1", 金額: 2500.5, 内訳: { "product-1": 2500 },
    }).success).toBe(false);
  });
});
