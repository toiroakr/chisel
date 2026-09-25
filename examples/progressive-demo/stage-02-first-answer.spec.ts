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

const 具体例 = c.examples(予約をキャンセルする, {
  "受付済みの予約をキャンセルする": {
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
  },
  "予約確定後に返金してキャンセルする": {
    given: {
      状態: "予約確定",
      予約ID: "予約-2",
      決済ID: "決済-2",
    },
    expect: {
      result: { 結果: "受理", 予約ID: "予約-2" },
      effects: [
        {
          種類: "返金",
          決済ID: "決済-2",
          冪等性キー: "キャンセル:予約-2:返金",
        },
        {
          種類: "部屋を解放",
          予約ID: "予約-2",
          冪等性キー: "キャンセル:予約-2:部屋を解放",
        },
      ],
    },
  },
  "チェックイン後は拒否する": {
    given: { 状態: "チェックイン済み", 予約ID: "予約-3" },
    expect: {
      result: { 結果: "拒否", 理由: "チェックイン済み" },
      effects: [],
    },
  },
  "キャンセル済みなら拒否する": {
    given: { 状態: "キャンセル済み", 予約ID: "予約-4" },
    expect: {
      result: { 結果: "拒否", 理由: "キャンセル済み" },
      effects: [],
    },
  },
});

export const 最初の回答 = c.spec("段階2: 人間が期待値を埋める", {
  examples: 具体例,
});
