import { describe, expect, it } from "vitest";
import { formatTypeScriptValue } from "../src/index.js";

describe("formatTypeScriptValue", () => {
  it("formats primitives as JSON literals", () => {
    expect(formatTypeScriptValue("hello")).toBe('"hello"');
    expect(formatTypeScriptValue(42)).toBe("42");
    expect(formatTypeScriptValue(true)).toBe("true");
    expect(formatTypeScriptValue(null)).toBe("null");
  });

  it("formats a Temporal.Instant as a Temporal.Instant.from(...) call", () => {
    const instant = Temporal.Instant.from("2024-01-01T00:00:00Z");

    expect(formatTypeScriptValue(instant)).toBe('Temporal.Instant.from("2024-01-01T00:00:00Z")');
  });

  it("formats an empty array as []", () => {
    expect(formatTypeScriptValue([])).toBe("[]");
  });

  it("formats an empty object as {}", () => {
    expect(formatTypeScriptValue({})).toBe("{}");
  });

  it("formats nested arrays and objects with two-space indentation and trailing commas", () => {
    const value = { a: [1, "x"], b: {} };

    expect(formatTypeScriptValue(value)).toBe("{\n  a: [\n    1,\n    \"x\",\n  ],\n  b: {},\n}");
  });

  it("writes a key bare where it is an identifier, including one in Japanese", () => {
    expect(formatTypeScriptValue({ 状態: "入力済み", $id: 1, _x: 2 })).toBe(
      '{\n  状態: "入力済み",\n  $id: 1,\n  _x: 2,\n}',
    );
  });

  it("quotes a key that is not an identifier", () => {
    expect(formatTypeScriptValue({ "order-id": 1, "1st": 2, "": 3 })).toBe(
      '{\n  "order-id": 1,\n  "1st": 2,\n  "": 3,\n}',
    );
  });

  it("throws a TypeError for a value with no TypeScript literal form", () => {
    expect(() => formatTypeScriptValue(undefined)).toThrow(TypeError);
    expect(() => formatTypeScriptValue(() => {})).toThrow(TypeError);
  });

  it("keeps an explicit undefined field rather than dropping it, unlike object().placeholder", () => {
    expect(() => formatTypeScriptValue({ a: undefined })).toThrow(TypeError);
  });
});
