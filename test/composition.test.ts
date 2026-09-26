import { describe, expect, it } from "vitest";
import type { AnySchema } from "../src/index.js";
import {
  array,
  generate,
  todo,
  action,
  behavior,
  compose,
  date,
  instant,
  spec,
  check,
  example,
  examples,
  external,
  implement,
  int,
  literal,
  number,
  object,
  record,
  perform,
  SpecificationError,
  string,
  variants,
} from "../src/index.js";

const 検証する = behavior("検証する", {
  input: variants("状態", { 申込: object({ 数量: int() }) }),
  result: variants("結果", {
    有効: object({ 数量: int() }),
    無効: object({ 理由: string() }),
  }),
  effects: variants("種類", {}),
});

const 価格を付ける = behavior("価格を付ける", {
  input: variants("結果", { 有効: object({ 数量: int() }) }),
  result: variants("結果", { 見積: object({ 金額: int() }) }),
  effects: variants("種類", { 通知: object({ 金額: int() }) }),
});


const 検証するの実装 = implement(検証する, {
  cases: {
    申込: action("数量を確かめる", {
      guards: 申込 => [申込.数量.$gte(1).$else(() => ({ result: { 結果: "無効", 理由: "数量なし" }, effects: [] }))],
      run: 申込 => ({ result: { 結果: "有効", 数量: 申込.数量 }, effects: [] }),
    }),
  },
});

const 価格を付けるの実装 = implement(価格を付ける, {
  cases: {
    有効: {
      kind: "decision",
      id: "単価100円",
      run: 有効 => ({
        result: { 結果: "見積", 金額: 有効.数量 * 100 },
        effects: [{ 種類: "通知", 金額: 有効.数量 * 100 }],
      }),
    },
  },
  controls: {
    通知: { execution: "outbox", idempotency: "required", compensation: "none" },
  },
});

const [見積もる, 見積もるの実装] = compose("見積もる", [検証するの実装, 価格を付けるの実装]);

