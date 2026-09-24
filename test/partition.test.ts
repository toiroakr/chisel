import { describe, expect, it } from "vitest";
import {
  array,
  boolean,
  eq,
  ge,
  gt,
  integer,
  le,
  length,
  lt,
  instant,
  ne,
  number,
  object,
  optional,
  positionsOf,
  record,
  string,
  sum,
} from "../src/index.js";
import type { DividedPosition, Position } from "../src/index.js";

function summary(position: Position) {
  return position.kind === "divided"
    ? { path: position.path, classes: position.classes }
    : { path: position.path, kind: position.kind };
}

describe("positionsOf", () => {
  it("divides an optional field into the classes なし and あり", () => {
    const Cart = sum("状態", {
      商品あり: object({ クーポン: optional(string("クーポンコード")) }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.クーポン", classes: ["なし", "あり"] },
      { path: "@商品あり.クーポン?", kind: "not-derivable" },
    ]);
  });

  it("divides a boolean field into the classes true and false", () => {
    const Cart = sum("状態", {
      商品あり: object({ ギフト包装: boolean() }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.ギフト包装", classes: ["true", "false"] },
    ]);
  });

  it("divides a sum field into its cases", () => {
    const Cart = sum("状態", {
      商品あり: object({
        配送: sum("方法", {
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
    const Cart = sum("状態", {
      商品あり: object({
        配送: sum("方法", {
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
    const Cart = sum("状態", {
      商品あり: object({ ギフト指定: record(boolean()) }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.ギフト指定{}", classes: ["true", "false"] },
    ]);
  });

  it("reports a field no rule draws a line through as not derivable", () => {
    const Cart = sum("状態", {
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
    const Cart = sum("状態", {
      商品あり: object({ 配送先: object({ 置き配: boolean() }) }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.配送先.置き配", classes: ["true", "false"] },
    ]);
  });

  it("takes the elements of an array apart as one position per element field", () => {
    const Cart = sum("状態", {
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
    const Cart = sum("状態", {
      商品あり: object({ クーポン: optional(object({ 自動適用: boolean() })) }),
    });

    expect(positionsOf(Cart).map(summary)).toStrictEqual([
      { path: "@商品あり.クーポン", classes: ["なし", "あり"] },
      { path: "@商品あり.クーポン?.自動適用", classes: ["true", "false"] },
    ]);
  });
});

describe("DividedPosition.classify", () => {
  const Cart = sum("状態", {
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
    const [position] = positionsOf(sum("状態", { 商品あり: object({ 数量: schema }) }));
    return position!.borders.map(border => ({
      rule: border.rule,
      points: border.points.map(({ role, relation, status }) => ({ role, relation, status })),
    }));
  }

  it("owes ON and IN at a closed lower bound of an integer and excludes OFF and OUT", () => {
    expect(bordersAt(integer().invariant(v => ge(v, 1)))).toStrictEqual([
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
    expect(bordersAt(integer().invariant(v => gt(v, 0)))[0]!.points).toStrictEqual([
      { role: "ON", relation: "= 1", status: "owed" },
      { role: "OFF", relation: "= 0", status: "excluded" },
      { role: "IN", relation: "> 1", status: "owed" },
      { role: "OUT", relation: "< 0", status: "excluded" },
    ]);
  });

  it("mirrors the points for an upper bound", () => {
    expect(bordersAt(integer().invariant(v => lt(v, 100)))[0]!.points).toStrictEqual([
      { role: "ON", relation: "= 99", status: "owed" },
      { role: "OFF", relation: "= 100", status: "excluded" },
      { role: "IN", relation: "< 99", status: "owed" },
      { role: "OUT", relation: "> 100", status: "excluded" },
    ]);
  });

  it("names no OFF point on a number, which has no neighbouring value", () => {
    expect(bordersAt(number().invariant(v => ge(v, 0)))[0]!.points).toStrictEqual([
      { role: "ON", relation: "= 0", status: "owed" },
      { role: "OFF", relation: "neighbour not named", status: "not named" },
      { role: "IN", relation: "> 0", status: "owed" },
      { role: "OUT", relation: "< 0", status: "excluded" },
    ]);
  });

  it("draws no border for a strict bound on a number, whose cut is a value the type refuses", () => {
    expect(bordersAt(number().invariant(v => gt(v, 0)))).toStrictEqual([]);
  });

  it("steps an instant by a nanosecond", () => {
    const 受付開始 = Temporal.Instant.from("2026-01-01T00:00:00Z");

    expect(bordersAt(instant().invariant(v => gt(v, 受付開始)))[0]!.points[0]).toStrictEqual({
      role: "ON",
      relation: "= 2026-01-01T00:00:00.000000001Z",
      status: "owed",
    });
  });

  it("draws a border on the length of a string", () => {
    expect(bordersAt(string("商品ID").invariant(v => ge(length(v), 3)))).toStrictEqual([
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
    const 固定 = integer()
      .invariant(v => ge(v, 1))
      .invariant(v => le(v, 1));

    expect(bordersAt(固定).map(border => border.points[2])).toStrictEqual([
      { role: "IN", relation: "> 1", status: "excluded" },
      { role: "IN", relation: "< 1", status: "excluded" },
    ]);
  });
});

describe("a border with nothing past it", () => {
  it("excludes the IN point of an upper bound at the empty string, below which no string exists", () => {
    const [position] = positionsOf(
      sum("状態", { 入力済み: object({ 見出し: string("見出し").invariant(v => le(v, "")) }) }),
    );

    expect(position!.borders[0]!.points[2]).toMatchObject({ role: "IN", status: "excluded" });
  });
});

describe("where an object invariant draws its border", () => {
  it("places the border on the one field it compares with a constant", () => {
    const Cart = sum("状態", {
      商品あり: object({ 在庫数: integer() }).invariant(v => ge(v.在庫数, 0)),
    });

    expect(positionsOf(Cart).map(p => ({ path: p.path, rules: p.borders.map(b => b.rule) }))).toStrictEqual([
      { path: "@商品あり.在庫数", rules: ["invariant $ >= 0"] },
    ]);
  });

  it("draws no border for a rule relating two fields", () => {
    const Cart = sum("状態", {
      商品あり: object({ 数量: integer(), 在庫数: integer() }).invariant(v =>
        le(v.数量, v.在庫数),
      ),
    });

    expect(positionsOf(Cart).map(p => p.borders.length)).toStrictEqual([0, 0]);
  });
});

describe("classes an invariant refuses", () => {
  it("excludes the boolean class an equality rules out", () => {
    const [position] = positionsOf(
      sum("状態", { 商品あり: object({ 同意: boolean().invariant(v => eq(v, true)) }) }),
    ) as [DividedPosition];

    expect(position.excluded).toStrictEqual(["false"]);
  });

  it("excludes the case of a sum field its discriminant is ruled out of", () => {
    const [position] = positionsOf(
      sum("状態", {
        確定済み: object({
          配送: sum("方法", { 店頭受取: object({}), 宅配: object({}) }).invariant(v =>
            ne(v.方法, "店頭受取"),
          ),
        }),
      }),
    ) as [DividedPosition];

    expect(position.excluded).toStrictEqual(["店頭受取"]);
  });

  it("draws a border on the size of a record", () => {
    const Cart = sum("状態", {
      商品あり: object({ 数量表: record(integer()).invariant(v => ge(length(v), 1)) }),
    });

    expect(
      positionsOf(Cart).map(p => ({ path: p.path, rules: p.borders.map(b => b.rule) })),
    ).toStrictEqual([
      { path: "@商品あり.数量表", rules: ["invariant length($) >= 1"] },
      { path: "@商品あり.数量表{}", rules: [] },
    ]);
  });

  it("draws a border on the length of an array beside its element positions", () => {
    const Cart = sum("状態", {
      商品あり: object({ 明細: array(boolean()).invariant(v => ge(length(v), 1)) }),
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
      sum("状態", { 商品あり: object({ 数量: integer(), 単価: integer(), 在庫数: integer() }) }),
    );

    expect(
      Object.keys(単価!.write({ 状態: "商品あり", 数量: 1, 単価: 2, 在庫数: 3 }, "value", 0) as object),
    ).toStrictEqual(["状態", "数量", "単価", "在庫数"]);
  });
});
