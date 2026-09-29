import { describe, expect, it } from "vitest";
import {
  action,
  behavior,
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

  it("stands in the same way for a rule an object writes on its enum field", () => {
    const 明細 = object({ 費目 }).refine(v => v.費目.$ne("交通費"));

    expect(明細.placeholder()).toStrictEqual({ 費目: "宿泊費" });
  });

  it("divides its position into its values, less the ones an invariant refuses", () => {
    const 申請 = variants("状態", {
      下書き: object({ 費目, 精算方法: enumOf(["振込", "現金"]).refine(v => v.$ne("現金")) }),
    });

    expect(
      positionsOf(申請).map(position =>
        position.kind === "divided" ? { path: position.path, classes: position.classes } : position.path,
      ),
    ).toStrictEqual([
      { path: "@下書き.費目", classes: ["交通費", "宿泊費", "飲食費"] },
      { path: "@下書き.精算方法", classes: ["振込", "現金"] },
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

  it("owes no row to a way asking for two of its values at once", async () => {
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
    expect(rules.find(rule => rule.way.endsWith("→ otherwise"))?.status).toBe("no row owed");
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