describe("compose", () => {
  it("takes the first stage's input and answers the cases the second stage did not consume beside its own", () => {
    expect({
      name: 見積もる.name,
      input: 見積もる.input.variantTags,
      result: 見積もる.result.variantTags,
      effects: 見積もる.effects.variantTags,
    }).toStrictEqual({
      name: "見積もる",
      input: ["申込"],
      result: ["無効", "見積"],
      effects: ["通知"],
    });
  });

  it("refuses stages where the second receives none of the first's cases", () => {
    const 別物 = behavior("別物", {
      input: variants("結果", { 保留: object({}) }),
      result: variants("結果", { 完了: object({}) }),
      effects: variants("種類", {}),
    });

    expect(() => compose("別物につなぐ", [検証するの実装, external(別物, "別のチーム")])).toThrow(
      new SpecificationError("別物 receives none of the cases 検証する answers"),
    );
  });

  it("refuses a case that would be both departed and answered by the second stage", () => {
    const 無効も返す = behavior("無効も返す", {
      input: variants("結果", { 有効: object({ 数量: int() }) }),
      result: variants("結果", { 無効: object({ 理由: string() }) }),
      effects: variants("種類", {}),
    });

    expect(() => compose("無効も返す合成", [検証するの実装, external(無効も返す, "別のチーム")])).toThrow(
      new SpecificationError(
        "無効 departs 検証する and is answered by 無効も返す; a value cannot say which rail it is on",
      ),
    );
  });

  it("refuses a case the first stage answers with a field the second stage does not declare", () => {
    const 数量だけ受け取る = behavior("数量だけ受け取る", {
      input: variants("結果", { 有効: object({}) }),
      result: variants("結果", { 見積: object({}) }),
      effects: variants("種類", {}),
    });

    expect(() => compose("数量を落とす合成", [検証するの実装, external(数量だけ受け取る, "別のチーム")])).toThrow(
      new SpecificationError("検証する answers @有効.数量, which 数量だけ受け取る does not declare"),
    );
  });

  describe("refusing a field the second stage does not declare below the case", () => {
    const 明細 = object({ 商品: string(), 単価: int() });
    const 単価を知らない = object({ 商品: string() });
    const 明細を返す = external(
      behavior("明細を返す", {
        input: variants("状態", { 申込: object({}) }),
        result: variants("結果", {
          有効: object({
            主: 明細,
            一覧: array(明細),
            補足: 明細.optional(),
            索引: record(明細),
            支払: variants("方法", { 現金: object({ 金額: int() }) }),
          }),
        }),
        effects: variants("種類", {}),
      }),
      "別のチーム",
    );
    const 受け取る = (shape: Record<string, AnySchema>) =>
      external(
        behavior("受け取る", {
          input: variants("結果", {
            有効: object({
              主: 明細,
              一覧: array(明細),
              補足: 明細.optional(),
              索引: record(明細),
              支払: variants("方法", { 現金: object({ 金額: int() }) }),
              ...shape,
            }),
          }),
          result: variants("結果", { 見積: object({}) }),
          effects: variants("種類", {}),
        }),
        "別のチーム",
      );

    it("refuses one inside a nested object", () => {
      expect(() => compose("主", [明細を返す, 受け取る({ 主: 単価を知らない })])).toThrow(
        new SpecificationError("明細を返す answers @有効.主.単価, which 受け取る does not declare"),
      );
    });

    it("refuses one inside an array element", () => {
      expect(() => compose("一覧", [明細を返す, 受け取る({ 一覧: array(単価を知らない) })])).toThrow(
        new SpecificationError("明細を返す answers @有効.一覧[].単価, which 受け取る does not declare"),
      );
    });

    it("refuses one inside what an optional holds", () => {
      expect(() => compose("補足", [明細を返す, 受け取る({ 補足: 単価を知らない.optional() })])).toThrow(
        new SpecificationError("明細を返す answers @有効.補足?.単価, which 受け取る does not declare"),
      );
    });

    it("refuses one inside a record value", () => {
      expect(() => compose("索引", [明細を返す, 受け取る({ 索引: record(単価を知らない) })])).toThrow(
        new SpecificationError("明細を返す answers @有効.索引{}.単価, which 受け取る does not declare"),
      );
    });

    it("refuses one inside a case of a nested sum both stages declare", () => {
      expect(() =>
        compose("支払", [明細を返す, 受け取る({ 支払: variants("方法", { 現金: object({}) }) })]),
      ).toThrow(new SpecificationError("明細を返す answers @有効.支払@現金.金額, which 受け取る does not declare"));
    });
  });

  it("refuses a case of a nested sum that the second stage does not declare", () => {
    const 支払方法を返す = behavior("支払方法を返す", {
      input: variants("状態", { 申込: object({}) }),
      result: variants("結果", {
        有効: object({ 支払: variants("方法", { 現金: object({}), カード: object({ 番号: string() }) }) }),
      }),
      effects: variants("種類", {}),
    });
    const 現金だけ受け取る = behavior("現金だけ受け取る", {
      input: variants("結果", { 有効: object({ 支払: variants("方法", { 現金: object({}) }) }) }),
      result: variants("結果", { 見積: object({}) }),
      effects: variants("種類", {}),
    });

    expect(() =>
      compose("現金だけの合成", [external(支払方法を返す, "別のチーム"), external(現金だけ受け取る, "別のチーム")]),
    ).toThrow(new SpecificationError("支払方法を返す answers @有効.支払@カード, which 現金だけ受け取る does not declare"));
  });

  describe("refusing a field the second stage requires but the first stage does not always answer", () => {
    const 段 = (answered: Record<string, AnySchema>, taken: Record<string, AnySchema>) =>
      [
        external(
          behavior("返す", {
            input: variants("状態", { 申込: object({}) }),
            result: variants("結果", { 有効: object(answered) }),
            effects: variants("種類", {}),
          }),
          "別のチーム",
        ),
        external(
          behavior("受け取る", {
            input: variants("結果", { 有効: object(taken) }),
            result: variants("結果", { 見積: object({}) }),
            effects: variants("種類", {}),
          }),
          "別のチーム",
        ),
      ] as const;

    it("refuses a required field the first stage does not answer at all", () => {
      expect(() => compose("価格なし", 段({ 数量: int() }, { 数量: int(), 価格: int() }))).toThrow(
        new SpecificationError("返す does not always answer @有効.価格, which 受け取る requires"),
      );
    });

    it("refuses a required field the first stage answers only as optional", () => {
      expect(() => compose("価格は任意", 段({ 価格: int().optional() }, { 価格: int() }))).toThrow(
        new SpecificationError("返す does not always answer @有効.価格, which 受け取る requires"),
      );
    });

    it("refuses a required field missing from an array element", () => {
      expect(() =>
        compose("明細の価格なし", 段({ 明細: array(object({ 数量: int() })) }, { 明細: array(object({ 数量: int(), 価格: int() })) })),
      ).toThrow(new SpecificationError("返す does not always answer @有効.明細[].価格, which 受け取る requires"));
    });

    it("refuses a required field one case of an answered sum does not carry", () => {
      expect(() =>
        compose(
          "現金には番号なし",
          段(
            { 支払: variants("方法", { 現金: object({}), カード: object({ 番号: string() }) }) },
            { 支払: object({ 方法: string(), 番号: string() }) },
          ),
        ),
      ).toThrow(new SpecificationError("返す does not always answer @有効.支払@現金.番号, which 受け取る requires"));
    });

    it("accepts an optional field answered into a record, which requires no key", () => {
      expect(() =>
        compose("表で受け取る", 段({ 価格: object({ りんご: int().optional() }) }, { 価格: record(int()) })),
      ).not.toThrow();
    });
  });

  describe("refusing a value of a type the second stage does not take", () => {
    const 段 = (answered: AnySchema, taken: AnySchema) =>
      [
        external(
          behavior("返す", {
            input: variants("状態", { 申込: object({}) }),
            result: variants("結果", { 有効: object({ 値: answered }) }),
            effects: variants("種類", {}),
          }),
          "別のチーム",
        ),
        external(
          behavior("受け取る", {
            input: variants("結果", { 有効: object({ 値: taken }) }),
            result: variants("結果", { 見積: object({}) }),
            effects: variants("種類", {}),
          }),
          "別のチーム",
        ),
      ] as const;

    it("refuses a leaf of another type", () => {
      expect(() => compose("型違い", 段(array(int()), array(string())))).toThrow(
        new SpecificationError("返す answers @有効.値[] as integer, which 受け取る takes as string"),
      );
    });

    it("refuses a container of another kind", () => {
      expect(() => compose("配列を object で", 段(array(int()), object({})))).toThrow(
        new SpecificationError("返す answers @有効.値 as array, which 受け取る takes as object"),
      );
    });

    it("accepts a literal where the second stage takes its type", () => {
      expect(() => compose("リテラルを文字列で", 段(literal("現金"), string()))).not.toThrow();
    });

    it("refuses a string where the second stage takes one literal", () => {
      expect(() => compose("文字列をリテラルで", 段(string(), literal("現金")))).toThrow(
        new SpecificationError('返す answers @有効.値 as string, which 受け取る takes as literal "現金"'),
      );
    });

    it("refuses a literal of another value", () => {
      expect(() => compose("別のリテラル", 段(literal("カード"), literal("現金")))).toThrow(
        new SpecificationError('返す answers @有効.値 as literal "カード", which 受け取る takes as literal "現金"'),
      );
    });

    it("accepts an integer where the second stage takes a number", () => {
      expect(() => compose("整数を数値で", 段(int(), number()))).not.toThrow();
    });

    it("refuses a number where the second stage takes an integer, since it may not be whole", () => {
      expect(() => compose("数値を整数で", 段(number(), int()))).toThrow(
        new SpecificationError("返す answers @有効.値 as number, which 受け取る takes as integer"),
      );
    });

    it("refuses a date where the second stage takes an instant, since a date names no moment", () => {
      expect(() => compose("日付を時刻で", 段(date(), instant()))).toThrow(
        new SpecificationError("返す answers @有効.値 as date, which 受け取る takes as instant"),
      );
    });

    it("refuses a case of an answered sum whose tag the object's discriminant literal does not take", () => {
      expect(() =>
        compose("カードを現金で", 段(variants("方法", { カード: object({}) }), object({ 方法: literal("現金") }))),
      ).toThrow(new SpecificationError('返す answers @有効.値@カード.方法 as literal "カード", which 受け取る takes as literal "現金"'));
    });

    it("accepts a sum where the second stage takes a record whose value every tag and field fits", () => {
      expect(() =>
        compose("sum を表で", 段(variants("方法", { カード: object({ 番号: string() }) }), record(string()))),
      ).not.toThrow();
    });

    it("refuses a sum where a case carries a field the record's value does not take", () => {
      expect(() =>
        compose("sum を数値の表で", 段(variants("方法", { カード: object({ 回数: int() }) }), record(string()))),
      ).toThrow(new SpecificationError("返す answers @有効.値@カード.回数 as integer, which 受け取る takes as string"));
    });

    it("refuses a record where the second stage takes an object, since a record may carry any key", () => {
      expect(() => compose("表を object で", 段(record(int()), object({ 数量: int().optional() })))).toThrow(
        new SpecificationError("返す answers @有効.値 as record, which 受け取る takes as object"),
      );
    });

    it("refuses a number literal the number parser does not take, such as Infinity", () => {
      expect(() => compose("無限大", 段(literal(Infinity), number()))).toThrow(
        new SpecificationError("返す answers @有効.値 as literal Infinity, which 受け取る takes as number"),
      );
    });

    it("refuses an integer literal beyond the safe integers the integer parser takes", () => {
      expect(() => compose("大きすぎる整数", 段(literal(2 ** 53), int()))).toThrow(
        new SpecificationError("返す answers @有効.値 as literal 9007199254740992, which 受け取る takes as integer"),
      );
    });

    it("leaves invariants to run time", () => {
      expect(() => compose("範囲は実行時", 段(int(), int().refine(v => v.$gte(1))))).not.toThrow();
    });

    it("parses a literal with the second stage's schema, invariants included, since it has one value", () => {
      expect(() => compose("範囲外のリテラル", 段(literal(0), int().refine(v => v.$gte(1))))).toThrow(
        new SpecificationError("返す answers @有効.値 as literal 0, which 受け取る takes as integer"),
      );
    });
  });

  it("refuses a nested sum whose discriminant the second stage names differently", () => {
    const 方法で返す = behavior("方法で返す", {
      input: variants("状態", { 申込: object({}) }),
      result: variants("結果", { 有効: object({ 支払: variants("方法", { カード: object({}) }) }) }),
      effects: variants("種類", {}),
    });
    const 種別で受け取る = behavior("種別で受け取る", {
      input: variants("結果", { 有効: object({ 支払: variants("種別", { カード: object({}) }) }) }),
      result: variants("結果", { 見積: object({}) }),
      effects: variants("種類", {}),
    });

    expect(() =>
      compose("判別キー違いの合成", [external(方法で返す, "別のチーム"), external(種別で受け取る, "別のチーム")]),
    ).toThrow(new SpecificationError("方法で返す answers @有効.支払.方法, which 種別で受け取る does not declare"));
  });

  it("compares the tag itself, not the type a first stage's case declares for its discriminant", () => {
    const 文字列で宣言する = behavior("文字列で宣言する", {
      input: variants("状態", { 申込: object({}) }),
      result: variants("結果", { 有効: object({ 結果: string(), 番号: int() }) }),
      effects: variants("種類", {}),
    });
    const リテラルで受け取る = behavior("リテラルで受け取る", {
      input: variants("結果", { 有効: object({ 結果: literal("有効"), 番号: int() }) }),
      result: variants("結果", { 見積: object({}) }),
      effects: variants("種類", {}),
    });

    expect(() =>
      compose("判別キーは値で比べる", [external(文字列で宣言する, "別のチーム"), external(リテラルで受け取る, "別のチーム")]),
    ).not.toThrow();
  });

  it("compares the tag that flows with a discriminant the second stage's case declares for itself", () => {
    const 返す = behavior("状態を宣言せず返す", {
      input: variants("状態", { 申込: object({}) }),
      result: variants("結果", { 有効: object({ 番号: int() }) }),
      effects: variants("種類", {}),
    });
    const 受け取る = behavior("別の状態で受け取る", {
      input: variants("結果", { 有効: object({ 結果: literal("無効"), 番号: int() }) }),
      result: variants("結果", { 見積: object({}) }),
      effects: variants("種類", {}),
    });

    expect(() => compose("状態違い", [external(返す, "別のチーム"), external(受け取る, "別のチーム")])).toThrow(
      new SpecificationError('状態を宣言せず返す answers @有効.結果 as literal "有効", which 別の状態で受け取る takes as literal "無効"'),
    );
  });

  it("still refuses a nested field that only shares its name with the discriminant", () => {
    const 詳細を返す = behavior("詳細を返す", {
      input: variants("状態", { 申込: object({}) }),
      result: variants("結果", { 有効: object({ 詳細: object({ 結果: string() }) }) }),
      effects: variants("種類", {}),
    });
    const 空の詳細で受け取る = behavior("空の詳細で受け取る", {
      input: variants("結果", { 有効: object({ 詳細: object({}) }) }),
      result: variants("結果", { 見積: object({}) }),
      effects: variants("種類", {}),
    });

    expect(() =>
      compose("詳細の合成", [external(詳細を返す, "別のチーム"), external(空の詳細で受け取る, "別のチーム")]),
    ).toThrow(new SpecificationError("詳細を返す answers @有効.詳細.結果, which 空の詳細で受け取る does not declare"));
  });

  describe("a nested sum the second stage takes as a plain object", () => {
    const 支払 = variants("方法", { 現金: object({}), カード: object({ 番号: string(), 暗証: string() }) });
    const 段 = (taken: AnySchema) =>
      [
        external(
          behavior("支払を返す", {
            input: variants("状態", { 申込: object({}) }),
            result: variants("結果", { 有効: object({ 支払 }) }),
            effects: variants("種類", {}),
          }),
          "別のチーム",
        ),
        external(
          behavior("object で受け取る", {
            input: variants("結果", { 有効: object({ 支払: taken }) }),
            result: variants("結果", { 見積: object({}) }),
            effects: variants("種類", {}),
          }),
          "別のチーム",
        ),
      ] as const;

    it("refuses when the object does not declare the sum's discriminant", () => {
      expect(() =>
        compose("判別キーなし", 段(object({ 番号: string().optional(), 暗証: string().optional() }))),
      ).toThrow(new SpecificationError("支払を返す answers @有効.支払.方法, which object で受け取る does not declare"));
    });

    it("refuses when the object does not declare a field one of the cases carries", () => {
      expect(() =>
        compose("暗証なし", 段(object({ 方法: string(), 番号: string().optional() }))),
      ).toThrow(new SpecificationError("支払を返す answers @有効.支払@カード.暗証, which object で受け取る does not declare"));
    });

    it("accepts an object declaring the discriminant and every field of every case", () => {
      expect(() =>
        compose(
          "すべて宣言",
          段(object({ 方法: string(), 番号: string().optional(), 暗証: string().optional() })),
        ),
      ).not.toThrow();
    });
  });

  describe("a plain object the second stage takes as a nested sum", () => {
    const 受け取る支払 = variants("方法", { 現金: object({}), カード: object({ 番号: string() }) });
    const 段 = (answered: AnySchema) =>
      [
        external(
          behavior("object で返す", {
            input: variants("状態", { 申込: object({}) }),
            result: variants("結果", { 有効: object({ 支払: answered }) }),
            effects: variants("種類", {}),
          }),
          "別のチーム",
        ),
        external(
          behavior("sum で受け取る", {
            input: variants("結果", { 有効: object({ 支払: 受け取る支払 }) }),
            result: variants("結果", { 見積: object({}) }),
            effects: variants("種類", {}),
          }),
          "別のチーム",
        ),
      ] as const;

    it("compares the object with the case its literal discriminant names", () => {
      expect(() =>
        compose("暗証つき", 段(object({ 方法: literal("カード"), 番号: string(), 暗証: string() }))),
      ).toThrow(new SpecificationError("object で返す answers @有効.支払.暗証, which sum で受け取る does not declare"));
    });

    it("refuses when the case its literal discriminant names is not declared", () => {
      expect(() => compose("振込", 段(object({ 方法: literal("振込") })))).toThrow(
        new SpecificationError("object で返す answers @有効.支払@振込, which sum で受け取る does not declare"),
      );
    });

    it("refuses an object that does not answer the discriminant the sum needs", () => {
      expect(() => compose("方法なし", 段(object({ 番号: string() })))).toThrow(
        new SpecificationError("object で返す does not always answer @有効.支払.方法, which sum で受け取る requires"),
      );
    });

    it("refuses an object whose discriminant is a string, which may name no case", () => {
      expect(() => compose("方法は文字列", 段(object({ 方法: string(), 番号: string() })))).toThrow(
        new SpecificationError('object で返す answers @有効.支払.方法 as string, which sum で受け取る takes as "現金" | "カード"'),
      );
    });

    it("refuses an object whose discriminant is a literal that is not a string, which never names a case", () => {
      expect(() => compose("方法は数値", 段(object({ 方法: literal(1) })))).toThrow(
        new SpecificationError('object で返す answers @有効.支払.方法 as literal 1, which sum で受け取る takes as "現金" | "カード"'),
      );
    });

    it("does not read a discriminant named like an Object.prototype member from the prototype", () => {
      const [返す, 受け取る] = [
        external(
          behavior("構築子なしで返す", {
            input: variants("状態", { 申込: object({}) }),
            result: variants("結果", { 有効: object({ 支払: object({}) }) }),
            effects: variants("種類", {}),
          }),
          "別のチーム",
        ),
        external(
          behavior("構築子で受け取る", {
            input: variants("結果", { 有効: object({ 支払: variants("constructor", { 現金: object({}) }) }) }),
            result: variants("結果", { 見積: object({}) }),
            effects: variants("種類", {}),
          }),
          "別のチーム",
        ),
      ];

      expect(() => compose("構築子", [返す, 受け取る])).toThrow(
        new SpecificationError("構築子なしで返す does not always answer @有効.支払.constructor, which 構築子で受け取る requires"),
      );
    });
  });

  it("does not count the discriminant a first stage's case declares for itself as undeclared", () => {
    const 状態を宣言する = behavior("状態を宣言する", {
      input: variants("状態", { 申込: object({}) }),
      result: variants("結果", {
        有効: object({ 結果: literal("有効"), 支払: variants("方法", { 現金: object({ 方法: literal("現金") }) }) }),
      }),
      effects: variants("種類", {}),
    });
    const 状態を宣言しない = behavior("状態を宣言しない", {
      input: variants("結果", { 有効: object({ 支払: variants("方法", { 現金: object({}) }) }) }),
      result: variants("結果", { 見積: object({}) }),
      effects: variants("種類", {}),
    });

    expect(() =>
      compose("判別キーを宣言する合成", [
        external(状態を宣言する, "別のチーム"),
        external(状態を宣言しない, "別のチーム"),
      ]),
    ).not.toThrow();
  });

  it("compares each field of an object the first stage answers with the record value the second stage takes", () => {
    const 品目ごとに返す = behavior("品目ごとに返す", {
      input: variants("状態", { 申込: object({}) }),
      result: variants("結果", {
        有効: object({ 価格: object({ りんご: object({ 金額: int(), 通貨: string() }) }) }),
      }),
      effects: variants("種類", {}),
    });
    const 金額だけの表で受け取る = behavior("金額だけの表で受け取る", {
      input: variants("結果", { 有効: object({ 価格: record(object({ 金額: int() })) }) }),
      result: variants("結果", { 見積: object({}) }),
      effects: variants("種類", {}),
    });

    expect(() =>
      compose("表で受け取る合成", [
        external(品目ごとに返す, "別のチーム"),
        external(金額だけの表で受け取る, "別のチーム"),
      ]),
    ).toThrow(
      new SpecificationError("品目ごとに返す answers @有効.価格.りんご.通貨, which 金額だけの表で受け取る does not declare"),
    );
  });

  describe("comparing through an optional on only one side of the join", () => {
    const 明細 = object({ 商品: string(), 単価: int() });
    const 単価を知らない = object({ 商品: string() });
    const 段 = (name: string, answered: AnySchema, taken: AnySchema) =>
      [
        external(
          behavior(`${name}を返す`, {
            input: variants("状態", { 申込: object({}) }),
            result: variants("結果", { 有効: object({ 主: answered }) }),
            effects: variants("種類", {}),
          }),
          "別のチーム",
        ),
        external(
          behavior(`${name}を受け取る`, {
            input: variants("結果", { 有効: object({ 主: taken }) }),
            result: variants("結果", { 見積: object({}) }),
            effects: variants("種類", {}),
          }),
          "別のチーム",
        ),
      ] as const;

    it("compares an answered field with what the optional the second stage takes holds", () => {
      expect(() => compose("任意で受け取る", 段("必須", 明細, 単価を知らない.optional()))).toThrow(
        new SpecificationError("必須を返す answers @有効.主.単価, which 必須を受け取る does not declare"),
      );
    });

    it("compares what an answered optional holds with the field the second stage takes", () => {
      expect(() => compose("任意で返す", 段("任意", 明細.optional(), 単価を知らない))).toThrow(
        new SpecificationError("任意を返す answers @有効.主?.単価, which 任意を受け取る does not declare"),
      );
    });
  });
});

