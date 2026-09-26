import { describe, expect, it } from "vitest";
import {
  action,
  array,
  behavior,
  boolean,
  spec,
  dependency,
  check,
  example,
  examples,
  fake,
  generate,
  implement,
  match,
  perform,
  int,
  instant,
  object,
  string,
  variants,
} from "../src/index.js";

const 受付する = behavior("受付する", {
  input: variants("状態", { 申込済み: object({ 申込ID: string() }) }),
  result: object({ 受付日時: instant() }),
  effects: variants("種類", {}),
  requires: { 現在時刻: dependency(instant()) },
});

const 今で受け付ける = implement(受付する, {
  cases: {
    申込済み: {
      kind: "decision",
      id: "今で受け付ける",
      run: (_, 依存) => ({ result: { 受付日時: 依存.現在時刻 }, effects: [] }),
    },
  },
});

describe("a value dependency", () => {
  it("is stood in for by the value a row writes with with", async () => {
    const 時刻 = Temporal.Instant.from("2026-10-01T09:00:00Z");
    const report = await check(
      spec("受付", {
        examples: examples(受付する, {
          "今の時刻で受け付ける": {
            given: { 状態: "申込済み", 申込ID: "a-1" },
            with: { 現在時刻: 時刻 },
            expect: { result: { 受付日時: 時刻 }, effects: [] },
          },
        }),
        implementation: 今で受け付ける,
      }),
    );

    expect(report.failures).toStrictEqual([]);
  });

  it("reports a row that runs the model without standing in for a dependency it needs", async () => {
    const report = await check(
      spec("受付", {
        examples: examples(受付する, {
          "時刻を書き忘れた": {
            given: { 状態: "申込済み", 申込ID: "a-1" },
            expect: {
              result: { 受付日時: Temporal.Instant.from("2026-10-01T09:00:00Z") },
              effects: [],
            },
          },
        }),
        implementation: 今で受け付ける,
      }),
    );

    expect(report.failures).toStrictEqual([
      { name: "時刻を書き忘れた", message: "No stand-in for dependency 現在時刻" },
    ]);
  });

  it("says the row was not observed, and why", async () => {
    const report = await check(
      spec("受付", {
        examples: examples(受付する, {
          "時刻を書き忘れた": {
            given: { 状態: "申込済み", 申込ID: "a-1" },
            expect: {
              result: { 受付日時: Temporal.Instant.from("2026-10-01T09:00:00Z") },
              effects: [],
            },
          },
        }),
        implementation: 今で受け付ける,
      }),
    );

    expect(report.incompleteness).toStrictEqual([
      {
        kind: "row not run",
        subject: "時刻を書き忘れた",
        reason: "No stand-in for dependency 現在時刻",
      },
    ]);
  });
});

describe("a value a row writes for a dependency", () => {
  it("is held to what the dependency answers", async () => {
    const report = await check(
      spec("受付", {
        examples: examples(受付する, {
          "時刻を文字列で書いた": {
            given: { 状態: "申込済み", 申込ID: "a-1" },
            with: { 現在時刻: "2026-10-01T09:00:00Z" as never },
            expect: {
              result: { 受付日時: Temporal.Instant.from("2026-10-01T09:00:00Z") },
              effects: [],
            },
          },
        }),
        implementation: 今で受け付ける,
      }),
    );

    expect(report.failures).toStrictEqual([
      {
        name: "時刻を文字列で書いた",
        message: "with 現在時刻 is not a value the dependency answers: Expected a Temporal.Instant",
      },
    ]);
  });
});

