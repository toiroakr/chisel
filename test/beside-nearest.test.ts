import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const 査定 = c.behavior("査定", {
  input: c.variants("kind", { request: c.object({ a: c.int().min(0).max(100000) }) }),
  result: c.enum(["高", "低"]),
  effects: c.variants("種類", {}),
});
// The value compared is computed: 7a above a thousand, a itself below it, so
// only a = 1111 stands at 7777, which no value the domain is sampled at holds.
const 七倍 = c.implement(査定, {
  cases: {
    request: c.model("七倍", input => ({
      result: c.bind(c.int(), c.choose(input.a.$gt(1000), c.arithmetic("multiply", input.a, 7), input.a), v => c.choose(v.$gte(7777), "高" as const, "低" as const)),
      effects: [],
    })),
  },
});

describe("a border on a computed value sought beside the nearest runs", () => {
  it("offers a row at the point by stepping from the runs that came nearest", () => {
    const { rows, notComposed } = c.generate(c.examples(査定, {}), 七倍);
    const atOn = rows.find(row => row.name === "査定: @request.choose ON (= 7777)");

    expect(atOn?.given).toStrictEqual({ kind: "request", a: 1111 });
  });

  it("says what was tried where no row reaches the point", () => {
    const { notComposed } = c.generate(c.examples(査定, {}), 七倍);

    expect(notComposed.filter(item => item.startsWith("@request.choose OFF"))).toStrictEqual([
      expect.stringMatching(/^@request\.choose OFF \(= 7776\) — \d+件の実行と、近いものから\d+件の隣の行を試したが、点に届く行は見つからない（最も近い差は1）$/),
    ]);
  });
});
