import { action, behavior, boolean, examples, implement, object, spec, variants } from "../../src/index.js";

const 旗 = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`旗${index + 1}`, boolean()]));

const 受け付ける = behavior("受け付ける", {
  input: variants("状態", { 提出済み: object(旗) }),
  result: object({}),
  effects: variants("種類", {}),
  disregards: { 提出済み: r => [r] },
});

export const 受付 = spec("受付", {
  examples: examples(受け付ける, {
    全部倒れた: {
      given: {
        状態: "提出済み",
        ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`旗${index + 1}`, false])),
      } as never,
      expect: { result: {}, effects: [] },
    },
  }),
  implementation: implement(受け付ける, {
    cases: { 提出済み: action("受け付ける", { run: () => ({ result: {}, effects: [] }) }) },
  }),
});
