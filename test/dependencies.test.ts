import { describe, expect, it } from "vitest";
import {
  behavior,
  boolean,
  defineSpecification,
  dependency,
  evaluateSpecification,
  example,
  examples,
  fake,
  implement,
  integer,
  instant,
  object,
  string,
  sum,
} from "../src/index.js";

const 受付する = behavior({
  name: "受付する",
  input: sum("状態", { 申込済み: object({ 申込ID: string("申込ID") }) }),
  result: object({ 受付日時: instant() }),
  effects: sum("種類", {}),
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
    const report = await evaluateSpecification(
      defineSpecification({
        name: "受付",
        examples: examples(受付する, [
          example(受付する, "今の時刻で受け付ける", {
            given: { 状態: "申込済み", 申込ID: "a-1" },
            with: { 現在時刻: 時刻 },
            expect: { result: { 受付日時: 時刻 }, effects: [] },
          }),
        ]),
        implementation: 今で受け付ける,
      }),
    );

    expect(report.failures).toStrictEqual([]);
  });

  it("reports a row that runs the model without standing in for a dependency it needs", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "受付",
        examples: examples(受付する, [
          example(受付する, "時刻を書き忘れた", {
            given: { 状態: "申込済み", 申込ID: "a-1" },
            expect: {
              result: { 受付日時: Temporal.Instant.from("2026-10-01T09:00:00Z") },
              effects: [],
            },
          }),
        ]),
        implementation: 今で受け付ける,
      }),
    );

    expect(report.failures).toStrictEqual([
      { name: "時刻を書き忘れた", message: "No stand-in for dependency 現在時刻" },
    ]);
  });
});

describe("a value a row writes for a dependency", () => {
  it("is held to what the dependency answers", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "受付",
        examples: examples(受付する, [
          example(受付する, "時刻を文字列で書いた", {
            given: { 状態: "申込済み", 申込ID: "a-1" },
            with: { 現在時刻: "2026-10-01T09:00:00Z" as never },
            expect: {
              result: { 受付日時: Temporal.Instant.from("2026-10-01T09:00:00Z") },
              effects: [],
            },
          }),
        ]),
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
  const 在庫を確かめる = behavior({
    name: "在庫を確かめる",
    input: sum("状態", { 注文済み: object({ 商品ID: string("商品ID") }) }),
    result: object({ 在庫あり: boolean() }),
    effects: sum("種類", {}),
    requires: { 在庫を照会する: dependency(string("商品ID"), integer()) },
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
    example(在庫を確かめる, `${商品ID}の在庫`, {
      given: { 状態: "注文済み", 商品ID },
      expect: { result: { 在庫あり }, effects: [] },
    });

  it("is stood in for by a fake table matched on the input it is asked", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "在庫",
        examples: examples(在庫を確かめる, [商品で("商品-A", true), 商品で("商品-B", false)]),
        implementation: 照会して答える,
        fakes: [fake(在庫を確かめる, "在庫を照会する", [["商品-A", 10], ["商品-B", 0]])],
      }),
    );

    expect(report.failures).toStrictEqual([]);
  });

  it("reports an input a fake table has no row and no default for", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "在庫",
        examples: examples(在庫を確かめる, [商品で("商品-C", false)]),
        implementation: 照会して答える,
        fakes: [fake(在庫を確かめる, "在庫を照会する", [["商品-A", 10]])],
      }),
    );

    expect(report.failures).toStrictEqual([
      { name: "商品-Cの在庫", message: 'Fake 在庫を照会する has no answer for "商品-C"' },
    ]);
  });

  it("answers an input no row states with the table's default", async () => {
    const report = await evaluateSpecification(
      defineSpecification({
        name: "在庫",
        examples: examples(在庫を確かめる, [商品で("商品-C", false)]),
        implementation: 照会して答える,
        fakes: [fake(在庫を確かめる, "在庫を照会する", [["商品-A", 10]], { otherwise: 0 })],
      }),
    );

    expect(report.failures).toStrictEqual([]);
  });

  const issuesOf = async (fakes: Parameters<typeof defineSpecification>[0]["fakes"]) =>
    (
      await evaluateSpecification(
        defineSpecification({
          name: "在庫",
          examples: examples(在庫を確かめる, []),
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
