import { describe, expect, it } from "vitest";
import {
  action,
  array,
  behavior,
  boolean,
  check,
  compose,
  dependency,
  examples,
  generate,
  implement,
  int,
  object,
  record,
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

  it("still counts the classes a guard draws on a disregarded field among the partitions check reports", async () => {
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

    const report = await check(spec("承認", { examples: examples(承認する, {}), implementation: 実装 }));

    expect(report.partitions.map(partition => partition.path)).toStrictEqual(["@提出済み.金額"]);
  });

  it("keeps a guard's classes on a disregarded field without owing the field's own invariant borders again", async () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", { 提出済み: object({ 金額: int().min(0) }) }),
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

    const report = await check(spec("承認", { examples: examples(承認する, {}), implementation: 実装 }));

    expect({
      partitions: report.partitions.map(partition => partition.path),
      borders: report.borders.map(border => border.rule),
    }).toStrictEqual({ partitions: ["@提出済み.金額"], borders: ["guard $.金額 <= 100"] });
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
        message: "承認する disregards @提出済み.至急, but its answer changed when @提出済み.至急 was true",
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

describe("check holds disregarded fields together", () => {
  const 旗 = (count: number) =>
    object(Object.fromEntries(Array.from({ length: count }, (_, index) => [`旗${index + 1}`, boolean()])));
  const 承認するを = (count: number) =>
    behavior("承認する", {
      input: variants("状態", { 提出済み: 旗(count) }),
      result: variants("結果", { 承認: object({}), 保留: object({}) }),
      effects: variants("種類", {}),
      disregards: { 提出済み: r => [r] },
    });
  const 全部立つと保留 = (定義: ReturnType<typeof 承認するを>) =>
    implement(定義, {
      cases: {
        提出済み: action("全部立つと保留", {
          run: r =>
            Object.entries(r).every(([key, value]) => key === "状態" || value === true)
              ? { result: { 結果: "保留" }, effects: [] }
              : { result: { 結果: "承認" }, effects: [] },
        }),
      },
    });
  const 全部倒れた行 = (定義: ReturnType<typeof 承認するを>, count: number) =>
    examples(定義, {
      全部倒れた: {
        given: {
          状態: "提出済み",
          ...Object.fromEntries(Array.from({ length: count }, (_, index) => [`旗${index + 1}`, false])),
        } as never,
        expect: { result: { 結果: "承認" }, effects: [] },
      },
    });

  it("fails a row whose answer changes only when two disregarded fields move together", async () => {
    const 定義 = 承認するを(2);

    const report = await check(spec("承認", { examples: 全部倒れた行(定義, 2), implementation: 全部立つと保留(定義) }));

    expect(report.failures).toStrictEqual([
      {
        name: "全部倒れた",
        message:
          "承認する disregards @提出済み.旗1, @提出済み.旗2, but its answer changed when @提出済み.旗1 was true and @提出済み.旗2 was true",
      },
    ]);
  });

  it("fails a row whose answer changes only when three disregarded fields move together", async () => {
    const 定義 = 承認するを(3);

    const report = await check(spec("承認", { examples: 全部倒れた行(定義, 3), implementation: 全部立つと保留(定義) }));

    expect(report.failures.map(failure => failure.message)).toStrictEqual([
      "承認する disregards @提出済み.旗1, @提出済み.旗2, @提出済み.旗3, but its answer changed when @提出済み.旗1 was true and @提出済み.旗2 was true and @提出済み.旗3 was true",
    ]);
  });

  it("does not try a combination the input cannot hold, such as a field of a case the sum is not in", async () => {
    const 支払う = behavior("支払う", {
      input: variants("状態", {
        確定: object({ 支払: variants("方法", { 現金: object({}), カード: object({ 分割: boolean() }) }) }),
      }),
      result: object({}),
      effects: variants("種類", {}),
      disregards: { 確定: r => [r] },
    });
    const 実装 = implement(支払う, {
      cases: { 確定: action("払う", { run: () => ({ result: {}, effects: [] }) }) },
    });

    const report = await check(
      spec("支払", {
        examples: examples(支払う, {
          現金: { given: { 状態: "確定", 支払: { 方法: "現金" } }, expect: { result: {}, effects: [] } },
        }),
        implementation: 実装,
      }),
    );

    expect(report.failures).toStrictEqual([]);
  });

  it("reports a row with more combinations than it tries as not checked, leaving the verdict undetermined", async () => {
    const 受け付ける = behavior("受け付ける", {
      input: variants("状態", { 提出済み: 旗(9) }),
      result: object({}),
      effects: variants("種類", {}),
      disregards: { 提出済み: r => [r] },
    });
    const 実装 = implement(受け付ける, {
      cases: { 提出済み: action("受け付ける", { run: () => ({ result: {}, effects: [] }) }) },
    });

    const report = await check(
      spec("受付", {
        examples: examples(受け付ける, {
          全部倒れた: {
            given: {
              状態: "提出済み",
              ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`旗${index + 1}`, false])),
            } as never,
            expect: { result: {}, effects: [] },
          },
        }),
        implementation: 実装,
      }),
    );

    expect({ failures: report.failures, incompleteness: report.incompleteness, verdict: report.verdict }).toStrictEqual({
      failures: [],
      incompleteness: [
        {
          kind: "disregards not checked",
          subject: "全部倒れた",
          reason: "disregardsの組み合わせが511通りあり、上限の255通りを超えるため確かめていない",
        },
      ],
      verdict: "undetermined",
    });
  });
});