describe("running a composition", () => {
  it("passes a case the second stage receives on to it", async () => {
    expect(await perform(見積もるの実装, { 状態: "申込", 数量: 2 })).toStrictEqual({
      result: { 結果: "見積", 金額: 200 },
      effects: [{ 種類: "通知", 金額: 200 }],
    });
  });

  it("answers a case the second stage does not receive as it departed", async () => {
    expect(await perform(見積もるの実装, { 状態: "申込", 数量: 0 })).toStrictEqual({
      result: { 結果: "無効", 理由: "数量なし" },
      effects: [],
    });
  });

  it("keeps a departed case off the main line of a later stage that could receive it", async () => {
    const 無効を受ける = behavior("無効を受ける", {
      input: variants("結果", {
        見積: object({ 金額: int() }),
        無効: object({ 理由: string() }),
      }),
      result: variants("結果", { 完了: object({}) }),
      effects: variants("種類", {}),
    });
    const 無効を受けるの実装 = implement(無効を受ける, {
      cases: {
        見積: { kind: "decision", id: "見積を完了", run: () => ({ result: { 結果: "完了" }, effects: [] }) },
        無効: { kind: "decision", id: "無効を完了", run: () => ({ result: { 結果: "完了" }, effects: [] }) },
      },
    });
    const [三段, 三段の実装] = compose("三段", [検証するの実装, 価格を付けるの実装, 無効を受けるの実装]);

    expect({
      result: 三段.result.variantTags,
      answer: await perform(三段の実装, {
        状態: "申込",
        数量: 0,
      }),
    }).toStrictEqual({
      result: ["無効", "完了"],
      answer: { result: { 結果: "無効", 理由: "数量なし" }, effects: [] },
    });
  });
});