describe("a function dependency", () => {
  const 在庫を確かめる = behavior("在庫を確かめる", {
    input: variants("状態", { 注文済み: object({ 商品ID: string() }) }),
    result: object({ 在庫あり: boolean() }),
    effects: variants("種類", {}),
    requires: { 在庫を照会する: dependency(string(), int()) },
  });
  const 照会して答える = implement(在庫を確かめる, {
    cases: {
      注文済み: {
        kind: "decision",
        id: "照会して答える",
        run: (注文, 依存) => ({
          result: { 在庫あり: 依存.在庫を照会する(注文.商品ID) > 0 },
          effects: [],
        }),
      },
    },
  });
  const 商品で = (商品ID: string, 在庫あり: boolean) =>
    ({ [`${商品ID}の在庫`]: example(在庫を確かめる, {
      given: { 状態: "注文済み", 商品ID },
      expect: { result: { 在庫あり }, effects: [] },
    }) });

  it("is stood in for by a fake table matched on the input it is asked", async () => {
    const report = await check(
      spec("在庫", {
        examples: examples(在庫を確かめる, { ...商品で("商品-A", true), ...商品で("商品-B", false) }),
        implementation: 照会して答える,
        fakes: [fake(在庫を確かめる, "在庫を照会する", [["商品-A", 10], ["商品-B", 0]])],
      }),
    );

    expect(report.failures).toStrictEqual([]);
  });

  it("reports an input a fake table has no row and no default for", async () => {
    const report = await check(
      spec("在庫", {
        examples: examples(在庫を確かめる, { ...商品で("商品-C", false) }),
        implementation: 照会して答える,
        fakes: [fake(在庫を確かめる, "在庫を照会する", [["商品-A", 10]])],
      }),
    );

    expect(report.failures).toStrictEqual([
      { name: "商品-Cの在庫", message: 'Fake 在庫を照会する has no answer for "商品-C"' },
    ]);
  });

  it("answers an input no row states with the table's default", async () => {
    const report = await check(
      spec("在庫", {
        examples: examples(在庫を確かめる, { ...商品で("商品-C", false) }),
        implementation: 照会して答える,
        fakes: [fake(在庫を確かめる, "在庫を照会する", [["商品-A", 10]], { otherwise: 0 })],
      }),
    );

    expect(report.failures).toStrictEqual([]);
  });

  const issuesOf = async (fakes: Parameters<typeof spec>[1]["fakes"]) =>
    (
      await check(
        spec("在庫", {
          examples: examples(在庫を確かめる, {}),
          implementation: 照会して答える,
          ...(fakes === undefined ? {} : { fakes }),
        }),
      )
    ).fakeIssues;

  it("reports a fake row that answers nothing because an earlier row states its input", async () => {
    expect(
      await issuesOf([fake(在庫を確かめる, "在庫を照会する", [["商品-A", 10], ["商品-A", 3]])]),
    ).toStrictEqual(['Fake 在庫を照会する row 2 answers nothing: row 1 already states "商品-A"']);
  });

  it("reports a fake value that is not a value of what the dependency answers", async () => {
    expect(
      await issuesOf([
        fake(在庫を確かめる, "在庫を照会する", [["商品-A", 1.5]]),
      ]),
    ).toStrictEqual(["Fake 在庫を照会する row 1 answers a value the dependency cannot: Expected an integer"]);
  });

  it("reports two tables standing in for one dependency, neither of which is used", async () => {
    expect(
      await issuesOf([
        fake(在庫を確かめる, "在庫を照会する", [["商品-A", 1]]),
        fake(在庫を確かめる, "在庫を照会する", [["商品-A", 2]]),
      ]),
    ).toStrictEqual(["Fake 在庫を照会する is written 2 times"]);
  });
});

describe("generated rows and dependencies", () => {
  it("carries the values the answered row it was composed from stands in with", () => {
    const 受付する2 = behavior("受付する2", {
      input: variants("状態", { 申込済み: object({ 紹介コード: string().optional() }) }),
      result: object({ 受付日時: instant() }),
      effects: variants("種類", {}),
      requires: { 現在時刻: dependency(instant()) },
    });
    const 時刻 = Temporal.Instant.from("2026-10-01T09:00:00Z");

    expect(
      generate(
        examples(受付する2, {
          "紹介なし": {
            given: { 状態: "申込済み" },
            with: { 現在時刻: 時刻 },
            expect: { result: { 受付日時: 時刻 }, effects: [] },
          },
        }),
      ).rows.map(row => row.with),
    ).toStrictEqual([{ 現在時刻: 時刻 }]);
  });

  it("follows the way of a row whose handler needs a stand-in generate does not have", () => {
    const 送料を決める = behavior("送料を決める", {
      input: variants("状態", {
        確定済み: object({ 配送: variants("方法", { 宅配: object({}), 店頭受取: object({}) }) }),
      }),
      result: object({ 送料: int() }),
      effects: variants("種類", {}),
      requires: { 料金表: dependency(string(), int()) },
    });
    const 料金表で決める = implement(送料を決める, {
      cases: {
        確定済み: action("料金表で決める", {
          run: match(注文 => 注文.配送.方法, {
            宅配: (_, 依存) => ({ result: { 送料: 依存.料金表("宅配") }, effects: [] }),
            店頭受取: (_, 依存) => ({ result: { 送料: 依存.料金表("店頭受取") }, effects: [] }),
          }),
        }),
      },
    });
    const report = generate(
      examples(送料を決める, {
        "宅配": {
          given: { 状態: "確定済み", 配送: { 方法: "宅配" } },
          expect: { result: { 送料: 500 }, effects: [] },
        },
      }),
      料金表で決める,
    );

    expect(report.notComposed).toStrictEqual([]);
  });
});

