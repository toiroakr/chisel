import { describe, expect, it } from "vitest";
import { action, behavior, check, dependency, examples, generate, implement, int, object, spec, variants } from "../src/index.js";

// Souther's fixture for E1938: three guards, each of whose borders every row
// stands at the points of, and none of which a row tells from a line beside it.
const 判定する = behavior("判定する", {
  input: variants("状態", { 入力済み: object({ x: int(), y: int() }) }),
  result: variants("結果", { 真: object({}), 偽: object({}) }),
  effects: variants("種類", {}),
});
const 偽 = () => ({ result: { 結果: "偽" as const }, effects: [] });
const 三つの線 = implement(判定する, {
  cases: {
    入力済み: action("三つの線", {
      guards: 入力 => [
        入力.y.$lte(入力.x.$plus(入力.x)).$else(偽),
        入力.y.$gte(入力.x).$else(偽),
        入力.x.$plus(入力.y).$plus(入力.y).$lt(60).$else(偽),
      ],
      run: () => ({ result: { 結果: "真" }, effects: [] }),
    }),
  },
});
const row = (x: number, y: number, answer: "真" | "偽") => ({
  given: { 状態: "入力済み" as const, x, y },
  expect: { result: { 結果: answer }, effects: [] },
});
const southersRows = {
  "(0, 29)": row(0, 29, "偽"),
  "(15, 29)": row(15, 29, "偽"),
  "(15, 30)": row(15, 30, "偽"),
  "(16, 31)": row(16, 31, "偽"),
  "(0, 0)": row(0, 0, "真"),
  "(0, 1)": row(0, 1, "偽"),
  "(0, -1)": row(0, -1, "偽"),
  "(0, -2)": row(0, -2, "偽"),
  "(13, 23)": row(13, 23, "真"),
  "(12, 24)": row(12, 24, "偽"),
};

describe("telling a border from the lines beside it", () => {
  it("names a line beside each border that every row reaching it falls on the same side of, as Souther does", async () => {
    const report = await check(
      spec("三つの線", { examples: examples(判定する, southersRows), implementation: 三つの線 }),
    );

    expect(report.borders.map(border => [border.rule, border.beside?.status, border.beside?.status === "not told" ? border.beside.another : undefined])).toStrictEqual([
      ["guard $.y <= 2 * $.x", "not told", "-3 * @入力済み.x + @入力済み.y = 0"],
      ["guard $.y >= $.x", "not told", "@入力済み.y = 0"],
      ["guard $.x + 2 * $.y < 60", "not told", "@入力済み.y = 23"],
    ]);
  });

  it("tells a border from a line beside it by a row the two lines put on different sides", async () => {
    const report = await check(
      spec("三つの線", {
        examples: examples(判定する, {
          ...southersRows,
          "(1, 3)": row(1, 3, "偽"),
          "(1, 0)": row(1, 0, "偽"),
          "(20, 20)": row(20, 20, "偽"),
        }),
        implementation: 三つの線,
      }),
    );

    expect(
      report.borders.map(border => [
        border.rule,
        border.beside?.status,
        border.beside?.status === "not told" ? border.beside.another : undefined,
      ]),
    ).toStrictEqual([
      ["guard $.y <= 2 * $.x", "told", undefined],
      ["guard $.y >= $.x", "not told", "-@入力済み.x + 2 * @入力済み.y = 0"],
      ["guard $.x + 2 * $.y < 60", "told", undefined],
    ]);
  });

  it("does not ask for a line beside a border until a row stands at every point it owes", async () => {
    const { "(0, 1)": _, ...withoutAnOffPoint } = southersRows;
    const report = await check(
      spec("三つの線", { examples: examples(判定する, withoutAnOffPoint), implementation: 三つの線 }),
    );

    expect(report.borders.find(border => border.rule === "guard $.y <= 2 * $.x")?.beside).toBeUndefined();
  });

  it("leaves the specification inadequate while a line beside a border is not told from it", async () => {
    const report = await check(
      spec("三つの線", { examples: examples(判定する, southersRows), implementation: 三つの線 }),
    );

    expect({ adequate: report.adequate, verdict: report.verdict }).toStrictEqual({
      adequate: false,
      verdict: "not_satisfied",
    });
  });

  it("suggests an input the two lines answer differently at, one step along the border from a row, as Souther's hint does", async () => {
    const report = await check(
      spec("三つの線", { examples: examples(判定する, southersRows), implementation: 三つの線 }),
    );

    expect(
      report.borders.map(border => (border.beside?.status === "not told" ? border.beside.input : undefined)),
    ).toStrictEqual([
      "@入力済み.x = 1, @入力済み.y = 3",
      "@入力済み.x = 1, @入力済み.y = 0",
      "@入力済み.x = 14, @入力済み.y = 23",
    ]);
  });

  it("offers a row at the input that tells each border from the line beside it", () => {
    const { rows } = generate(examples(判定する, southersRows), 三つの線);

    expect(rows.filter(offered => offered.name.includes("隣の線")).map(offered => offered.given)).toStrictEqual([
      { 状態: "入力済み", x: 1, y: 3 },
      { 状態: "入力済み", x: 1, y: 0 },
      { 状態: "入力済み", x: 14, y: 23 },
    ]);
  });

  it("writes the stand-ins of the row it stepped from on the row it offers, so the row still reaches the border", () => {
    const 上限つき = behavior("上限つき", {
      input: variants("状態", { 入力済み: object({ x: int(), y: int() }) }),
      result: variants("結果", { 真: object({}), 偽: object({}) }),
      effects: variants("種類", {}),
      requires: { 上限: dependency(int()) },
    });
    const 上限までの線 = implement(上限つき, {
      cases: {
        入力済み: action("上限までの線", {
          guards: (入力, deps) => [
            入力.x.$lte(deps.上限).$else(偽),
            入力.y.$lte(入力.x.$plus(入力.x)).$else(偽),
          ],
          run: () => ({ result: { 結果: "真" }, effects: [] }),
        }),
      },
    });
    const at = (x: number, y: number, answer: "真" | "偽") => ({ ...row(x, y, answer), with: { 上限: 100 } });
    const { rows } = generate(
      examples(上限つき, {
        "(10, 20)": at(10, 20, "真"),
        "(10, 21)": at(10, 21, "偽"),
        "(10, 19)": at(10, 19, "真"),
        "(10, 23)": at(10, 23, "偽"),
      }),
      上限までの線,
    );

    expect(rows.filter(offered => offered.name.includes("隣の線")).map(offered => offered.with)).toStrictEqual([
      { 上限: 100 },
    ]);
  });
});