describe("what disregards does not hide", () => {
  it("still reports a disregarded field the invariants leave empty as a model error", async () => {
    const 数量を決める = behavior("数量を決める", {
      input: variants("状態", {
        入力済み: object({ 数量: int().refine(v => v.$gte(10)).refine(v => v.$lte(5)) }),
      }),
      result: object({}),
      effects: variants("種類", {}),
      disregards: { $default: r => [r.数量] },
    });

    const report = await check(spec("数量", { examples: examples(数量を決める, {}) }));

    expect(report.modelIssues).toStrictEqual([
      "@入力済み.数量: 不変条件を満たす値がありません (invariant $ >= 10, invariant $ <= 5)",
    ]);
  });

  it("does not move a row into another case whose name begins with its own", async () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", {
        下書き: object({ 至急: boolean() }),
        下書き2: object({ 至急: boolean() }),
      }),
      result: object({}),
      effects: variants("種類", {}),
      disregards: { $default: r => [r] },
    });
    const 状態で答える = implement(承認する, {
      cases: {
        下書き: action("下書き", { run: () => ({ result: {}, effects: [] }) }),
        下書き2: action("下書き2", { run: () => { throw new Error("下書き2 に移された"); } }),
      },
    });

    const report = await check(
      spec("承認", {
        examples: examples(承認する, {
          下書き: { given: { 状態: "下書き", 至急: false }, expect: { result: {}, effects: [] } },
        }),
        implementation: 状態で答える,
      }),
    );

    expect(report.failures).toStrictEqual([]);
  });
});

describe("disregards reads keys as written", () => {
  it("keeps a nested field whose path reads like a disregarded key holding a dot", () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", {
        下書き: object({ "注文.メモ": boolean(), 注文: object({ メモ: boolean() }) }),
      }),
      result: object({}),
      effects: variants("種類", {}),
      disregards: { 下書き: r => [r["注文.メモ"]] },
    });

    expect(generate(承認する).rows.map(row => row.name)).toStrictEqual([
      "承認する: 下書き",
      "承認する: @下書き.注文.メモ = true",
    ]);
  });
});

describe("a case named $default", () => {
  it("is refused, since $default names every case left out", () => {
    expect(() =>
      behavior("承認する", {
        input: variants("状態", { $default: object({}) }),
        result: object({}),
        effects: variants("種類", {}),
      }),
    ).toThrow("承認する cannot take a case named $default");
  });
});