describe("a value dependency read in a guard condition", () => {
  const 予約する = behavior("予約する", {
    input: variants("状態", { 申込済み: object({ 希望日時: instant() }) }),
    result: variants("結果", { 受付: object({}), 過去: object({}) }),
    effects: variants("種類", {}),
    requires: {
      現在時刻: dependency(instant()),
      採番: dependency(string(), string()),
    },
  });
  const 過去を断る = implement(予約する, {
    cases: {
      申込済み: action("過去を断る", {
        guards: (申込, 依存) => [
          依存.現在時刻.$lt(申込.希望日時).$else(() => ({
            result: { 結果: "過去" },
            effects: [],
          })),
        ],
        run: () => ({ result: { 結果: "受付" }, effects: [] }),
      }),
    },
  });
  const 今 = Temporal.Instant.from("2026-10-01T09:00:00Z");
  const 採番 = () => "n-1";
  const 行 = (
    名前: string,
    希望日時: Temporal.Instant,
    結果: "受付" | "過去",
  ) =>
    ({ [名前]: example(予約する, {
      given: { 状態: "申込済み", 希望日時 },
      with: { 現在時刻: 今 },
      expect: { result: { 結果 }, effects: [] },
    }) });

  it("is evaluated against the dependency the run is given", async () => {
    expect(
      await perform(
        過去を断る,
        {
          状態: "申込済み",
          希望日時: Temporal.Instant.from("2026-09-30T09:00:00Z"),
        },
        { 現在時刻: 今, 採番 },
      ),
    ).toStrictEqual({ result: { 結果: "過去" }, effects: [] });
  });

  it("is evaluated against the value a row writes with with", async () => {
    const report = await check(
      spec("予約", {
        examples: examples(予約する, {
          ...行("明日", Temporal.Instant.from("2026-10-02T09:00:00Z"), "受付"),
          ...行("昨日", Temporal.Instant.from("2026-09-30T09:00:00Z"), "過去"),
        }),
        implementation: 過去を断る,
        fakes: [fake(予約する, "採番", [["x", "n-1"]])],
      }),
    );

    expect(report.failures).toStrictEqual([]);
  });

  it("draws its border on the difference between the position and the dependency", async () => {
    const report = await check(
      spec("予約", {
        examples: examples(予約する, {
          ...行("ちょうど1ns後", 今.add({ nanoseconds: 1 }), "受付"),
        }),
        implementation: 過去を断る,
        fakes: [fake(予約する, "採番", [["x", "n-1"]])],
      }),
    );

    expect(
      report.borders
        .filter((border) => border.rule.startsWith("guard"))
        .map((border) => ({
          path: border.path,
          rule: border.rule,
          met: border.points
            .filter((point) => point.status === "met")
            .map((point) => point.role),
        })),
    ).toStrictEqual([
      {
        path: "deps.現在時刻 − @申込済み.希望日時",
        rule: "guard deps.現在時刻 < $.希望日時",
        met: ["ON"],
      },
    ]);
  });

  it("is a comparison Chisel reads", async () => {
    const report = await check(
      spec("予約", {
        examples: examples(予約する, {}),
        implementation: 過去を断る,
      }),
    );

    expect(report.measures.comparisons).toStrictEqual({ status: "complete" });
  });

  it("generates a row at a point by moving the position against the value the row stands in with", () => {
    const generated = generate(
      examples(予約する, {
        ...行("明日", Temporal.Instant.from("2026-10-02T09:00:00Z"), "受付"),
      }),
      過去を断る,
    ).rows.find((row) => row.name.endsWith("OFF (= 0)"));

    expect(generated).toStrictEqual({
      name: "予約する: deps.現在時刻 − @申込済み.希望日時 OFF (= 0)",
      given: { 状態: "申込済み", 希望日時: 今 },
      with: { 現在時刻: 今 },
      reason:
        "deps.現在時刻 − @申込済み.希望日時のOFF点（= 0）の期待結果を人間が決める必要があります",
    });
  });
});

