import { describe, expect, it } from "vitest";
import {
  action,
  behavior,
  boolean,
  check,
  compose,
  enum as enumOf,
  examples,
  external,
  generate,
  implement,
  int,
  match,
  object,
  positionsOf,
  SpecificationError,
  spec,
  string,
  variants,
} from "../src/index.js";
import type { AnySchema } from "../src/index.js";

const 費目 = enumOf(["交通費", "宿泊費", "飲食費"]);

describe("enum", () => {
  it("parses one of its values and refuses anything else", () => {
    expect(費目.parse("宿泊費")).toStrictEqual({ success: true, value: "宿泊費" });
    expect(費目.parse("消耗品")).toStrictEqual({
      success: false,
      issues: [{ path: "$", message: 'Expected one of "交通費", "宿泊費", "飲食費"' }],
    });
    expect(費目.parse(1)).toStrictEqual({
      success: false,
      issues: [{ path: "$", message: 'Expected one of "交通費", "宿泊費", "飲食費"' }],
    });
  });

  it("says what each value means, where it is given", () => {
    const 状態 = enumOf(["DRAFT", "SUBMITTED"], { labels: { DRAFT: "下書き", SUBMITTED: "申請中" } });

    expect(状態.labels).toStrictEqual({ DRAFT: "下書き", SUBMITTED: "申請中" });
    expect(状態.parse("DRAFT")).toStrictEqual({ success: true, value: "DRAFT" });
    expect(状態.parse("下書き").success).toBe(false);
    expect("labels" in 費目).toBe(false);
    expect(() => enumOf(["DRAFT"], { labels: { DONE: "完了" } as never })).toThrow(
      new Error("enum labels DONE, which it does not name"),
    );
  });

  it("refuses no value, and a value named twice", () => {
    expect(() => enumOf([] as never)).toThrow(new Error("enum names no value"));
    expect(() => enumOf(["交通費", "交通費"])).toThrow(new Error("enum names 交通費 twice"));
  });

  it("stands in with the first value its rules keep", () => {
    expect(費目.placeholder()).toBe("交通費");
    expect(費目.refine(v => v.$ne("交通費")).placeholder()).toBe("宿泊費");
    expect(enumOf(["交通費"]).refine(v => v.$ne("交通費")).placeholder()).toBe("交通費");
  });

  it("stands in with a value every rule keeps, wherever the rule is written", () => {
    const 順不同 = enumOf(["b", "a", "c"]);

    expect(object({ 費目 }).refine(v => v.費目.$ne("交通費")).placeholder()).toStrictEqual({ 費目: "宿泊費" });
    expect(object({ x: 順不同 }).refine(v => v.x.$gt("b")).placeholder()).toStrictEqual({ x: "c" });
    expect(
      object({ x: enumOf(["a", "b", "c"]).refine(v => v.$ne("b")) })
        .refine(v => v.x.$ne("a"))
        .placeholder(),
    ).toStrictEqual({ x: "c" });
    expect(
      variants("k", { p: object({ x: 順不同, f: boolean() }) })
        .refine(v => v.x.$ne("b"))
        .placeholder(),
    ).toStrictEqual({ k: "p", x: "a", f: false });
  });

  it("divides its position into its values, less the ones an invariant refuses", () => {
    const 申請 = variants("状態", {
      下書き: object({ 費目, 精算方法: enumOf(["振込", "現金"]).refine(v => v.$ne("現金")) }),
    });

    expect(
      positionsOf(申請).map(position =>
        position.kind === "divided"
          ? { path: position.path, classes: position.classes, excluded: position.excluded }
          : position.path,
      ),
    ).toStrictEqual([
      { path: "@下書き.費目", classes: ["交通費", "宿泊費", "飲食費"], excluded: [] },
      { path: "@下書き.精算方法", classes: ["振込", "現金"], excluded: ["現金"] },
    ]);
  });
});

const 申請 = variants("状態", { 下書き: object({ 費目, 金額: int() }) });
const 申請する = behavior("申請する", {
  input: 申請,
  result: variants("結果", { 申請した: object({}), 領収書が要る: object({}) }),
  effects: variants("種類", {}),
});
type 答え = { readonly result: { readonly 結果: "申請した" | "領収書が要る" }; readonly effects: readonly never[] };
const 断る = (): 答え => ({ result: { 結果: "領収書が要る" }, effects: [] });
const 受ける = (): 答え => ({ result: { 結果: "申請した" }, effects: [] });

