import { expect, it } from "vitest";
import { string } from "../src/schema.js";
import { holds, selfTerm, sizeOf, resize } from "../src/rule.js";

it("normalizes text before checking code point length", () => {
  expect(string().length(1).parse("e\u0301")).toStrictEqual({ success: true, value: "é" });
  expect(string().length(1).parse("😀").success).toBe(true);
  expect(string().parse("\ud800").success).toBe(false);
});
it("uses normalized code points for measurement and resizing", () => {
  expect(sizeOf("😀é")).toBe(2);
  expect(resize("😀é", 1)).toBe("😀");
  expect(resize("😀", 2)).toBe("😀_");
});
it("compares text by normalized Unicode scalar values", () => {
  const text = selfTerm<string>();
  expect(holds(text.$eq("e\u0301"), "é")).toBe(true);
  expect(holds(text.$gt("\uffff"), "😀")).toBe(true);
});

it("compares canonically equivalent example answers", async () => {
  const c = await import("../src/index.js");
  const definition = c.behavior("text", { input: c.variants("kind", { input: c.object({}) }), result: c.string(), effects: c.variants("kind", {}) });
  const rows = c.examples(definition, { text: { given: { kind: "input" }, expect: { result: "e\u0301", effects: [] } } });
  expect((await c.test(rows, () => ({ result: "é", effects: [] }))).failures).toStrictEqual([]);
});
