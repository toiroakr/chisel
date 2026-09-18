import { behavior, object, string, sum } from "../../src/index.js";

const 予約ID = string("予約ID");
const 決済ID = string("決済ID");

const 予約 = sum("状態", {
  受付済み: object({ 予約ID }),
  予約確定: object({ 予約ID, 決済ID }),
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