describe("an enum in the rules", () => {
  const 実装 = implement(申請する, {
    cases: {
      下書き: action("交通費だけ領収書なしで申請できる", {
        guards: r => [r.費目.$eq("交通費").$else(断る)],
        run: 受ける,
      }),
    },
  });

  it("reads a guard comparing it with one of its values", async () => {
    const report = await check(
      spec("申請する", {
        examples: examples(申請する, {
          タクシー: { given: { 状態: "下書き", 費目: "交通費", 金額: 1200 }, expect: 受ける() },
          ホテル: { given: { 状態: "下書き", 費目: "宿泊費", 金額: 8000 }, expect: 断る() },
          会食: { given: { 状態: "下書き", 費目: "飲食費", 金額: 5000 }, expect: 断る() },
        }),
        implementation: 実装,
      }),
    );

    expect(report.measures.comparisons).toStrictEqual({ status: "complete" });
    expect(report.verdict).toBe("satisfied");
  });

  it("does not read a guard ordering it against a value", async () => {
    const report = await check(
      spec("申請する", {
        examples: examples(申請する, {
          タクシー: { given: { 状態: "下書き", 費目: "交通費", 金額: 1200 }, expect: 受ける() },
        }),
        implementation: implement(申請する, {
          cases: {
            下書き: action("宿泊費より前の費目", {
              guards: r => [r.費目.$lt("宿泊費").$else(断る)],
              run: 受ける,
            }),
          },
        }),
      }),
    );

    expect(report.measures.comparisons).toStrictEqual({
      status: "partial",
      notRead: ['宿泊費より前の費目: $.費目 < "宿泊費"'],
    });
  });

  it("does not read a guard on its length, whose few values draw no border", async () => {
    const report = await check(
      spec("申請する", {
        examples: examples(申請する, {
          タクシー: { given: { 状態: "下書き", 費目: "交通費", 金額: 1200 }, expect: 受ける() },
        }),
        implementation: implement(申請する, {
          cases: {
            下書き: action("長い費目", { guards: r => [r.費目.$length().$gte(4).$else(断る)], run: 受ける }),
          },
        }),
      }),
    );

    expect(report.borders).toStrictEqual([]);
    expect(report.measures.comparisons).toStrictEqual({
      status: "partial",
      notRead: ["長い費目: length($.費目) >= 4"],
    });
  });

  it("asks for a row in each value no row stands in", () => {
    const { rows } = generate(
      examples(申請する, {
        タクシー: { given: { 状態: "下書き", 費目: "交通費", 金額: 1200 }, expect: 受ける() },
      }),
      実装,
    );

    expect(rows.map(row => row.given)).toStrictEqual([
      { 状態: "下書き", 費目: "宿泊費", 金額: 1200 },
      { 状態: "下書き", 費目: "飲食費", 金額: 1200 },
    ]);
  });

  it("lists no way asking for two of its values at once", async () => {
    const 両方 = implement(申請する, {
      cases: {
        下書き: action("交通費かつ宿泊費", {
          guards: r => [r.費目.$eq("交通費").$else(断る), r.費目.$eq("宿泊費").$else(断る)],
          run: 受ける,
        }),
      },
    });
    const report = await check(
      spec("申請する", {
        examples: examples(申請する, {
          タクシー: { given: { 状態: "下書き", 費目: "交通費", 金額: 1200 }, expect: 断る() },
          ホテル: { given: { 状態: "下書き", 費目: "宿泊費", 金額: 8000 }, expect: 断る() },
          会食: { given: { 状態: "下書き", 費目: "飲食費", 金額: 5000 }, expect: 断る() },
        }),
        implementation: 両方,
      }),
    );

    const rules = report.measures.rules.status === "complete" ? report.measures.rules.rules : [];
    expect(rules.find(rule => rule.way.endsWith("→ otherwise"))).toBe(undefined);
  });
});

