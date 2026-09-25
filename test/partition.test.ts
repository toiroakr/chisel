import { describe, expect, it } from "vitest";
import {
  array,
  boolean,
  int,
  instant,
  number,
  object,
  optional,
  positionsOf,
  record,
  string,
  variants,
} from "../src/index.js";
import type { DividedPosition, Position } from "../src/index.js";

function summary(position: Position) {
  return position.kind === "divided"
    ? { path: position.path, classes: position.classes }
    : { path: position.path, kind: position.kind };
}

describe("positionsOf", () => {
  it("divides an optional field into the classes なし and あり", () => {
    const Cart = variants("状態", {
      商品あり: object({ クーポン: optional(string("クーポンコード")) }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.クーポン", classes: ["なし", "あり"] },
      { path: "@商品あり.クーポン?", kind: "not-derivable" },
    ]);
  });

  it("divides a boolean field into the classes true and false", () => {
    const Cart = variants("状態", {
      商品あり: object({ ギフト包装: boolean() }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.ギフト包装", classes: ["true", "false"] },
    ]);
  });

  it("divides a sum field into its cases", () => {
    const Cart = variants("状態", {
      商品あり: object({
        配送: variants("方法", {
          宅配: object({}),
          店頭受取: object({}),
        }),
      }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.配送", classes: ["宅配", "店頭受取"] },
    ]);
  });

  it("takes the fields of a sum field's case apart under that case", () => {
    const Cart = variants("状態", {
      商品あり: object({
        配送: variants("方法", {
          宅配: object({ 置き配: boolean() }),
        }),
      }),
    });

    expect(positionsOf(Cart).map(({ path }) => path)).toStrictEqual([
      "@商品あり.配送",
      "@商品あり.配送@宅配.置き配",
    ]);
  });

  it("takes the values of a record apart as one position", () => {
    const Cart = variants("状態", {
      商品あり: object({ ギフト指定: record(boolean()) }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.ギフト指定{}", classes: ["true", "false"] },
    ]);
  });

  it("reports a field no rule draws a line through as not derivable", () => {
    const Cart = variants("状態", {
      商品あり: object({
        カートID: string("カートID"),
        単価: number(),
        作成日時: instant(),
        メモ: record(string("メモ")),
      }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.カートID", kind: "not-derivable" },
      { path: "@商品あり.単価", kind: "not-derivable" },
      { path: "@商品あり.作成日時", kind: "not-derivable" },
      { path: "@商品あり.メモ{}", kind: "not-derivable" },
    ]);
  });

  it("takes a nested object apart field by field", () => {
    const Cart = variants("状態", {
      商品あり: object({ 配送先: object({ 置き配: boolean() }) }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.配送先.置き配", classes: ["true", "false"] },
    ]);
  });

  it("takes the elements of an array apart as one position per element field", () => {
    const Cart = variants("状態", {
      商品あり: object({
        明細: array(object({ 数量: number(), 軽減税率: boolean() })),
      }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.明細[].数量", kind: "not-derivable" },
      { path: "@商品あり.明細[].軽減税率", classes: ["true", "false"] },
    ]);
  });

  it("takes what an optional holds apart under あり", () => {
    const Cart = variants("状態", {
      商品あり: object({ クーポン: optional(object({ 自動適用: boolean() })) }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.クーポン", classes: ["なし", "あり"] },
      { path: "@商品あり.クーポン?.自動適用", classes: ["true", "false"] },
    ]);
  });
});

describe("DividedPosition.classify", () => {
  const Cart = variants("状態", {
    空: object({}),
    商品あり: object({
      クーポン: optional(string("クーポンコード")),
      明細: array(object({ 軽減税率: boolean() })),
    }),
  });
  const [クーポン, , 軽減税率] = positionsOf(Cart) as [
    DividedPosition,
    Position,
    DividedPosition,
  ];

  it("reads a missing optional field as なし", () => {
    expect(クーポン.classify({ 状態: "商品あり", 明細: [] })).toStrictEqual(["なし"]);
  });

  it("reads a present optional field as あり", () => {
    expect(
      クーポン.classify({ 状態: "商品あり", クーポン: "C-1", 明細: [] }),
    ).toStrictEqual(["あり"]);
  });

  it("reads nothing where the value is another case than the one the position stands under", () => {
    expect(クーポン.classify({ 状態: "空" })).toStrictEqual([]);
  });

  it("reads every element of an array", () => {
    expect(
      軽減税率.classify({
        状態: "商品あり",
        明細: [{ 軽減税率: true }, { 軽減税率: false }],
      }),
    ).toStrictEqual(["true", "false"]);
  });
});

describe("borders an invariant draws", () => {
  function bordersAt(schema: Parameters<typeof object>[0][string]) {
    const [position] = positionsOf(variants("状態", { 商品あり: object({ 数量: schema }) }));
    return position!.borders.map(border => ({
      rule: border.rule,
      points: border.points.map(({ role, relation, status }) => ({ role, relation, status })),
    }));
  }

  it("owes ON and IN at a closed lower bound of an integer and excludes OFF and OUT", () => {
    expect(bordersAt(int().invariant(v => v.gte(1)))).toStrictEqual([
      {
        rule: "invariant $ >= 1",
        points: [
          { role: "ON", relation: "= 1", status: "owed" },
          { role: "OFF", relation: "= 0", status: "excluded" },
          { role: "IN", relation: "> 1", status: "owed" },
          { role: "OUT", relation: "< 0", status: "excluded" },
        ],
      },
    ]);
  });

  it("puts ON one step inside an open bound and OFF on the value the rule names", () => {
    expect(bordersAt(int().invariant(v => v.gt(0)))[0]!.points).toStrictEqual([
      { role: "ON", relation: "= 1", status: "owed" },
      { role: "OFF", relation: "= 0", status: "excluded" },
      { role: "IN", relation: "> 1", status: "owed" },
      { role: "OUT", relation: "< 0", status: "excluded" },
    ]);
  });

  it("mirrors the points for an upper bound", () => {
    expect(bordersAt(int().invariant(v => v.lt(100)))[0]!.points).toStrictEqual([
      { role: "ON", relation: "= 99", status: "owed" },
      { role: "OFF", relation: "= 100", status: "excluded" },
      { role: "IN", relation: "< 99", status: "owed" },
      { role: "OUT", relation: "> 100", status: "excluded" },
    ]);
  });

  it("names no OFF point on a number, which has no neighbouring value", () => {
    expect(bordersAt(number().invariant(v => v.gte(0)))[0]!.points).toStrictEqual([
      { role: "ON", relation: "= 0", status: "owed" },
      { role: "OFF", relation: "neighbour not named", status: "not named" },
      { role: "IN", relation: "> 0", status: "owed" },
      { role: "OUT", relation: "< 0", status: "excluded" },
    ]);
  });

  it("draws no border for a strict bound on a number, whose cut is a value the type refuses", () => {
    expect(bordersAt(number().invariant(v => v.gt(0)))).toStrictEqual([]);
  });

  it("steps an instant by a nanosecond", () => {
    const 受付開始 = Temporal.Instant.from("2026-01-01T00:00:00Z");

    expect(bordersAt(instant().invariant(v => v.gt(受付開始)))[0]!.points[0]).toStrictEqual({
      role: "ON",
      relation: "= 2026-01-01T00:00:00.000000001Z",
      status: "owed",
    });
  });

  it("draws a border on the length of a string", () => {
    expect(bordersAt(string("商品ID").invariant(v => v.length().gte(3)))).toStrictEqual([
      {
        rule: "invariant length($) >= 3",
        points: [
          { role: "ON", relation: "= 3", status: "owed" },
          { role: "OFF", relation: "= 2", status: "excluded" },
          { role: "IN", relation: "> 3", status: "owed" },
          { role: "OUT", relation: "< 2", status: "excluded" },
        ],
      },
    ]);
  });

  it("has no IN point where the rules leave the side one value wide", () => {
    const 固定 = int()
      .invariant(v => v.gte(1))
      .invariant(v => v.lte(1));

    expect(bordersAt(固定).map(border => border.points[2])).toStrictEqual([
      { role: "IN", relation: "> 1", status: "excluded" },
      { role: "IN", relation: "< 1", status: "excluded" },
    ]);
  });
});

describe("a border with nothing past it", () => {
  it("excludes the IN point of an upper bound at the empty string, below which no string exists", () => {
    const [position] = positionsOf(
      variants("状態", { 入力済み: object({ 見出し: string("見出し").invariant(v => v.lte("")) }) }),
    );

    expect(position!.borders[0]!.points[2]).toMatchObject({ role: "IN", status: "excluded" });
  });
});

describe("invariants written on the input sum", () => {
  it("draw their border on the field they name, under every case that has it", () => {
    const 注文 = variants("状態", {
      入力済み: object({ 数量: int() }),
      確定済み: object({ 数量: int() }),
    }).invariant(v => v.$数量.gte(1));

    expect(
      positionsOf(注文).map(position => ({
        path: position.path,
        rules: position.borders.map(border => border.rule),
      })),
    ).toStrictEqual([
      { path: "@入力済み.数量", rules: ["invariant $ >= 1"] },
      { path: "@確定済み.数量", rules: ["invariant $ >= 1"] },
    ]);
  });

  it("are read on a sum field as well", () => {
    const 注文 = variants("状態", {
      入力済み: object({
        配送: variants("方法", {
          宅配: object({ 個数: int() }),
          店頭: object({ 個数: int() }),
        }).invariant(v => v.$個数.gte(1)),
      }),
    });

    expect(
      positionsOf(注文)
        .filter(position => position.borders.length > 0)
        .map(position => position.path),
    ).toStrictEqual(["@入力済み.配送@宅配.個数", "@入力済み.配送@店頭.個数"]);
  });
});

describe("bounds that leave nothing admitted", () => {
  it("excludes every point of two bounds that admit no value between them", () => {
    const [position] = positionsOf(
      variants("状態", {
        入力済み: object({
          数量: int()
            .invariant(v => v.gte(10))
            .invariant(v => v.lte(5)),
        }),
      }),
    );

    expect(
      position!.borders.flatMap(border => border.points.map(point => point.status)),
    ).toStrictEqual(Array.from({ length: 8 }, () => "excluded"));
  });

  it("excludes a point of one bound that another bound refuses", () => {
    const [position] = positionsOf(
      variants("状態", {
        入力済み: object({
          数量: int()
            .invariant(v => v.gte(1))
            .invariant(v => v.ne(1)),
        }),
      }),
    );

    expect(position!.borders[0]!.points[0]).toMatchObject({
      role: "ON",
      relation: "= 1",
      status: "excluded",
    });
  });
});

describe("a length border stops at zero", () => {
  function pointsAt(schema: Parameters<typeof object>[0][string]) {
    const [position] = positionsOf(variants("状態", { 入力済み: object({ 見出し: schema }) }));
    return position!.borders[0]!.points.map(({ role, relation, status }) => ({
      role,
      relation,
      status,
    }));
  }

  it("names no OFF or OUT point below a lower bound of zero, since no length is negative", () => {
    expect(pointsAt(string("見出し").invariant(v => v.length().gte(0)))).toStrictEqual([
      { role: "ON", relation: "= 0", status: "owed" },
      { role: "OFF", relation: "none: a length is never negative", status: "no point" },
      { role: "IN", relation: "> 0", status: "owed" },
      { role: "OUT", relation: "none: a length is never negative", status: "no point" },
    ]);
  });

  it("names no IN point below an upper bound of zero", () => {
    expect(pointsAt(string("見出し").invariant(v => v.length().lte(0)))).toStrictEqual([
      { role: "ON", relation: "= 0", status: "owed" },
      { role: "OFF", relation: "= 1", status: "excluded" },
      { role: "IN", relation: "none: a length is never negative", status: "no point" },
      { role: "OUT", relation: "> 1", status: "excluded" },
    ]);
  });

  it("names no neighbour or run below a length the rule keeps", () => {
    expect(pointsAt(string("見出し").invariant(v => v.length().eq(0)))).toStrictEqual([
      { role: "ON", relation: "= 0", status: "owed" },
      { role: "OFF", relation: "none: a length is never negative", status: "no point" },
      { role: "OFF", relation: "= 1", status: "excluded" },
      { role: "IN", relation: "none: the rule keeps a single value", status: "no point" },
      { role: "OUT", relation: "none: a length is never negative", status: "no point" },
      { role: "OUT", relation: "> 1", status: "excluded" },
    ]);
  });
});

describe("an invariant written as a conjunction", () => {
  it("draws a border for each part it requires", () => {
    const [position] = positionsOf(
      variants("状態", { 入力済み: object({ 点数: int().invariant(v => v.gte(0).and(v.lte(100))) }) }),
    );

    expect(position!.borders.map(border => border.rule)).toStrictEqual([
      "invariant $ >= 0",
      "invariant $ <= 100",
    ]);
  });
});

describe("where an object invariant draws its border", () => {
  it("places the border on the one field it compares with a constant", () => {
    const Cart = variants("状態", {
      商品あり: object({ 在庫数: int() }).invariant(v => v.$在庫数.gte(0)),
    });

    expect(positionsOf(Cart).map(p => ({ path: p.path, rules: p.borders.map(b => b.rule) }))).toStrictEqual([
      { path: "@商品あり.在庫数", rules: ["invariant $ >= 0"] },
    ]);
  });

  it("draws no border for a rule relating two fields", () => {
    const Cart = variants("状態", {
      商品あり: object({ 数量: int(), 在庫数: int() }).invariant(v =>
        v.$数量.lte(v.$在庫数),
      ),
    });

    expect(positionsOf(Cart).map(p => p.borders.length)).toStrictEqual([0, 0]);
  });
});

describe("classes an invariant refuses", () => {
  it("excludes the boolean class an equality rules out", () => {
    const [position] = positionsOf(
      variants("状態", { 商品あり: object({ 同意: boolean().invariant(v => v.eq(true)) }) }),
    ) as [DividedPosition];

    expect(position.excluded).toStrictEqual(["false"]);
  });

  it("excludes the case of a sum field its discriminant is ruled out of", () => {
    const [position] = positionsOf(
      variants("状態", {
        確定済み: object({
          配送: variants("方法", { 店頭受取: object({}), 宅配: object({}) }).invariant(v =>
            v.$方法.ne("店頭受取"),
          ),
        }),
      }),
    ) as [DividedPosition];

    expect(position.excluded).toStrictEqual(["店頭受取"]);
  });

  it("draws a border on the size of a record", () => {
    const Cart = variants("状態", {
      商品あり: object({ 数量表: record(int()).invariant(v => v.length().gte(1)) }),
    });

    expect(
      positionsOf(Cart).map(p => ({ path: p.path, rules: p.borders.map(b => b.rule) })),
    ).toStrictEqual([
      { path: "@商品あり.数量表", rules: ["invariant length($) >= 1"] },
      { path: "@商品あり.数量表{}", rules: [] },
    ]);
  });

  it("draws a border on the length of an array beside its element positions", () => {
    const Cart = variants("状態", {
      商品あり: object({ 明細: array(boolean()).invariant(v => v.length().gte(1)) }),
    });

    expect(
      positionsOf(Cart).map(p => ({ path: p.path, rules: p.borders.map(b => b.rule) })),
    ).toStrictEqual([
      { path: "@商品あり.明細", rules: ["invariant length($) >= 1"] },
      { path: "@商品あり.明細[]", rules: [] },
    ]);
  });
});

describe("Position.write", () => {
  it("keeps the order of the fields it does not move", () => {
    const [, 単価] = positionsOf(
      variants("状態", { 商品あり: object({ 数量: int(), 単価: int(), 在庫数: int() }) }),
    );

    expect(
      Object.keys(単価!.write({ 状態: "商品あり", 数量: 1, 単価: 2, 在庫数: 3 }, "value", 0) as object),
    ).toStrictEqual(["状態", "数量", "単価", "在庫数"]);
  });

  it("moves only the first element of an array", () => {
    const [単価] = positionsOf(
      variants("状態", { 商品あり: object({ 明細: array(object({ 単価: int() })) }) }),
    );

    expect(
      単価!.write({ 状態: "商品あり", 明細: [{ 単価: 500 }, { 単価: 1500 }] }, "value", 0),
    ).toStrictEqual({ 状態: "商品あり", 明細: [{ 単価: 0 }, { 単価: 1500 }] });
  });
});
