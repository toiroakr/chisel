import { behavior, examples, external, int, object, spec, string, variants } from "../../src/index.js";

const 在庫を照会する = behavior("在庫を照会する", {
  input: variants("種別", { 商品: object({ 商品ID: string("商品ID") }) }),
  result: variants("結果", { 在庫: object({ 在庫数: int() }) }),
  effects: variants("種類", {}),
});

export const 在庫 = spec("在庫", {
  examples: examples(在庫を照会する, {
    "商品Aは10個": {
      given: { 種別: "商品", 商品ID: "A" },
      expect: { result: { 結果: "在庫", 在庫数: 10 }, effects: [] },
    },
  }),
  implementation: external(在庫を照会する, "在庫サービスが答える"),
});