describe("a match on an enum field", () => {
  const 実装 = implement(申請する, {
    cases: {
      下書き: action("費目で分ける", {
        run: match(r => r.費目, { 交通費: 受ける, 宿泊費: 断る, 飲食費: 断る }),
      }),
    },
  });

  it("takes an arm for each value, and a row is asked for each arm no row took", () => {
    const { rows } = generate(
      examples(申請する, {
        タクシー: { given: { 状態: "下書き", 費目: "交通費", 金額: 1200 }, expect: 受ける() },
      }),
      実装,
    );

    expect(rows.map(row => row.given)).toStrictEqual([
      { 状態: "下書き", 費目: "宿泊費", 金額: 1200 },
      { 状態: "下書き", 費目: "飲食費", 金額: 1200 },
    ]);
  });

  it("owes no row to the arm of a value an invariant refuses", async () => {
    const 通貨で分ける = behavior("通貨で分ける", {
      input: variants("状態", { 申請: object({ 通貨: enumOf(["JPY", "USD", "EUR"]).refine(v => v.$ne("EUR")) }) }),
      result: variants("結果", { 申請した: object({}), 領収書が要る: object({}) }),
      effects: variants("種類", {}),
    });
    const report = await check(
      spec("通貨で分ける", {
        examples: examples(通貨で分ける, {
          円: { given: { 状態: "申請", 通貨: "JPY" }, expect: 受ける() },
          ドル: { given: { 状態: "申請", 通貨: "USD" }, expect: 断る() },
        }),
        implementation: implement(通貨で分ける, {
          cases: { 申請: action("通貨で分ける", { run: match(r => r.通貨, { JPY: 受ける, USD: 断る, EUR: 断る }) }) },
        }),
      }),
    );

    const arms = report.measures.arms.status === "complete" ? report.measures.arms.arms : [];
    expect(arms.find(arm => arm.arm === "EUR")?.status).toBe("no row owed");
    expect(report.verdict).toBe("satisfied");
  });

  it("refuses at run time a match naming a value the enum does not", () => {
    expect(() =>
      implement(申請する, {
        cases: {
          下書き: action("費目で分ける", {
            run: match(r => r.費目, { 交通費: 受ける, 宿泊費: 断る, 飲食費: 断る, 消耗品: 断る } as never),
          }),
        },
      }),
    ).toThrow(new SpecificationError("match in 費目で分ける has a case 消耗品 the enum does not"));
  });

  it("refuses at run time a match whose cases are not the enum's values", () => {
    expect(() =>
      implement(申請する, {
        cases: {
          下書き: action("費目で分ける", {
            run: match(r => r.費目, { 交通費: 受ける, 宿泊費: 断る } as never),
          }),
        },
      }),
    ).toThrow(new SpecificationError("match in 費目で分ける has no case for 飲食費"));
  });

  it("refuses at run time a match on an enum that may be left out", () => {
    const 任意の費目で申請する = behavior("任意の費目で申請する", {
      input: variants("状態", { 下書き: object({ 費目: 費目.optional() }) }),
      result: 申請する.result,
      effects: 申請する.effects,
    });

    expect(() =>
      implement(任意の費目で申請する, {
        cases: {
          下書き: action("費目で分ける", {
            run: match(r => r.費目, { 交通費: 受ける, 宿泊費: 断る, 飲食費: 断る }),
          }),
        },
      }),
    ).toThrow(new SpecificationError("match in 費目で分ける selects $.費目, which may be left out at $.費目"));
  });
});

