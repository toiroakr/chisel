import { describe, expect, it } from "vitest";
import {
  action,
  array,
  behavior,
  boolean,
  check,
  examples,
  generate,
  implement,
  int,
  object,
  spec,
  string,
  variants,
} from "../src/index.js";

const 報告 = variants("状態", {
  下書き: object({ 明細: array(object({ 領収書: string().optional() })) }),
  提出済み: object({ 至急: boolean(), 明細: array(object({ 領収書: string().optional() })) }),
});

describe("disregards", () => {
  it("offers no row for a class under a field the behavior disregards in that case", () => {
    const 承認する = behavior("承認する", {
      input: 報告,
      result: object({}),
      effects: variants("種類", {}),
      disregards: { 下書き: r => [r.明細] },
    });

    expect(generate(承認する).rows.map(row => row.name)).toStrictEqual([
      "承認する: 下書き",
      "承認する: 提出済み",
      "承認する: @提出済み.至急 = true",
      "承認する: @提出済み.明細[].領収書 = あり",
    ]);
  });
});

describe("disregards with $default", () => {
  it("disregards the field in every case not written beside $default", () => {
    const 承認する = behavior("承認する", {
      input: 報告,
      result: object({}),
      effects: variants("種類", {}),
      disregards: { $default: r => [r.明細] },
    });

    expect(generate(承認する).rows.map(row => row.name)).toStrictEqual([
      "承認する: 下書き",
      "承認する: 提出済み",
      "承認する: @提出済み.至急 = true",
    ]);
  });

  it("lets a written case take only its own fields rather than those of $default", () => {
    const 承認する = behavior("承認する", {
      input: 報告,
      result: object({}),
      effects: variants("種類", {}),
      disregards: { 提出済み: r => [r.至急], $default: r => [r.明細] },
    });

    expect(generate(承認する).rows.map(row => row.name)).toStrictEqual([
      "承認する: 下書き",
      "承認する: 提出済み",
      "承認する: @提出済み.明細[].領収書 = あり",
    ]);
  });

  it("refuses a field no case $default covers declares", () => {
    expect(() =>
      behavior("承認する", {
        input: 報告,
        result: object({}),
        effects: variants("種類", {}),
        disregards: { 提出済み: () => [], $default: r => [r.至急] },
      }),
    ).toThrow("承認する disregards 至急, which no case $default covers declares");
  });
});

describe("disregarding a whole case", () => {
  it("offers only the case's own row when the case itself is disregarded", () => {
    const 承認する = behavior("承認する", {
      input: 報告,
      result: object({}),
      effects: variants("種類", {}),
      disregards: { 下書き: () => [], $default: r => [r] },
    });

    expect(generate(承認する).rows.map(row => row.name)).toStrictEqual([
      "承認する: 下書き",
      "承認する: 提出済み",
      "承認する: @下書き.明細[].領収書 = あり",
    ]);
  });
});

describe("what disregards leaves measured", () => {
  it("keeps a field whose name only begins with a disregarded one", () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", {
        下書き: object({ 明細: boolean(), 明細メモ: boolean() }),
      }),
      result: object({}),
      effects: variants("種類", {}),
      disregards: { 下書き: r => [r.明細] },
    });

    expect(generate(承認する).rows.map(row => row.name)).toStrictEqual([
      "承認する: 下書き",
      "承認する: @下書き.明細メモ = true",
    ]);
  });

  it("does not count a class under a disregarded field among the partitions check reports", async () => {
    const 承認する = behavior("承認する", {
      input: 報告,
      result: object({}),
      effects: variants("種類", {}),
      disregards: { $default: r => [r.明細] },
    });

    const report = await check(spec("承認", { examples: examples(承認する, {}) }));

    expect(report.partitions.map(partition => partition.path)).toStrictEqual(["@提出済み.至急"]);
  });

  it("still owes the points of a guard on a disregarded field", () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", { 提出済み: object({ 金額: int() }) }),
      result: variants("結果", { 承認: object({}), 却下: object({}) }),
      effects: variants("種類", {}),
      disregards: { $default: r => [r.金額] },
    });
    const 実装 = implement(承認する, {
      cases: {
        提出済み: action("上限内なら承認", {
          guards: r => [r.金額.$lte(100).$else(() => ({ result: { 結果: "却下" }, effects: [] }))],
          run: () => ({ result: { 結果: "承認" }, effects: [] }),
        }),
      },
    });

    expect(generate(承認する, 実装).rows.map(row => row.name)).toContain("承認する: @提出済み.金額 ON (= 100)");
  });
});

describe("disregards is typed by the case it is written for", () => {
  it("does not compile a field the case does not declare", () => {
    behavior("承認する", {
      input: 報告,
      result: object({}),
      effects: variants("種類", {}),
      // @ts-expect-error 下書き has no 至急
      disregards: { 下書き: r => [r.至急] },
    });
  });
});

describe("check holds an implementation to what its behavior disregards", () => {
  const 承認する = behavior("承認する", {
    input: variants("状態", { 提出済み: object({ 至急: boolean() }) }),
    result: variants("結果", { 承認: object({}), 保留: object({}) }),
    effects: variants("種類", {}),
    disregards: { 提出済み: r => [r.至急] },
  });
  const 通常の行 = examples(承認する, {
    通常: { given: { 状態: "提出済み", 至急: false }, expect: { result: { 結果: "承認" }, effects: [] } },
  });

  it("fails a row whose answer changes when a disregarded field takes another class", async () => {
    const 至急なら保留 = implement(承認する, {
      cases: {
        提出済み: action("至急なら保留", {
          guards: r => [r.至急.$eq(false).$else(() => ({ result: { 結果: "保留" }, effects: [] }))],
          run: () => ({ result: { 結果: "承認" }, effects: [] }),
        }),
      },
    });

    const report = await check(spec("承認", { examples: 通常の行, implementation: 至急なら保留 }));

    expect(report.failures).toStrictEqual([
      {
        name: "通常",
        message: "承認する disregards @提出済み.至急, but its answer changed when it was true",
      },
    ]);
  });

  it("passes a row whose answer stays the same across the classes of a disregarded field", async () => {
    const いつも承認 = implement(承認する, {
      cases: { 提出済み: action("承認", { run: () => ({ result: { 結果: "承認" }, effects: [] }) }) },
    });

    const report = await check(spec("承認", { examples: 通常の行, implementation: いつも承認 }));

    expect(report.failures).toStrictEqual([]);
  });
});