describe("disregards and case names", () => {
  it("takes a case named like an Object.prototype member when nothing is disregarded", () => {
    expect(() =>
      behavior("承認する", {
        input: variants("状態", { toString: object({ 至急: boolean() }) }),
        result: object({}),
        effects: variants("種類", {}),
      }),
    ).not.toThrow();
  });

  it("lets $default cover a case named like an Object.prototype member", () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", { toString: object({ 至急: boolean() }) }),
      result: object({}),
      effects: variants("種類", {}),
      disregards: { $default: (r: never) => [r] } as never,
    });

    expect(generate(承認する).rows.map(row => row.name)).toStrictEqual(["承認する: toString"]);
  });
});

describe("disregards under an optional object", () => {
  it("disregards a field of an object that is itself optional", () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", {
        提出済み: object({ 詳細: object({ 至急: boolean() }).optional() }),
      }),
      result: object({}),
      effects: variants("種類", {}),
      disregards: { 提出済み: r => [r.詳細.至急] },
    });

    expect(generate(承認する).rows.map(row => row.name)).toStrictEqual([
      "承認する: 提出済み",
      "承認する: @提出済み.詳細 = あり",
    ]);
  });
});

describe("check holds a disregarded field an invariant bounds", () => {
  it("fails a row whose answer changes at a point of the border the field would have owed", async () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", { 提出済み: object({ 金額: int().min(0) }) }),
      result: variants("結果", { 承認: object({}), 保留: object({}) }),
      effects: variants("種類", {}),
      disregards: { 提出済み: r => [r.金額] },
    });
    const 実装 = implement(承認する, {
      cases: {
        提出済み: action("金額があれば保留", {
          run: r => (r.金額 > 0 ? { result: { 結果: "保留" }, effects: [] } : { result: { 結果: "承認" }, effects: [] }),
        }),
      },
    });

    const report = await check(
      spec("承認", {
        examples: examples(承認する, {
          ゼロ: { given: { 状態: "提出済み", 金額: 0 }, expect: { result: { 結果: "承認" }, effects: [] } },
        }),
        implementation: 実装,
      }),
    );

    expect(report.failures.map(failure => failure.message)).toStrictEqual([
      "承認する disregards @提出済み.金額, but its answer changed when @提出済み.金額 was IN (> 0)",
    ]);
  });
});

describe("disregards and fields named like Object.prototype members", () => {
  it("refuses a $default field only a written case declares, even when it is named like an inherited member", () => {
    expect(() =>
      behavior("承認する", {
        input: variants("状態", {
          下書き: object({ toString: boolean() }),
          提出済み: object({ 至急: boolean() }),
        }),
        result: object({}),
        effects: variants("種類", {}),
        disregards: { 下書き: () => [], $default: (r: never) => [(r as { toString: never }).toString] } as never,
      }),
    ).toThrow("承認する disregards toString, which no case $default covers declares");
  });
});

describe("disregards through a nested sum", () => {
  it("takes a $default field every case of a nested sum declares", () => {
    const 支払う = behavior("支払う", {
      input: variants("状態", {
        確定: object({
          支払: variants("方法", { 現金: object({ 参照番号: string() }), カード: object({ 参照番号: string() }) }),
        }),
      }),
      result: object({}),
      effects: variants("種類", {}),
      disregards: { $default: r => [r.支払.参照番号] },
    });

    expect(支払う.disregards).toStrictEqual({ 確定: [["支払", "参照番号"]] });
  });
});

describe("check holds what disregards drops from a field a guard divides", () => {
  it("fails a row whose answer changes at an invariant border point of a guarded disregarded field", async () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", { 提出済み: object({ 金額: int().min(0) }) }),
      result: variants("結果", { 承認: object({}), 保留: object({}) }),
      effects: variants("種類", {}),
      disregards: { $default: r => [r.金額] },
    });
    const 実装 = implement(承認する, {
      cases: {
        提出済み: action("上限内でゼロなら承認", {
          guards: r => [r.金額.$lte(100).$else(() => ({ result: { 結果: "保留" }, effects: [] }))],
          run: r => (r.金額 === 0 ? { result: { 結果: "承認" }, effects: [] } : { result: { 結果: "保留" }, effects: [] }),
        }),
      },
    });

    const report = await check(
      spec("承認", {
        examples: examples(承認する, {
          ゼロ: { given: { 状態: "提出済み", 金額: 0 }, expect: { result: { 結果: "承認" }, effects: [] } },
        }),
        implementation: 実装,
      }),
    );

    expect(report.failures.map(failure => failure.message)).toStrictEqual([
      "承認する disregards @提出済み.金額, but its answer changed when @提出済み.金額 was IN (> 0)",
    ]);
  });
});

