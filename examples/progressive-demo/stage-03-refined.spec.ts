import {
  behavior,
  defineSpecification,
  example,
  examples,
  instant,
  object,
  string,
  sum,
} from "../../src/index.js";

const 予約ID = string("予約ID");
const 決済ID = string("決済ID");
const 宿泊開始日時 = instant();
const キャンセル要求日時 = instant();

const 予約 = sum("状態", {
  受付済み: object({ 予約ID }),
  予約確定: object({
    予約ID,
    決済ID,
    宿泊開始日時,
    キャンセル要求日時,
  }),
  チェックイン済み: object({ 予約ID }),
  キャンセル済み: object({ 予約ID }),
});

const キャンセル結果 = sum("結果", {
  受理: object({ 予約ID }),
  拒否: object({ 理由: string("キャンセル拒否理由") }),
});

const キャンセル作用 = sum("種類", {
  返金: object({
    決済ID,
    冪等性キー: string("冪等性キー"),
  }),
  部屋を解放: object({
    予約ID,
    冪等性キー: string("冪等性キー"),
  }),
});

export const 予約をキャンセルする = behavior({
  name: "予約をキャンセルする",
  input: 予約,
  result: キャンセル結果,
  effects: キャンセル作用,
  dependsOn: ["返金", "部屋を解放"],
});

const 具体例 = examples(予約をキャンセルする, [
  example(予約をキャンセルする, "受付済みの予約をキャンセルする", {
    given: { 状態: "受付済み", 予約ID: "予約-1" },
    expect: {
      result: { 結果: "受理", 予約ID: "予約-1" },
      effects: [
        {
          種類: "部屋を解放",
          予約ID: "予約-1",
          冪等性キー: "キャンセル:予約-1:部屋を解放",
        },
      ],
    },
  }),
  example(予約をキャンセルする, "チェックイン後は拒否する", {
    given: { 状態: "チェックイン済み", 予約ID: "予約-3" },
    expect: {
      result: { 結果: "拒否", 理由: "チェックイン済み" },
      effects: [],
    },
  }),
  example(予約をキャンセルする, "キャンセル済みなら拒否する", {
    given: { 状態: "キャンセル済み", 予約ID: "予約-4" },
    expect: {
      result: { 結果: "拒否", 理由: "キャンセル済み" },
      effects: [],
    },
  }),
]);

export const 詳細化した仕様 = defineSpecification({
  name: "段階3: dataとbehaviorを詳細化する",
  examples: 具体例,
});
