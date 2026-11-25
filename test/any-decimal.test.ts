import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const emptyEffects = c.variants("kind", {});

describe("a decimal of any scale (ADR-0128)", () => {
  it("parses any finite decimal, however many digits it has", () => {
    const schema = c.decimal();
    expect(schema.parse(new Decimal("1.234567890123456789012345")).success).toBe(true);
    expect(schema.parse(new Decimal("0E-2147483647")).success).toBe(true);
    expect(schema.parse(new Decimal(Infinity)).success).toBe(false);
    expect(c.decimal(2).parse(new Decimal("1.234")).success).toBe(false);
  });

  it("decodes one from its JSON string and writes it back", () => {
    const decoded = c.decode(c.decimal(), "3.14159265358979323846264338327950288");
    expect(decoded.success && decoded.value.toString()).toBe("3.14159265358979323846264338327950288");
  });

  it("draws an ON point on a bound but no OFF point, as no value is next to another", async () => {
    const 金額 = c.behavior("金額", {
      input: c.variants("kind", { request: c.object({ amount: c.decimal().min(new Decimal("0.5")) }) }),
      result: c.boolean(),
      effects: emptyEffects,
    });
    const report = await c.check(c.spec("金額", { examples: c.examples(金額, {}) }));

    expect(report.borders.map(border => [border.rule, border.points.map(point => `${point.role} ${point.status}`)])).toStrictEqual([
      ["invariant $ >= 0.5", ["ON gap", "OFF not named", "IN gap", "OUT excluded"]],
    ]);
  });

  it("goes into a decimal of any scale from one of a scale, not the other way", () => {
    const into = (answered: c.AnySchema, taken: c.AnySchema) => () => c.compose("合成", [
      c.implement(c.behavior("一", { input: c.variants("kind", { a: c.object({}) }), result: c.variants("kind", { b: c.object({ v: answered }) }), effects: emptyEffects }), { cases: { a: c.todo("") } }),
      c.implement(c.behavior("二", { input: c.variants("kind", { b: c.object({ v: taken }) }), result: c.variants("kind", { c: c.object({}) }), effects: emptyEffects }), { cases: { b: c.todo("") } }),
    ]);
    expect(into(c.decimal(2), c.decimal())).not.toThrow();
    expect(into(c.decimal(), c.decimal(2))).toThrow("answers @b.v as decimal(), which 二 takes as decimal(2)");
  });
});

describe("rounding and division at a scale", () => {
  const 割り勘 = c.behavior("割り勘", {
    input: c.variants("kind", { request: c.object({ total: c.decimal(2).min(new Decimal(0)).max(new Decimal(1000000)), people: c.int().min(1).max(10) }) }),
    result: c.decimal(2),
    effects: emptyEffects,
  });
  const 割る = c.implement(割り勘, {
    cases: { request: c.model("割る", input => ({ result: c.divide(input.total, input.people, 2, "half-even"), effects: [] })) },
  });

  it("rounds as the mode says, at any scale", async () => {
    const at = async (value: string, scale: number, mode: c.Rounding) => {
      const definition = c.behavior("丸め", { input: c.variants("kind", { r: c.object({ v: c.decimal() }) }), result: c.decimal(), effects: emptyEffects });
      const implementation = c.implement(definition, { cases: { r: c.model("丸める", input => ({ result: c.round(input.v, scale, mode), effects: [] })) } });
      return String(((await c.perform(implementation, { kind: "r", v: new Decimal(value) })).result));
    };
    expect(await at("2.5", 0, "half-even")).toBe("2");
    expect(await at("3.5", 0, "half-even")).toBe("4");
    expect(await at("2.5", 0, "half-up")).toBe("3");
    expect(await at("-2.5", 0, "half-up")).toBe("-3");
    expect(await at("2.5", 0, "half-down")).toBe("2");
    expect(await at("-1.21", 1, "floor")).toBe("-1.3");
    expect(await at("-1.21", 1, "ceiling")).toBe("-1.2");
    expect(await at("1.21", 1, "up")).toBe("1.3");
    expect(await at("-1.29", 1, "down")).toBe("-1.2");
    expect(await at("0.000000000000000000000000000001", 31, "half-even")).toBe("1e-30");
  });

  it("divides into a decimal of the scale, and proves the answer fits it", async () => {
    await expect(c.perform(割る, { kind: "request", total: new Decimal("10.00"), people: 3 })).resolves.toStrictEqual({ result: new Decimal("3.33"), effects: [] });
    expect(c.verify(割る).status).toBe("verified");
  });

  it("never stops where the divisor's range holds no nought", async () => {
    const report = await c.check(c.spec("割り勘", { examples: c.examples(割り勘, {}), implementation: 割る }));
    expect(report.stops.map(stop => [stop.at, stop.status])).toStrictEqual([
      ["round(quotient($.total, $.people), 2)", "never stops"],
      ["quotient($.total, $.people)", "never stops"],
    ]);
  });
});

describe("a run short of room", () => {
  const 桁 = c.behavior("桁", {
    input: c.variants("kind", { request: c.object({ v: c.decimal() }) }),
    result: c.decimal(),
    effects: emptyEffects,
  });
  const 足す = c.implement(桁, {
    cases: { request: c.model("足す", input => ({ result: c.arithmetic("add", input.v, new Decimal(1)), effects: [] })) },
  });

  it("fails as OutOfRoom, the platform failing", async () => {
    await expect(c.perform(足す, { kind: "request", v: new Decimal("1e-20000") })).rejects.toThrow(c.OutOfRoom);
  });

  it("is no failure of the model in check, and the row is said not to have come back", async () => {
    const report = await c.check(c.spec("桁", {
      examples: c.examples(桁, { 大きい: { given: { kind: "request", v: new Decimal("1e-20000") }, expect: { result: new Decimal(1), effects: [] } } }),
      implementation: 足す,
    }));
    expect({ failures: report.failures, incompleteness: report.incompleteness.map(item => item.kind), adequate: report.adequate }).toStrictEqual({
      failures: [],
      incompleteness: ["out of room"],
      adequate: false,
    });
  });
});