describe("the limit on disregarded combinations counts only those the input can hold", () => {
  it("checks a row whose combinations are few once those the input cannot hold are left out", async () => {
    const 任意の旗 = Object.fromEntries(
      Array.from({ length: 4 }, (_, index) => [`旗${index + 1}`, boolean().optional()]),
    );
    const 受け付ける = behavior("受け付ける", {
      input: variants("状態", { 提出済み: object(任意の旗) }),
      result: object({}),
      effects: variants("種類", {}),
      disregards: { 提出済み: r => [r] },
    });
    const 実装 = implement(受け付ける, {
      cases: { 提出済み: action("受け付ける", { run: () => ({ result: {}, effects: [] }) }) },
    });

    const report = await check(
      spec("受付", {
        examples: examples(受け付ける, {
          旗なし: { given: { 状態: "提出済み" } as never, expect: { result: {}, effects: [] } },
        }),
        implementation: 実装,
      }),
    );

    expect(report.incompleteness).toStrictEqual([]);
  });

  it("does not count the combinations of a row whose candidates exceed what it tries", async () => {
    const 旗 = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`旗${index + 1}`, boolean()]));
    const 受け付ける = behavior("受け付ける", {
      input: variants("状態", { 提出済み: object(旗) }),
      result: object({}),
      effects: variants("種類", {}),
      disregards: { 提出済み: r => [r] },
    });
    const 実装 = implement(受け付ける, {
      cases: { 提出済み: action("受け付ける", { run: () => ({ result: {}, effects: [] }) }) },
    });

    const report = await check(
      spec("受付", {
        examples: examples(受け付ける, {
          全部倒れた: {
            given: {
              状態: "提出済み",
              ...Object.fromEntries(Array.from({ length: 13 }, (_, index) => [`旗${index + 1}`, false])),
            } as never,
            expect: { result: {}, effects: [] },
          },
        }),
        implementation: 実装,
      }),
    );

    expect(report.incompleteness.map(item => item.reason)).toStrictEqual([
      "disregardsの組み合わせの候補が8191通りあり、上限の4096通りを超えるため数えていない",
    ]);
  });
});

describe("disregards and a guard that reads a field with finite classes", () => {
  it("still offers the rows for the classes of a disregarded boolean a guard reads", () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", { 提出済み: object({ 至急: boolean() }) }),
      result: variants("結果", { 承認: object({}), 保留: object({}) }),
      effects: variants("種類", {}),
      disregards: { $default: r => [r.至急] },
    });
    const 実装 = implement(承認する, {
      cases: {
        提出済み: action("至急でなければ承認", {
          guards: r => [r.至急.$eq(false).$else(() => ({ result: { 結果: "保留" }, effects: [] }))],
          run: () => ({ result: { 結果: "承認" }, effects: [] }),
        }),
      },
    });

    expect(generate(承認する, 実装).rows.map(row => row.name)).toContain("承認する: @提出済み.至急 = true");
  });
});

describe("a guard quantifying over a dependency", () => {
  it("keeps the classes of an input field read inside the quantifier", () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", { 提出済み: object({ 至急: boolean() }) }),
      result: variants("結果", { 承認: object({}), 保留: object({}) }),
      effects: variants("種類", {}),
      requires: { 許可: dependency(array(boolean())) },
      disregards: { $default: r => [r.至急] },
    });
    const 実装 = implement(承認する, {
      cases: {
        提出済み: action("許可された至急なら承認", {
          guards: (r, deps) => [
            deps.許可.$any(value => r.至急.$eq(value)).$else(() => ({ result: { 結果: "保留" }, effects: [] })),
          ],
          run: () => ({ result: { 結果: "承認" }, effects: [] }),
        }),
      },
    });

    expect(generate(承認する, 実装).rows.map(row => row.name)).toContain("承認する: @提出済み.至急 = true");
  });
});

