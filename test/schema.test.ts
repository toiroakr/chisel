import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { array, number, object, optional, record, string } from "../src/index.js";
import type { Infer } from "../src/index.js";

describe("array", () => {
  it("accepts a list whose every item matches the element schema", () => {
    const Tags = array(string("Tag"));

    const result = Tags.parse(["a", "b"]);

    assert.deepEqual(result, { success: true, value: ["a", "b"] });
  });

  it("rejects a value that is not an array", () => {
    const Tags = array(string("Tag"));

    const result = Tags.parse("not-an-array");

    assert.equal(result.success, false);
  });

  it("reports the index of the first invalid item in the path", () => {
    const Tags = array(string("Tag"));

    const result = Tags.parse(["a", 1, "c"]);

    assert.equal(result.success, false);
    assert.deepEqual(
      result.success ? [] : result.issues.map(issue => issue.path),
      ["$[1]"],
    );
  });

  it("uses an empty array as its placeholder", () => {
    const Tags = array(string("Tag"));

    assert.deepEqual(Tags.placeholder(), []);
  });
});

describe("optional", () => {
  it("accepts a value matching the wrapped schema", () => {
    const Note = optional(string("Note"));

    const result = Note.parse("hello");

    assert.deepEqual(result, { success: true, value: "hello" });
  });

  it("accepts undefined even though the wrapped schema would reject it", () => {
    const Note = optional(string("Note"));

    const result = Note.parse(undefined);

    assert.deepEqual(result, { success: true, value: undefined });
  });

  it("still rejects a value of the wrong type", () => {
    const Note = optional(string("Note"));

    const result = Note.parse(42);

    assert.equal(result.success, false);
  });

  it("lets an object omit an optional field entirely", () => {
    const Order = object({
      id: string("OrderId"),
      note: optional(string("Note")),
    });

    const result = Order.parse({ id: "o-1" });

    assert.deepEqual(result, { success: true, value: { id: "o-1" } });
    assert.equal(result.success && "note" in result.value, false);
  });

  it("omits optional fields from the generated placeholder", () => {
    const Order = object({
      id: string("OrderId"),
      note: optional(string("Note")),
    });

    const placeholder = Order.placeholder();

    assert.deepEqual(placeholder, { id: "<OrderId>" });
  });

  it("types an optional field as an omittable key, not a required T | undefined", () => {
    const Order = object({
      id: string("OrderId"),
      note: optional(string("Note")),
    });

    // This would fail to compile (not just at runtime) if `note` were typed
    // as a required key of type `string | undefined` instead of `note?: string`.
    const withoutNote: Infer<typeof Order> = { id: "o-1" };
    const withNote: Infer<typeof Order> = { id: "o-1", note: "handle with care" };

    assert.deepEqual(withoutNote, { id: "o-1" });
    assert.deepEqual(withNote, { id: "o-1", note: "handle with care" });
  });
});

describe("record", () => {
  it("accepts a map whose every value matches the value schema", () => {
    const Prices = record(number());

    const result = Prices.parse({ apple: 1, banana: 2 });

    assert.deepEqual(result, { success: true, value: { apple: 1, banana: 2 } });
  });

  it("rejects a value that is not an object", () => {
    const Prices = record(number());

    const result = Prices.parse("not-a-record");

    assert.equal(result.success, false);
  });

  it("reports the offending key in the path", () => {
    const Prices = record(number());

    const result = Prices.parse({ apple: "not-a-number" });

    assert.equal(result.success, false);
    assert.deepEqual(
      result.success ? [] : result.issues.map(issue => issue.path),
      ["$.apple"],
    );
  });

  it("uses an empty object as its placeholder", () => {
    const Prices = record(number());

    assert.deepEqual(Prices.placeholder(), {});
  });
});
