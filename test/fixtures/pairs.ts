import { behavior, boolean, defineSpecification, example, examples, object, sum } from "../../src/index.js";

const 送る = behavior({
  name: "送る",
  input: sum("状態", { 入力済み: object({ ギフト: boolean(), 速達: boolean() }) }),
  result: object({}),
  effects: sum("種類", {}),
});

export const 送付 = defineSpecification({
  name: "送付",
  examples: examples(送る, [
    example(送る, "ギフトを速達で", {
      given: { 状態: "入力済み", ギフト: true, 速達: true },
      expect: { result: {}, effects: [] },
    }),
  ]),
});