describe("a rerun that throws", () => {
  it("reports the error a varied row threw rather than a changed answer", async () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", { 提出済み: object({ 至急: boolean() }) }),
      result: object({}),
      effects: variants("種類", {}),
      disregards: { $default: r => [r.至急] },
    });
    const 実装 = implement(承認する, {
      cases: {
        提出済み: action("至急は扱えない", {
          run: r => {
            if (r.至急) {
              throw new Error("至急は未対応");
            }
            return { result: {}, effects: [] };
          },
        }),
      },
    });

    const report = await check(
      spec("承認", {
        examples: examples(承認する, {
          通常: { given: { 状態: "提出済み", 至急: false }, expect: { result: {}, effects: [] } },
        }),
        implementation: 実装,
      }),
    );

    expect(report.failures.map(failure => failure.message)).toStrictEqual([
      "承認する disregards @提出済み.至急, but it threw when @提出済み.至急 was true: 至急は未対応",
    ]);
  });
});

describe("the ancestors of a field a guard reads", () => {
  it("keeps the classes of a disregarded optional whose field a guard reads", async () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", { 提出済み: object({ 詳細: object({ 至急: boolean() }).optional() }) }),
      result: variants("結果", { 承認: object({}), 保留: object({}) }),
      effects: variants("種類", {}),
      disregards: { $default: r => [r.詳細] },
    });
    const 実装 = implement(承認する, {
      cases: {
        提出済み: action("至急でなければ承認", {
          guards: r => [r.詳細.至急.$eq(false).$else(() => ({ result: { 結果: "保留" }, effects: [] }))],
          run: () => ({ result: { 結果: "承認" }, effects: [] }),
        }),
      },
    });

    const report = await check(spec("承認", { examples: examples(承認する, {}), implementation: 実装 }));

    expect(report.partitions.map(partition => partition.path)).toStrictEqual([
      "@提出済み.詳細",
      "@提出済み.詳細?.至急",
    ]);
  });
});

describe("a composition takes its first stage's disregards", () => {
  const 受け付ける = behavior("受け付ける", {
    input: variants("状態", { 申込: object({ 数量: int(), 至急: boolean() }) }),
    result: variants("結果", { 受付: object({ 数量: int(), 至急: boolean() }) }),
    effects: variants("種類", {}),
    disregards: { $default: r => [r.至急] },
  });
  const 見積もる = behavior("見積もる", {
    input: variants("結果", { 受付: object({ 数量: int(), 至急: boolean() }) }),
    result: variants("結果", { 見積: object({ 金額: int() }) }),
    effects: variants("種類", {}),
  });
  const 受け付けるの実装 = implement(受け付ける, {
    cases: {
      申込: action("そのまま受け付ける", {
        run: r => ({ result: { 結果: "受付", 数量: r.数量, 至急: r.至急 }, effects: [] }),
      }),
    },
  });
  const 見積もるの実装 = implement(見積もる, {
    cases: {
      受付: action("至急なら倍", {
        run: r => ({ result: { 結果: "見積", 金額: r.数量 * (r.至急 ? 200 : 100) }, effects: [] }),
      }),
    },
  });
  const [受けて見積もる, 受けて見積もるの実装] = compose("受けて見積もる", [受け付けるの実装, 見積もるの実装]);

  it("offers no row for the classes of a field the first stage disregards", () => {
    expect(generate(受けて見積もる).rows.map(row => row.name)).toStrictEqual(["受けて見積もる: 申込"]);
  });

  it("fails a row whose final answer, after every stage, turns on a field the first stage disregards", async () => {
    const report = await check(
      spec("受けて見積もる", {
        examples: examples(受けて見積もる, {
          通常: {
            given: { 状態: "申込", 数量: 1, 至急: false },
            expect: { result: { 結果: "見積", 金額: 100 }, effects: [] },
          },
        }),
        implementation: 受けて見積もるの実装,
      }),
    );

    expect(report.failures.map(failure => failure.message)).toStrictEqual([
      "受けて見積もる disregards @申込.至急, but its answer changed when @申込.至急 was true",
    ]);
  });
});