describe("an enum between two stages", () => {
  const 費目を答える = (answered: AnySchema) =>
    external(
      behavior("費目を答える", {
        input: variants("状態", { 申込: object({}) }),
        result: variants("結果", { 分類した: object({ 費目: answered }) }),
        effects: variants("種類", {}),
      }),
      "別のチーム",
    );
  const 受け取る = (taken: AnySchema) =>
    external(
      behavior("受け取る", {
        input: variants("結果", { 分類した: object({ 費目: taken }) }),
        result: variants("結果", { 受け取った: object({}) }),
        effects: variants("種類", {}),
      }),
      "別のチーム",
    );

  it("goes into a string or an enum taking each of its values", () => {
    expect(() => compose("文字列へ", [費目を答える(費目), 受け取る(string())])).not.toThrow();
    expect(() => compose("広い enum へ", [費目を答える(費目), 受け取る(enumOf(["交通費", "宿泊費", "飲食費", "消耗品"]))])).not.toThrow();
  });

  it("names the case of a sum the next stage takes, one per value", () => {
    const 決める = (種類: AnySchema) =>
      external(
        behavior("決める", {
          input: variants("状態", { 申込: object({}) }),
          result: variants("結果", { 決めた: object({ 支払: object({ 種類, 番号: string() }) }) }),
          effects: variants("種類", {}),
        }),
        "別のチーム",
      );
    const 払う = external(
      behavior("払う", {
        input: variants("結果", {
          決めた: object({ 支払: variants("種類", { カード: object({ 番号: string() }), 振込: object({ 番号: string() }) }) }),
        }),
        result: variants("結果", { 払った: object({}) }),
        effects: variants("種類", {}),
      }),
      "別のチーム",
    );

    expect(() => compose("支払", [決める(enumOf(["カード", "振込"])), 払う])).not.toThrow();
    expect(() => compose("支払", [決める(enumOf(["カード", "現金"])), 払う])).toThrow(
      new SpecificationError("決める answers @決めた.支払@現金, which 払う does not declare"),
    );
  });

  it("refuses a narrower enum, and a string into an enum", () => {
    expect(() => compose("狭い enum へ", [費目を答える(費目), 受け取る(enumOf(["交通費", "宿泊費"]))])).toThrow(
      new SpecificationError(
        '費目を答える answers @分類した.費目 as enum "交通費" | "宿泊費" | "飲食費", which 受け取る takes as enum "交通費" | "宿泊費"',
      ),
    );
    expect(() => compose("文字列から", [費目を答える(string()), 受け取る(費目)])).toThrow(
      new SpecificationError(
        '費目を答える answers @分類した.費目 as string, which 受け取る takes as enum "交通費" | "宿泊費" | "飲食費"',
      ),
    );
  });
});

describe("an enum in what a behavior ensures", () => {
  it("is read as an exact match", async () => {
    const 仕分ける = behavior("仕分ける", {
      input: variants("状態", { 下書き: object({ 費目 }) }),
      result: variants("結果", { 仕分けた: object({ 費目 }) }),
      effects: variants("種類", {}),
      ensures: clause => [clause.when("費目を変えない", ["仕分けた"], (input, value) => value.費目.$eq(input.費目))],
    });

    const report = await check(spec("仕分ける", { examples: examples(仕分ける, {}) }));
    expect(report.ensures.rules.map(rule => rule.classification)).toStrictEqual(["exact match"]);
  });
});

describe("a value an invariant refuses, beyond enums", () => {
  const 答え = variants("結果", { ok: object({}) });
  const ok = () => ({ result: { 結果: "ok" as const }, effects: [] });

  it("owes no row to the arm of a boolean it refuses", async () => {
    const 至急 = behavior("至急", {
      input: variants("状態", { 申請: object({ 至急: boolean().refine(v => v.$eq(true)) }) }),
      result: 答え,
      effects: variants("種類", {}),
    });
    const report = await check(
      spec("至急", {
        examples: examples(至急, { 至急: { given: { 状態: "申請", 至急: true }, expect: ok() } }),
        implementation: implement(至急, { cases: { 申請: action("至急なら", { guards: r => [r.至急.$eq(true).$else(ok)], run: ok }) } }),
      }),
    );

    const arms = report.measures.arms.status === "complete" ? report.measures.arms.arms : [];
    expect(arms.find(arm => arm.arm === "else")?.status).toBe("no row owed");
  });

  it("owes no row to the arm of a case a sum's invariant refuses", async () => {
    const 支払 = variants("種類", {
      カード: object({ 番号: string() }),
      小切手: object({ 番号: string() }),
    }).refine(v => v.種類.$ne("小切手"));
    const 払う = behavior("払う", {
      input: variants("状態", { 申請: object({ 支払 }) }),
      result: 答え,
      effects: variants("種類", {}),
    });
    const report = await check(
      spec("払う", {
        examples: examples(払う, { カード: { given: { 状態: "申請", 支払: { 種類: "カード", 番号: "1" } }, expect: ok() } }),
        implementation: implement(払う, { cases: { 申請: action("支払で分ける", { run: match(r => r.支払.種類, { カード: ok, 小切手: ok }) }) } }),
      }),
    );

    const arms = report.measures.arms.status === "complete" ? report.measures.arms.arms : [];
    expect(arms.find(arm => arm.arm === "小切手")?.status).toBe("no row owed");
    expect(report.verdict).toBe("satisfied");
  });
});
