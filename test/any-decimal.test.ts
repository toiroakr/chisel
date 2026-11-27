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
    const encoded = decoded.success ? c.encode(c.decimal(), decoded.value) : undefined;
    expect(encoded?.success && encoded.value).toBe("3.14159265358979323846264338327950288");
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

  it("is no failure of the model for a row whose answer is still owed either", async () => {
    const report = await c.check(c.spec("桁", {
      examples: c.examples(桁, { 大きい: { given: { kind: "request", v: new Decimal("1e-20000") }, expect: c.todo("まだ決めていない") } }),
      implementation: 足す,
    }));
    expect({ failures: report.failures, incompleteness: report.incompleteness.map(item => item.kind) }).toStrictEqual({ failures: [], incompleteness: ["out of room"] });
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

describe("two decimals ordered against each other where one has no scale", () => {
  const 比べる = c.behavior("比べる", {
    input: c.variants("kind", { request: c.object({ price: c.decimal(), limit: c.decimal(2) }) }),
    result: c.variants("結果", { 内: c.object({}), 外: c.object({}) }),
    effects: emptyEffects,
  });
  const 上限まで = c.implement(比べる, {
    cases: {
      request: c.action("上限まで", {
        guards: v => [v.price.$lte(v.limit).$else(() => ({ result: { 結果: "外" as const }, effects: [] }))],
        run: () => ({ result: { 結果: "内" as const }, effects: [] }),
      }),
    },
  });
  const row = (price: string, limit: string, answer: "内" | "外") => ({
    given: { kind: "request" as const, price: new Decimal(price), limit: new Decimal(limit) },
    expect: { result: { 結果: answer }, effects: [] },
  });

  it("reads the comparison on their exact difference, with no OFF point", async () => {
    const report = await c.check(c.spec("比べる", { examples: c.examples(比べる, { 等しい: row("1.05", "1.05", "内") }), implementation: 上限まで }));

    expect(report.measures.comparisons).toStrictEqual({ status: "complete" });
    expect(report.borders.map(border => [border.path, border.points.map(point => `${point.role} ${point.relation} ${point.status}`)])).toStrictEqual([
      ["@request.price − @request.limit", ["ON = 0 met", "OFF neighbour not named not named", "IN < 0 gap", "OUT > 0 gap"]],
    ]);
  });

  it("composes a row at each point by writing one side as the other plus the difference", () => {
    const { rows } = c.generate(c.examples(比べる, { 等しい: row("1.05", "1.05", "内") }), 上限まで);

    expect(rows.filter(item => item.name.includes("−")).map(item => [item.name, String((item.given as { price: Decimal }).price), String((item.given as { limit: Decimal }).limit)])).toStrictEqual([
      ["比べる: @request.price − @request.limit IN (< 0)", "0.05", "1.05"],
      ["比べる: @request.price − @request.limit OUT (> 0)", "2.05", "1.05"],
    ]);
  });
});

describe("the placeholder of a decimal of any scale", () => {
  it("stands inside every bound, however close they are", () => {
    for (const schema of [c.decimal().gt(new Decimal(0)).lt(new Decimal("0.1")), c.decimal().lt(new Decimal("0.1")).gt(new Decimal(0)), c.decimal().gt(new Decimal("0.5")).lt(new Decimal("0.5001"))]) {
      expect(schema.parse(schema.placeholder()).success).toBe(true);
    }
  });

  it("stays short of a finer bound the field writes on itself under a rule of the enclosing object", () => {
    const schema = c.object({ x: c.decimal().lt(new Decimal("0.1001")) }).refine(v => v.x.$gt(new Decimal("0.1")));
    expect(schema.parse(schema.placeholder()).success).toBe(true);
  });
});

describe("a decimal past the room exact arithmetic has", () => {
  const 比べる = c.behavior("比べる", {
    input: c.variants("kind", { request: c.object({ a: c.decimal(), b: c.decimal() }) }),
    result: c.boolean(),
    effects: emptyEffects,
  });
  const 大きいか = c.implement(比べる, {
    cases: { request: c.action("大きいか", { guards: v => [v.a.$gt(v.b).$else(() => ({ result: false, effects: [] }))], run: () => ({ result: true, effects: [] }) }) },
  });
  const huge = new Decimal("1e10001");

  it("is no coordinate of a guard comparing two decimals when a row holds it, so check still reports", async () => {
    const examples = c.examples(比べる, { 大きい: { given: { kind: "request", a: huge, b: new Decimal(0) }, expect: { result: true, effects: [] } } });
    const report = await c.check(c.spec("比べる", { examples, implementation: 大きいか }));
    expect(report.failures).toStrictEqual([]);
  });

  it("is no row composed for a border, so generate still offers the others", () => {
    const examples = c.examples(比べる, { 小さい: { given: { kind: "request", a: new Decimal(0), b: huge }, expect: { result: false, effects: [] } } });
    expect(() => c.generate(examples, 大きいか)).not.toThrow();
  });

  it("is no scale a round completes at, since the power it takes is past the room", async () => {
    const 丸め = c.behavior("丸め", { input: c.variants("kind", { r: c.object({ v: c.decimal(2).min(new Decimal(0)).max(new Decimal(10)) }) }), result: c.decimal(), effects: emptyEffects });
    const huge = c.implement(丸め, { cases: { r: c.model("丸める", input => ({ result: c.round(input.v, 2_000_000_000, "half-even"), effects: [] })) } });
    const report = await c.check(c.spec("丸め", { examples: c.examples(丸め, {}), implementation: huge }));
    expect(report.stops.map(stop => stop.status)).not.toContain("never stops");
  });

  it("is not a value a round of a decimal with no scale completes for", async () => {
    const 丸め = c.behavior("丸め", { input: c.variants("kind", { r: c.object({ v: c.decimal().min(new Decimal(0)).max(new Decimal(10)) }) }), result: c.decimal(2), effects: emptyEffects });
    const rounded = c.implement(丸め, { cases: { r: c.model("丸める", input => ({ result: c.round(input.v, 2, "half-even"), effects: [] })) } });
    const report = await c.check(c.spec("丸め", { examples: c.examples(丸め, {}), implementation: rounded }));
    expect(report.stops.map(stop => stop.status)).toStrictEqual(["not resolved"]);
  });
});

describe("the classes a guard divides a decimal of any scale into", () => {
  it("keeps a class that holds values between two bounds closer than a whole unit, standing for it with one of them", async () => {
    const 狭い = c.behavior("狭い", { input: c.variants("kind", { request: c.object({ v: c.decimal().gt(new Decimal("0.1")).lt(new Decimal("0.1001")) }) }), result: c.boolean(), effects: emptyEffects });
    const 判定 = c.implement(狭い, {
      cases: { request: c.action("判定", { guards: v => [v.v.$gt(new Decimal("0.10005")).$else(() => ({ result: false, effects: [] }))], run: () => ({ result: true, effects: [] }) }) },
    });
    const report = await c.check(c.spec("狭い", { examples: c.examples(狭い, {}), implementation: 判定 }));
    const divided = report.partitions.flatMap(partition => partition.kind === "divided" ? [partition] : []);
    expect(divided.map(partition => [partition.missing, partition.excluded])).toStrictEqual([[["0.1 < v <= 0.10005", "0.10005 < v < 0.1001"], []]]);
    const { rows } = c.generate(c.examples(狭い, {}), 判定);
    const written = rows.filter(row => row.name.includes("v")).map(row => String((row.given as { v: Decimal }).v));
    expect(written).toContain("0.10005");
  });
});
