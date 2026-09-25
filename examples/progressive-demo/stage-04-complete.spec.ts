import * as c from "../../src/index.js";

const 予約ID = c.string("予約ID");
const 決済ID = c.string("決済ID");
const 宿泊開始日時 = c.instant();
const キャンセル要求日時 = c.instant();

const 予約 = c.variants("状態", {
  受付済み: c.object({ 予約ID }),
  予約確定: c.object({
    予約ID,
    決済ID,
    宿泊開始日時,
    キャンセル要求日時,
  }),
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
  dependsOn: ["返金", "部屋を解放"],
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
  "期限前なら返金してキャンセルする": {
    given: {
      状態: "予約確定",
      予約ID: "予約-2",
      決済ID: "決済-2",
      宿泊開始日時: Temporal.Instant.from("2026-10-10T15:00:00Z"),
      キャンセル要求日時: Temporal.Instant.from("2026-10-09T14:59:59Z"),
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
  "期限ちょうどなら返金してキャンセルする": {
    given: {
      状態: "予約確定",
      予約ID: "予約-3",
      決済ID: "決済-3",
      宿泊開始日時: Temporal.Instant.from("2026-10-10T15:00:00Z"),
      キャンセル要求日時: Temporal.Instant.from("2026-10-09T15:00:00Z"),
    },
    expect: {
      result: { 結果: "受理", 予約ID: "予約-3" },
      effects: [
        {
          種類: "返金",
          決済ID: "決済-3",
          冪等性キー: "キャンセル:予約-3:返金",
        },
        {
          種類: "部屋を解放",
          予約ID: "予約-3",
          冪等性キー: "キャンセル:予約-3:部屋を解放",
        },
      ],
    },
  },
  "期限後なら返金せずキャンセルする": {
    given: {
      状態: "予約確定",
      予約ID: "予約-4",
      決済ID: "決済-4",
      宿泊開始日時: Temporal.Instant.from("2026-10-10T15:00:00Z"),
      キャンセル要求日時: Temporal.Instant.from("2026-10-09T15:00:01Z"),
    },
    expect: {
      result: { 結果: "受理", 予約ID: "予約-4" },
      effects: [
        {
          種類: "部屋を解放",
          予約ID: "予約-4",
          冪等性キー: "キャンセル:予約-4:部屋を解放",
        },
      ],
    },
  },
  "チェックイン後は拒否する": {
    given: { 状態: "チェックイン済み", 予約ID: "予約-5" },
    expect: {
      result: { 結果: "拒否", 理由: "チェックイン済み" },
      effects: [],
    },
  },
  "キャンセル済みなら拒否する": {
    given: { 状態: "キャンセル済み", 予約ID: "予約-6" },
    expect: {
      result: { 結果: "拒否", 理由: "キャンセル済み" },
      effects: [],
    },
  },
});

const 実装 = c.implement(予約をキャンセルする, {
  cases: {
    受付済み: {
      kind: "decision",
      id: "受付済みをキャンセルする",
      run: 予約 => ({
        result: { 結果: "受理", 予約ID: 予約.予約ID },
        effects: [
          {
            種類: "部屋を解放",
            予約ID: 予約.予約ID,
            冪等性キー: `キャンセル:${予約.予約ID}:部屋を解放`,
          },
        ],
      }),
    },
    予約確定: {
      kind: "decision",
      id: "返金可否を計算してキャンセルする",
      run: 予約 => {
        const result = { 結果: "受理", 予約ID: 予約.予約ID } as const;
        const 部屋解放 = {
          種類: "部屋を解放",
          予約ID: 予約.予約ID,
          冪等性キー: `キャンセル:${予約.予約ID}:部屋を解放`,
        } as const;

        if (返金可能か(予約.宿泊開始日時, 予約.キャンセル要求日時)) {
          return {
            result,
            effects: [
              {
                種類: "返金",
                決済ID: 予約.決済ID,
                冪等性キー: `キャンセル:${予約.予約ID}:返金`,
              },
              部屋解放,
            ],
          };
        }

        return { result, effects: [部屋解放] };
      },
    },
    チェックイン済み: {
      kind: "decision",
      id: "チェックイン後は拒否する",
      run: () => ({
        result: { 結果: "拒否", 理由: "チェックイン済み" },
        effects: [],
      }),
    },
    キャンセル済み: {
      kind: "decision",
      id: "再キャンセルを拒否する",
      run: () => ({
        result: { 結果: "拒否", 理由: "キャンセル済み" },
        effects: [],
      }),
    },
  },
  controls: {
    返金: {
      execution: "queue",
      idempotency: "required",
      compensation: "manual",
      exposure: "canary",
    },
    部屋を解放: {
      execution: "outbox",
      idempotency: "required",
      compensation: "automatic",
    },
  },
});

export const 完成した仕様 = c.spec("段階4: exampleを満たすmodelを実装する", {
  examples: 具体例,
  implementation: 実装,
});

function 返金可能か(
  宿泊開始日時: Temporal.Instant,
  キャンセル要求日時: Temporal.Instant,
): boolean {
  const 返金期限 = 宿泊開始日時.subtract({ hours: 24 });
  return Temporal.Instant.compare(キャンセル要求日時, 返金期限) <= 0;
}