describe("the adequacy of a composition", () => {
  const 行 = examples(見積もる, {
    "2個": {
      given: { 状態: "申込", 数量: 2 },
      expect: { result: { 結果: "見積", 金額: 200 }, effects: [{ 種類: "通知", 金額: 200 }] },
    },
    "0個は無効": {
      given: { 状態: "申込", 数量: 0 },
      expect: { result: { 結果: "無効", 理由: "数量なし" }, effects: [] },
    },
  });

  it("is measured over the composition's own cases, including one that departed early", async () => {
    const report = await check(
      spec("見積", { examples: 行, implementation: 見積もるの実装 }),
    );

    expect({
      failures: report.failures,
      result: report.result,
      arms: report.measures.arms,
      rules: report.measures.rules,
      verdict: report.verdict,
    }).toStrictEqual({
      failures: [],
      result: { covered: ["無効", "見積"], missing: [], excluded: [], total: 2 },
      arms: { status: "unavailable", reason: "not applicable" },
      rules: { status: "unavailable", reason: "not applicable" },
      verdict: "satisfied",
    });
  });

  it("offers rows for a composition with none", () => {
    expect(generate(見積もる).rows.map(row => row.given)).toStrictEqual([
      { 状態: "申込", 数量: 0 },
    ]);
  });
});

