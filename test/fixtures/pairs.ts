import { behavior, boolean, spec, example, examples, object, variants } from "../../src/index.js";

const 送る = behavior("送る", {
  input: variants("状態", { 入力済み: object({ ギフト: boolean(), 速達: boolean() }) }),
  result: object({}),
  effects: variants("種類", {}),
});

export const 送付 = spec("送付", {
  examples: examples(送る, {
    "ギフトを速達で": {
      given: { 状態: "入力済み", ギフト: true, 速達: true },
      expect: { result: {}, effects: [] },
    },
  }),
});
