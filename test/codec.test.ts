import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const payload = c.variants("type", {
  invoice: c.object({
    total: c.decimal(2).min(new Decimal(0)),
    issued: c.date(),
    at: c.instant(),
    time: c.time(),
    local: c.datetime(),
    items: c.array(c.object({ price: c.decimal(2) })),
    credits: c.record(c.decimal(2).optional()),
    note: c.string().optional(),
  }),
});

const json = {
  type: "invoice", total: "9007199254740993.25", issued: "2026-10-03",
  at: "2026-10-03T00:00:00.000000001Z", time: "12:30:00.000000001", local: "2026-10-03T12:30:00",
  items: [{ price: "0.1" }], credits: { initial: "0.2" },
};

describe("schema-directed JSON codecs", () => {
  it("round-trips decimals and temporal values without losing precision", () => {
    const decoded = c.decode(payload, JSON.parse(JSON.stringify(json)));
    expect(decoded.success).toBe(true);
    if (!decoded.success) throw new Error("decode failed");
    expect(decoded.value.total).toBeInstanceOf(Decimal);
    expect(decoded.value.total.toString()).toBe("9007199254740993.25");
    expect(decoded.value.at.epochNanoseconds).toBe(1790985600000000001n);
    expect(c.encode(payload, decoded.value)).toStrictEqual({ success: true, value: json });
    expect(payload.parse(json).success).toBe(false);
  });

  it("holds decoded values to invariants and keeps issue names and paths", () => {
    expect(c.decode(c.object({ amount: c.decimal(2).min("nonnegative", new Decimal(0)) }), { amount: "-1" })).toMatchObject({
      success: false, issues: [{ path: "$.amount", invariant: "nonnegative" }],
    });
    expect(c.decode(payload, { ...json, total: "0.001" })).toMatchObject({ success: false, issues: [{ path: "$.total" }] });
  });

  it("refuses unknown keys rather than discarding them during conversion", () => {
    expect(c.decode(payload, { ...json, extra: true })).toMatchObject({ success: false, issues: [{ path: "$.extra", message: "Unexpected key" }] });
  });

  it("collects conversion errors at nested paths", () => {
    expect(c.decode(payload, { ...json, total: 0.1, issued: "impossible", items: [{ price: "bad" }] })).toStrictEqual({
      success: false,
      issues: [
        { path: "$.total", message: "Expected a string encoding decimal" },
        { path: "$.issued", message: "Invalid date string" },
        { path: "$.items[0].price", message: "Invalid decimal string" },
      ],
    });
  });

  it("keeps null distinct from an absent optional field", () => {
    const schema = c.object({ value: c.literal(null).optional() });
    expect(c.decode(schema, { value: null })).toStrictEqual({ success: true, value: { value: null } });
    expect(c.decode(schema, {})).toStrictEqual({ success: true, value: {} });
    expect(c.encode(schema, {})).toStrictEqual({ success: true, value: {} });
  });

  it("refuses values JSON would silently replace or omit", () => {
    expect(c.encode(c.array(c.string().optional()), [undefined])).toMatchObject({ success: false, issues: [{ path: "$[0]" }] });
    expect(c.encode(c.record(c.string().optional()), { a: undefined })).toMatchObject({ success: false, issues: [{ path: "$.a" }] });
    expect(c.encode(c.literal(Infinity), Infinity)).toMatchObject({ success: false });
  });

  it("validates before encoding", () => {
    expect(c.encode(c.int().min(1), 0)).toMatchObject({ success: false });
    expect(c.decode(c.variants("type", { ok: c.object({}) }), { type: "unknown" })).toMatchObject({ success: false });
  });

  it("converts a nested sum and a sum that declares its own discriminant", () => {
    const schema = c.object({ payment: c.variants("kind", { card: c.object({ kind: c.literal("card"), amount: c.decimal(2) }) }) });
    const decoded = c.decode(schema, { payment: { kind: "card", amount: "1.25" } });
    expect(decoded).toStrictEqual({ success: true, value: { payment: { kind: "card", amount: new Decimal("1.25") } } });
    if (!decoded.success) throw new Error("decode failed");
    expect(c.encode(schema, decoded.value)).toStrictEqual({ success: true, value: { payment: { kind: "card", amount: "1.25" } } });
  });
});
