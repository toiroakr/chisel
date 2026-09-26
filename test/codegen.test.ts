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

  it("formats a Temporal.PlainDate as a Temporal.PlainDate.from(...) call", () => {
    expect(formatTypeScriptValue(Temporal.PlainDate.from("2026-01-01"))).toBe(
      'Temporal.PlainDate.from("2026-01-01")',
    );
  });

  it("formats a Temporal.PlainTime as a Temporal.PlainTime.from(...) call", () => {
    expect(formatTypeScriptValue(Temporal.PlainTime.from("15:00"))).toBe('Temporal.PlainTime.from("15:00:00")');
  });

  it("formats a Temporal.PlainDateTime as a Temporal.PlainDateTime.from(...) call", () => {
    expect(formatTypeScriptValue(Temporal.PlainDateTime.from("2026-01-01T15:00"))).toBe(
      'Temporal.PlainDateTime.from("2026-01-01T15:00:00")',
    );
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
    expect(() => formatTypeScriptValue(() => {})).toThrow(TypeError);
  });

  it("writes undefined as undefined", () => {
    expect(formatTypeScriptValue(undefined)).toBe("undefined");
  });

  it("writes an absent array element as undefined, as a row for an optional element holds one", () => {
    expect(formatTypeScriptValue([undefined])).toBe("[\n  undefined,\n]");
  });

  it("keeps an explicit undefined field rather than dropping it, unlike object().placeholder", () => {
    expect(formatTypeScriptValue({ a: undefined })).toBe("{\n  a: undefined,\n}");
  });
});
