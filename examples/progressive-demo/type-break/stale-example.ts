import { example } from "../../../src/index.js";
import { 予約をキャンセルする } from "../stage-03-refined.spec.js";

export const 古い具体例 = example(
  予約をキャンセルする,
  "分割前の予約確定の具体例",
  {
    given: {
      状態: "予約確定",
      予約ID: "予約-旧",
      決済ID: "決済-旧",
    },
    expect: {
      result: { 結果: "受理", 予約ID: "予約-旧" },
      effects: [],
    },
  },
);
