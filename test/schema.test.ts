import { describe, expect, it } from "vitest";
import {
  array,
  boolean,
  instant,
  int,
  isVariantsSchema,
  literal,
  number,
  object,
  record,
  string,
  variants,
  tagOf,
} from "../src/index.js";
import type { Infer, Tags, VariantOf } from "../src/index.js";

describe("array", () => {
  it("accepts a list whose every item matches the element schema", () => {
    const Tags = array(string());

    const result = Tags.parse(["a", "b"]);

    expect(result).toStrictEqual({ success: true, value: ["a", "b"] });
  });

  it("rejects a value that is not an array", () => {
    const Tags = array(string());

    const result = Tags.parse("not-an-array");

    expect(result.success).toBe(false);
  });

  it("reports the index of the first invalid item in the path", () => {
    const Tags = array(string());

    const result = Tags.parse(["a", 1, "c"]);

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues.map(issue => issue.path)).toStrictEqual(["$[1]"]);
  });

  it("shows the shape of its element by holding one placeholder element", () => {
    const Tags = array(string());

    expect(Tags.placeholder()).toStrictEqual(["<string>"]);
  });
});

describe("optional", () => {
  it("accepts a value matching the wrapped schema", () => {
    const Note = string().optional();

    const result = Note.parse("hello");

    expect(result).toStrictEqual({ success: true, value: "hello" });
  });

  it("accepts undefined even though the wrapped schema would reject it", () => {
    const Note = string().optional();

    const result = Note.parse(undefined);

    expect(result).toStrictEqual({ success: true, value: undefined });
  });

  it("still rejects a value of the wrong type", () => {
    const Note = string().optional();

    const result = Note.parse(42);

    expect(result.success).toBe(false);
  });

  it("lets an object omit an optional field entirely", () => {
    const Order = object({
      id: string(),
      note: string().optional(),
    });

    const result = Order.parse({ id: "o-1" });

    expect(result).toStrictEqual({ success: true, value: { id: "o-1" } });
    expect(result.success && "note" in result.value).toBe(false);
  });

  it("omits optional fields from the generated placeholder", () => {
    const Order = object({
      id: string(),
      note: string().optional(),
    });

    const placeholder = Order.placeholder();

    expect(placeholder).toStrictEqual({ id: "<id>" });
  });

  it("types an optional field as an omittable key, not a required T | undefined", () => {
    const Order = object({
      id: string(),
      note: string().optional(),
    });

    // This would fail to compile (not just at runtime) if `note` were typed
    // as a required key of type `string | undefined` instead of `note?: string`.
    const withoutNote: Infer<typeof Order> = { id: "o-1" };
    const withNote: Infer<typeof Order> = { id: "o-1", note: "handle with care" };

    expect(withoutNote).toStrictEqual({ id: "o-1" });
    expect(withNote).toStrictEqual({ id: "o-1", note: "handle with care" });
  });
});

describe("record", () => {
  it("accepts a map whose every value matches the value schema", () => {
    const Prices = record(number());

    const result = Prices.parse({ apple: 1, banana: 2 });

    expect(result).toStrictEqual({ success: true, value: { apple: 1, banana: 2 } });
  });

  it("rejects a value that is not an object", () => {
    const Prices = record(number());

    const result = Prices.parse("not-a-record");

    expect(result.success).toBe(false);
  });

  it("reports the offending key in the path", () => {
    const Prices = record(number());

    const result = Prices.parse({ apple: "not-a-number" });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues.map(issue => issue.path)).toStrictEqual(["$.apple"]);
  });

  it("uses an empty object as its placeholder", () => {
    const Prices = record(number());

    expect(Prices.placeholder()).toStrictEqual({});
  });
});

describe("string", () => {
  it("rejects a non-string value", () => {
    const Id = string();

    const result = Id.parse(42);

    expect(result.success).toBe(false);
  });

  it("reports a value that is not a string with the path that names the field", () => {
    const Order = object({ orderId: string() });

    expect(Order.parse({ orderId: 42 })).toStrictEqual({
      success: false,
      issues: [{ path: "$.orderId", message: "Expected a string" }],
    });
  });

  it("names its placeholder after the object field it fills", () => {
    expect(object({ orderId: string() }).placeholder()).toStrictEqual({ orderId: "<orderId>" });
  });

  it("names an element's placeholder after the field holding the array", () => {
    expect(object({ tags: array(string()) }).placeholder()).toStrictEqual({ tags: ["<tags>"] });
  });

  it("names its placeholder after its type where no field holds it", () => {
    expect(string().placeholder()).toBe("<string>");
  });
});