describe("a composition row whose answer is owed", () => {
  it("still runs the composition, so the case it reached is executed", async () => {
    const report = await check(
      spec("見積", {
        examples: examples(見積もる, {
          "3個": { given: { 状態: "申込", 数量: 3 }, expect: todo("未定") },
        }),
        implementation: 見積もるの実装,
      }),
    );

    expect(report.evidence.input).toStrictEqual([
      { case: "申込", specified: false, executed: true, verified: false },
    ]);
  });
});

describe("composing a composition", () => {
  it("takes a composition as a stage, implemented by its own implementation", async () => {
    const 無効を受ける = behavior("無効を受ける", {
      input: variants("結果", { 見積: object({ 金額: int() }), 無効: object({ 理由: string() }) }),
      result: variants("結果", { 完了: object({}) }),
      effects: variants("種類", {}),
    });
    const 無効を受けるの実装 = implement(無効を受ける, {
      cases: {
        見積: action("見積を完了", { run: () => ({ result: { 結果: "完了" as const }, effects: [] }) }),
        無効: action("無効を完了", { run: () => ({ result: { 結果: "完了" as const }, effects: [] }) }),
      },
    });

    expect(
      await perform(compose("入れ子", [見積もるの実装, 無効を受けるの実装])[1], {
        状態: "申込",
        数量: 2,
      }),
    ).toStrictEqual({ result: { 結果: "完了" }, effects: [{ 種類: "通知", 金額: 200 }] });
  });

});

