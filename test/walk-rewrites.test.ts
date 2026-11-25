import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { reportDocument } from "../src/index.js";
import { validate } from "./support/json-schema.js";
import schema from "../schema/report.schema.json" with { type: "json" };

const emptyEffects = c.variants("kind", {});
const 合計 = c.behavior("合計", {
  input: c.variants("kind", { order: c.object({ lines: c.array(c.int().min(0).max(100)).max(5) }) }),
  result: c.int(),
  effects: emptyEffects,
});
const 足す = c.implement(合計, {
  cases: {
    order: c.model("足す", input => ({
      result: c.fold(c.int().min(0).max(100), c.int(), input.lines, 0, (total, line) => c.arithmetic("add", total, line)),
      effects: [],
    })),
  },
});

const rowsOf = (lines: Record<string, readonly number[]>) =>
  c.examples(合計, Object.fromEntries(Object.entries(lines).map(([name, list]) => [name, {
    given: { kind: "order" as const, lines: [...list] },
    expect: { result: list.reduce((a, b) => a + b, 0), effects: [] },
  }])));

describe("a fold owes a row whose step reads what an earlier step answered", () => {
  it("says neither rewrite is told apart by rows of no element and one element", async () => {
    const report = await c.check(c.spec("合計", { examples: rowsOf({ 空: [], 一つ: [1] }), implementation: 足す }));

    expect(report.walks).toStrictEqual([
      { decision: "足す", walk: "fold over $.lines", rewrite: "after one step", status: "not told", reason: "二つ目の要素まで歩く答えのある行がない" },
      { decision: "足す", walk: "fold over $.lines", rewrite: "from the seed", status: "not told", reason: "二つ目の要素まで歩く答えのある行がない" },
    ]);
    expect(report.verdict).toBe("not_satisfied");
    expect(validate(schema as never, reportDocument([report], { id: "x", name: "x" }))).toStrictEqual([]);
  });

  it("is told apart by a row of two elements that both count", async () => {
    const report = await c.check(c.spec("合計", { examples: rowsOf({ 空: [], 一つ: [1], 二つ: [2, 3] }), implementation: 足す }));

    expect(report.walks.map(walk => [walk.rewrite, walk.status, walk.row])).toStrictEqual([
      ["after one step", "told", "二つ"],
      ["from the seed", "told", "二つ"],
    ]);
  });

  it("is not told apart by two elements whose second leaves the answer as it was", async () => {
    const report = await c.check(c.spec("合計", { examples: rowsOf({ 二つ: [2, 0] }), implementation: 足す }));

    expect(report.walks.map(walk => [walk.rewrite, walk.status])).toStrictEqual([
      ["after one step", "not told"],
      ["from the seed", "told"],
    ]);
  });

  it("leaves out a fold that reads nothing a run is handed", async () => {
    const 定数 = c.implement(合計, {
      cases: { order: c.model("定数", () => ({ result: c.fold(c.int(), c.int(), [1, 2], 0, (total, x) => c.arithmetic("add", total, x)), effects: [] })) },
    });
    const report = await c.check(c.spec("合計", { examples: c.examples(合計, {}), implementation: 定数 }));

    expect(report.walks).toStrictEqual([]);
  });

  it("offers a row of two elements that tells both rewrites apart", () => {
    const { rows } = c.generate(rowsOf({ 空: [], 一つ: [1] }), 足す);
    const walked = rows.filter(row => row.name.includes("fold over"));

    expect(walked.map(row => [row.name, row.given])).toStrictEqual([
      ["足す: fold over $.lines を二つ以上の要素で歩く", { kind: "order", lines: [1, 1] }],
    ]);
  });
});