describe("number", () => {
  it("rejects a non-number value", () => {
    const result = number().parse("42");

    expect(result.success).toBe(false);
  });

  it("rejects NaN and Infinity, which are not finite", () => {
    expect(number().parse(Number.NaN).success).toBe(false);
    expect(number().parse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it("uses 0 as its placeholder", () => {
    expect(number().placeholder()).toBe(0);
  });
});

describe("integer", () => {
  it("accepts a whole number", () => {
    expect(int().parse(3)).toStrictEqual({ success: true, value: 3 });
  });

  it("rejects a number with a fractional part", () => {
    expect(int().parse(1.5).success).toBe(false);
  });

  it("rejects a value that is not a number", () => {
    expect(int().parse("3").success).toBe(false);
  });

  it("uses 0 as its placeholder", () => {
    expect(int().placeholder()).toBe(0);
  });
});

describe("boolean", () => {
  it("accepts true and false", () => {
    expect(boolean().parse(true)).toStrictEqual({ success: true, value: true });
    expect(boolean().parse(false)).toStrictEqual({ success: true, value: false });
  });

  it("rejects a non-boolean value", () => {
    const result = boolean().parse("true");

    expect(result.success).toBe(false);
  });

  it("uses false as its placeholder", () => {
    expect(boolean().placeholder()).toBe(false);
  });
});

describe("instant", () => {
  it("accepts a Temporal.Instant", () => {
    const value = Temporal.Instant.from("2024-01-01T00:00:00Z");

    expect(instant().parse(value)).toStrictEqual({ success: true, value });
  });

  it("rejects a value that is not a Temporal.Instant", () => {
    const result = instant().parse("2024-01-01T00:00:00Z");

    expect(result.success).toBe(false);
  });

  it("uses a fixed Temporal.Instant as its placeholder", () => {
    const placeholder = instant().placeholder() as Temporal.Instant;

    expect(placeholder.toString()).toBe("2000-01-01T00:00:00Z");
  });
});

describe("literal", () => {
  it("accepts only the exact expected value", () => {
    const Status = literal("active");

    expect(Status.parse("active")).toStrictEqual({ success: true, value: "active" });
    expect(Status.parse("inactive").success).toBe(false);
  });

  it("supports null as a literal value", () => {
    const Nothing = literal(null);

    expect(Nothing.parse(null)).toStrictEqual({ success: true, value: null });
    expect(Nothing.parse(undefined).success).toBe(false);
  });

  it("uses the literal value as its placeholder", () => {
    expect(literal("active").placeholder()).toBe("active");
  });
});

describe("object", () => {
  it("rejects a non-object value", () => {
    const Order = object({ id: string() });

    expect(Order.parse("not-an-object").success).toBe(false);
    expect(Order.parse(null).success).toBe(false);
    expect(Order.parse(["not", "an", "object"]).success).toBe(false);
  });

  it("collects issues from every invalid field, not just the first", () => {
    const Order = object({ id: string(), quantity: number() });

    const result = Order.parse({ id: 42, quantity: "two" });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues.map(issue => issue.path)).toStrictEqual(["$.id", "$.quantity"]);
  });

  it("rejects a key its shape does not declare, naming the key in the path", () => {
    const Order = object({ id: string() });

    const result = Order.parse({ id: "a", secret: "leak" });

    expect(result).toStrictEqual({
      success: false,
      issues: [{ path: "$.secret", message: "Unexpected key" }],
    });
  });

  it("rejects an undeclared key even when its value is undefined", () => {
    const Order = object({ id: string() });

    const result = Order.parse({ id: "a", secret: undefined });

    expect(result).toStrictEqual({
      success: false,
      issues: [{ path: "$.secret", message: "Unexpected key" }],
    });
  });

  it("rejects an undeclared key inside a nested object, naming its full path", () => {
    const Order = object({ line: object({ sku: string() }) });

    const result = Order.parse({ line: { sku: "a", secret: "leak" } });

    expect(result).toStrictEqual({
      success: false,
      issues: [{ path: "$.line.secret", message: "Unexpected key" }],
    });
  });

  it("drops a declared optional field whose value is undefined instead of rejecting it", () => {
    const Order = object({ id: string(), note: string().optional() });

    const result = Order.parse({ id: "o-1", note: undefined });

    expect(result).toStrictEqual({ success: true, value: { id: "o-1" } });
  });
});

describe("variants", () => {
  const Shape = variants("state", {
    draft: object({ id: string() }),
    published: object({ id: string(), publishedAt: instant() }),
  });

  it("rejects a non-object value", () => {
    expect(Shape.parse("not-an-object").success).toBe(false);
    expect(Shape.parse(null).success).toBe(false);
  });

  it("rejects a value whose discriminant is not a known variant tag", () => {
    const result = Shape.parse({ state: "archived", id: "a" });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.issues.map(issue => issue.path)).toStrictEqual(["$.state"]);
  });

  it("rejects a discriminant named like an Object.prototype member instead of throwing", () => {
    const result = Shape.parse({ state: "toString", id: "a" });

    expect(result.success ? [] : result.issues.map(issue => issue.path)).toStrictEqual(["$.state"]);
  });

  it("rejects a value missing the discriminant field entirely", () => {
    expect(Shape.parse({ id: "a" }).success).toBe(false);
  });

  it("merges the discriminant tag back into the parsed value", () => {
    const result = Shape.parse({ state: "draft", id: "a" });

    expect(result).toStrictEqual({ success: true, value: { state: "draft", id: "a" } });
  });

  it("accepts a variant whose object declares the discriminant itself", () => {
    const Declared = variants("state", { draft: object({ state: literal("draft"), id: string() }) });

    const result = Declared.parse({ state: "draft", id: "a" });

    expect(result).toStrictEqual({ success: true, value: { state: "draft", id: "a" } });
  });

  it("rejects a key the matched variant does not declare", () => {
    const result = Shape.parse({ state: "draft", id: "a", publishedAt: "never" });

    expect(result).toStrictEqual({
      success: false,
      issues: [{ path: "$.publishedAt", message: "Unexpected key" }],
    });
  });

  it("propagates issues from the matched variant's own fields", () => {
    const result = Shape.parse({ state: "draft", id: 42 });

    expect(result.success).toBe(false);
  });

  it("builds a placeholder for a given variant tag", () => {
    expect(Shape.placeholderFor("draft")).toStrictEqual({ state: "draft", id: "<id>" });
  });

  it("defaults its own placeholder to the first declared variant", () => {
    expect(Shape.placeholder()).toStrictEqual(Shape.placeholderFor("draft"));
  });

  it("exposes every variant tag", () => {
    expect(Shape.variantTags).toStrictEqual(["draft", "published"]);
  });
});

describe("isVariantsSchema", () => {
  it("is true for a schema built with variants()", () => {
    const Shape = variants("state", { draft: object({ id: string() }) });

    expect(isVariantsSchema(Shape)).toBe(true);
  });

  it("is false for a non-sum schema", () => {
    expect(isVariantsSchema(string())).toBe(false);
    expect(isVariantsSchema(object({ id: string() }))).toBe(false);
  });
});

describe("tagOf", () => {
  const Shape = variants("state", {
    draft: object({ id: string() }),
    published: object({ id: string() }),
  });

  it("returns the discriminant tag for a value belonging to a known variant", () => {
    expect(tagOf(Shape, { state: "draft", id: "a" })).toBe("draft");
  });

  it("returns undefined for a value whose discriminant is unknown", () => {
    expect(tagOf(Shape, { state: "archived", id: "a" })).toBe(undefined);
  });

  it("returns undefined for a non-object value", () => {
    expect(tagOf(Shape, "not-an-object")).toBe(undefined);
    expect(tagOf(Shape, null)).toBe(undefined);
    expect(tagOf(Shape, ["not", "an", "object"])).toBe(undefined);
  });
});

describe("Tags and VariantOf", () => {
  const Shape = variants("state", {
    draft: object({ id: string() }),
    published: object({ id: string(), url: string() }),
  });

  it("names the tags of a sum", () => {
    const tag: Tags<typeof Shape> = "draft";
    // @ts-expect-error "archived" is not a tag of Shape
    const unknown: Tags<typeof Shape> = "archived";

    expect([tag, unknown]).toStrictEqual(["draft", "archived"]);
  });

  it("types a variant with its own fields", () => {
    const variant: VariantOf<typeof Shape, "published"> = {
      state: "published",
      id: "p-1",
      url: "https://example.com",
    };

    expect(variant.url).toBe("https://example.com");
  });
});
