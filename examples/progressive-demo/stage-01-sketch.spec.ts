import * as c from "../../src/index.js";

const 予約ID = c.string("予約ID");
const 決済ID = c.string("決済ID");

const 予約 = c.variants("状態", {
  受付済み: c.object({ 予約ID }),
  予約確定: c.object({ 予約ID, 決済ID }),
  チェックイン済み: c.object({ 予約ID }),
  キャンセル済み: c.object({ 予約ID }),
});

const キャンセル結果 = c.variants("結果", {
  受理: c.object({ 予約ID }),
  拒否: c.object({ 理由: c.string("キャンセル拒否理由") }),
});

const キャンセル作用 = c.variants("種類", {
  返金: c.object({
    決済ID,
    冪等性キー: c.string("冪等性キー"),
  }),
  部屋を解放: c.object({
    予約ID,
    冪等性キー: c.string("冪等性キー"),
  }),
});

export const 予約をキャンセルする = c.behavior("予約をキャンセルする", {
  input: 予約,
  result: キャンセル結果,
  effects: キャンセル作用,
});