describe("a value dependency read inside all", () => {
  const 注文する = behavior("注文する", {
    input: variants("状態", {
      入力済み: object({ 明細: array(object({ 数量: int() })) }),
    }),
    result: variants("結果", { 受付: object({}), 上限超過: object({}) }),
    effects: variants("種類", {}),
    requires: { 上限: dependency(int()) },
  });
  const 上限で断る = implement(注文する, {
    cases: {
      入力済み: action("上限で断る", {
        guards: (注文, 依存) => [
          注文.明細.$all((行) => 行.数量.$lte(依存.上限)).$else(() => ({
            result: { 結果: "上限超過" },
            effects: [],
          })),
        ],
        run: () => ({ result: { 結果: "受付" }, effects: [] }),
      }),
    },
  });

  it("is evaluated against the dependency for every element", async () => {
    expect(
      await perform(
        上限で断る,
        { 状態: "入力済み", 明細: [{ 数量: 3 }] },
        { 上限: 2 },
      ),
    ).toStrictEqual({ result: { 結果: "上限超過" }, effects: [] });
  });

  it("is a comparison Chisel reads inside all", async () => {
    const report = await check(
      spec("注文", {
        examples: examples(注文する, {}),
        implementation: 上限で断る,
      }),
    );

    expect(report.measures.comparisons).toStrictEqual({ status: "complete" });
  });
});

describe("a dependency declared as another behavior", () => {
  const 在庫を照会する = behavior("在庫を照会する", {
    input: variants("種別", { 商品: object({ 商品ID: string() }) }),
    result: object({ 商品ID: string(), 在庫数: int() }),
    effects: variants("種類", {}),
    ensures: clause => [
      clause.always("照会した商品を答える", (問い, 答え) => 答え.商品ID.$eq(問い.商品ID)),
    ],
  });
  const 在庫照会の例 = examples(在庫を照会する, {
    "商品-Aは10個": {
      given: { 種別: "商品", 商品ID: "商品-A" },
      expect: { result: { 商品ID: "商品-A", 在庫数: 10 }, effects: [] },
    },
  });
  const 注文する = behavior("注文する", {
    input: variants("状態", { 入力済み: object({ 商品ID: string() }) }),
    result: object({ 在庫あり: boolean() }),
    effects: variants("種類", {}),
    requires: { 在庫: dependency(在庫照会の例) },
  });
  const 在庫で決める = implement(注文する, {
    cases: {
      入力済み: {
        kind: "decision",
        id: "在庫で決める",
        run: (注文, 依存) => ({
          result: { 在庫あり: 依存.在庫({ 種別: "商品", 商品ID: 注文.商品ID }).在庫数 > 0 },
          effects: [],
        }),
      },
    },
  });

  async function reportWith(rows: Parameters<typeof fake<typeof 注文する, "在庫">>[2]) {
    return check(
      spec("注文", {
        examples: examples(注文する, {
          "商品-A": {
            given: { 状態: "入力済み", 商品ID: "商品-A" },
            expect: { result: { 在庫あり: true }, effects: [] },
          },
        }),
        implementation: 在庫で決める,
        fakes: [fake(注文する, "在庫", rows)],
      }),
    );
  }

  it("stands in with a fake table typed by the behavior's input and result", async () => {
    const report = await reportWith([
      [{ 種別: "商品", 商品ID: "商品-A" }, { 商品ID: "商品-A", 在庫数: 10 }],
    ]);

    expect({ failures: report.failures, issues: report.fakeIssues, warnings: report.fakeWarnings }).toStrictEqual({
      failures: [],
      issues: [],
      warnings: [],
    });
  });

  it("warns where a fake row answers differently from a recorded row of the behavior", async () => {
    const report = await reportWith([
      [{ 種別: "商品", 商品ID: "商品-A" }, { 商品ID: "商品-A", 在庫数: 3 }],
    ]);

    expect(report.fakeWarnings).toStrictEqual([
      'Fake 在庫 row 1 answers {"商品ID":"商品-A","在庫数":3} where 在庫を照会する example 商品-Aは10個 answers {"商品ID":"商品-A","在庫数":10}',
    ]);
  });

  it("refuses a fake row that breaks what the behavior ensures", async () => {
    const report = await reportWith([
      [{ 種別: "商品", 商品ID: "商品-A" }, { 商品ID: "商品-B", 在庫数: 10 }],
    ]);

    expect(report.fakeIssues).toStrictEqual([
      "Fake 在庫 row 1 breaks ensures 照会した商品を答える of 在庫を照会する",
    ]);
  });
});
