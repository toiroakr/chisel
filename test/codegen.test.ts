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

  it("formats nested arrays and objects with two-space indentation per level", () => {
    const value = { a: [1, "x"], b: {} };

    expect(formatTypeScriptValue(value)).toBe('{\n  "a": [\n    1,\n    "x"\n  ],\n  "b": {}\n}');
  });

  it("throws a TypeError for a value with no TypeScript literal form", () => {
    expect(() => formatTypeScriptValue(undefined)).toThrow(TypeError);
    expect(() => formatTypeScriptValue(() => {})).toThrow(TypeError);
  });

  it("keeps an explicit undefined field rather than dropping it, unlike object().placeholder", () => {
    expect(() => formatTypeScriptValue({ a: undefined })).toThrow(TypeError);
  });
});