describe("check moves only what disregards names", () => {
  it("does not report a change a disregarded child caused only by making its optional parent present", async () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", { 提出済み: object({ 詳細: object({ 至急: boolean() }).optional() }) }),
      result: variants("結果", { 承認: object({}), 保留: object({}) }),
      effects: variants("種類", {}),
      disregards: { $default: r => [r.詳細.至急] },
    });
    const 詳細があれば保留 = implement(承認する, {
      cases: {
        提出済み: action("詳細があれば保留", {
          run: r =>
            r.詳細 === undefined ? { result: { 結果: "承認" }, effects: [] } : { result: { 結果: "保留" }, effects: [] },
        }),
      },
    });

    const report = await check(
      spec("承認", {
        examples: examples(承認する, {
          詳細なし: { given: { 状態: "提出済み" }, expect: { result: { 結果: "承認" }, effects: [] } },
        }),
        implementation: 詳細があれば保留,
      }),
    );

    expect(report.failures).toStrictEqual([]);
  });
});

describe("check holds each element of a disregarded array and each entry of a record", () => {
  it("fails a row whose answer changes only through the second element of a disregarded array", async () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", { 提出済み: object({ 明細: array(object({ 至急: boolean() })) }) }),
      result: variants("結果", { 承認: object({}), 保留: object({}) }),
      effects: variants("種類", {}),
      disregards: { $default: r => [r.明細] },
    });
    const 二件目が至急なら保留 = implement(承認する, {
      cases: {
        提出済み: action("二件目が至急なら保留", {
          run: r =>
            r.明細[1]?.至急 === true ? { result: { 結果: "保留" }, effects: [] } : { result: { 結果: "承認" }, effects: [] },
        }),
      },
    });

    const report = await check(
      spec("承認", {
        examples: examples(承認する, {
          二件: {
            given: { 状態: "提出済み", 明細: [{ 至急: false }, { 至急: false }] },
            expect: { result: { 結果: "承認" }, effects: [] },
          },
        }),
        implementation: 二件目が至急なら保留,
      }),
    );

    expect(report.failures.map(failure => failure.message)).toStrictEqual([
      "承認する disregards @提出済み.明細[1].至急, but its answer changed when @提出済み.明細[1].至急 was true",
    ]);
  });

  it("fails a row whose answer changes only when one entry of a disregarded record differs from the others", async () => {
    const 承認する = behavior("承認する", {
      input: variants("状態", { 提出済み: object({ 担当: record(boolean()) }) }),
      result: variants("結果", { 承認: object({}), 保留: object({}) }),
      effects: variants("種類", {}),
      disregards: { $default: r => [r.担当] },
    });
    const 揃っていなければ保留 = implement(承認する, {
      cases: {
        提出済み: action("揃っていなければ保留", {
          run: r =>
            new Set(Object.values(r.担当)).size > 1
              ? { result: { 結果: "保留" }, effects: [] }
              : { result: { 結果: "承認" }, effects: [] },
        }),
      },
    });

    const report = await check(
      spec("承認", {
        examples: examples(承認する, {
          二人: {
            given: { 状態: "提出済み", 担当: { 甲: false, 乙: false } },
            expect: { result: { 結果: "承認" }, effects: [] },
          },
        }),
        implementation: 揃っていなければ保留,
      }),
    );

    expect(report.failures.map(failure => failure.message)).toStrictEqual([
      '承認する disregards @提出済み.担当{"甲"}, but its answer changed when @提出済み.担当{"甲"} was true',
    ]);
  });
});