describe("the stages a composition is given", () => {
  it("are at least two, at compile time", () => {
    // @ts-expect-error a composition needs two stages or more
    expect(() => compose("一段", [検証するの実装])).toThrow(SpecificationError);
  });
});

describe("a composition whose stages are still todo", () => {
  const 検証するの雛形 = implement(検証する, { cases: { 申込: todo("申込の判断が未定") } });
  const 価格を付けるの雛形 = implement(価格を付ける, { cases: { 有効: todo("有効の判断が未定") } });
  const [雛形の合成, 雛形の合成の実装] = compose("雛形の合成", [検証するの雛形, 価格を付けるの雛形]);

  it("lists each stage's open decision and counts no row as a failure", async () => {
    const report = await check(
      spec("雛形", {
        examples: examples(雛形の合成, {
          "2個": {
            given: { 状態: "申込", 数量: 2 },
            expect: { result: { 結果: "見積", 金額: 200 }, effects: [{ 種類: "通知", 金額: 200 }] },
          },
        }),
        implementation: 雛形の合成の実装,
      }),
    );

    expect({
      failures: report.failures,
      pending: report.pendingDecisions,
      incompleteness: report.incompleteness,
    }).toStrictEqual({
      failures: [],
      pending: [
        { variant: "検証する: 申込", reason: "申込の判断が未定" },
        { variant: "価格を付ける: 有効", reason: "有効の判断が未定" },
      ],
      incompleteness: [
        { kind: "row not run", subject: "2個", reason: "判断が未定（検証する: 申込）" },
      ],
    });
  });
});
