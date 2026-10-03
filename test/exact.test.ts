import { Decimal } from "decimal.js";
import { expect, it } from "vitest";
import * as c from "../src/index.js";
import { interpret } from "../src/model.js";
import { domainOf } from "../src/domain.js";

it("preserves signed 64-bit extrema across the JSON boundary", () => {
  for (const value of [c.INT64_MIN, c.INT64_MAX, 9007199254740993n]) {
    expect(c.decode(c.int64(), String(value))).toStrictEqual({ success: true, value });
    expect(c.encode(c.int64(), value)).toStrictEqual({ success: true, value: String(value) });
  }
  expect(c.int64().parse(c.INT64_MAX + 1n).success).toBe(false);
  expect(c.decode(c.int64(), 9007199254740992).success).toBe(false);
  expect(c.int64().min(9007199254740993n).placeholder()).toBe(9007199254740993n);
});
it("calculates and compares rational values without rounding", () => {
  const third = new c.Rational(1n, 3n);
  expect(third.times(new c.Rational(3n)).toString()).toBe("1");
  expect(new c.Rational(-2n, -6n).toString()).toBe("1/3");
  expect(c.rational().min(third).parse(new c.Rational(1n, 4n)).success).toBe(false);
  expect(c.decode(c.rational(), "2/6")).toStrictEqual({ success: true, value: third });
  expect(c.encode(c.rational(), third)).toStrictEqual({ success: true, value: "1/3" });
  expect(() => third.dividedBy(new c.Rational(0n))).toThrow();
  expect(interpret(c.arithmetic("multiply", third, new c.Rational(3n)), {})).toStrictEqual(new c.Rational(1n));
});
it("uses exact candidates for large integer boundaries", () => {
  const domain = domainOf(c.int64().min(9007199254740993n), 50);
  expect(domain.values).toContain(9007199254740993n);
  expect(domain.values.every(value => (value as bigint) >= 9007199254740993n)).toBe(true);
  expect(c.formatTypeScriptValue(9007199254740993n)).toBe("9007199254740993n");
});
it("produces exact quotients instead of truncating integer division", () => {
  expect(interpret(c.quotient(1n, 3n), {})).toStrictEqual(new c.Rational(1n, 3n));
});

it("does not round Decimal arithmetic to the process precision setting", () => {
  const left = new Decimal("123456789012345678901234567890.12");
  const right = new Decimal("0.01");
  expect(String(interpret(c.arithmetic("add", left, right), {}))).toBe("1.2345678901234567890123456789013e+29");
});
it("keeps safe integer linear results exact despite large intermediate sums", async () => {
  const { selfTerm, readOperand } = await import("../src/rule.js");
  const input = selfTerm<{ x: number; y: number; z: number }>();
  expect(readOperand(input.x.$plus(0), { x: Number.MIN_VALUE })).toBe(Number.MIN_VALUE);
  expect(readOperand(input.x.$plus(input.y).$minus(input.z), { x: Number.MAX_SAFE_INTEGER, y: 2, z: 2 })).toBe(Number.MAX_SAFE_INTEGER);
});
it("proves Decimal arithmetic bounds and scale over a large domain", () => {
  const definition = c.behavior("amount", {
    input: c.variants("kind", { input: c.object({ amount: c.decimal(2).min(new Decimal(0)).max(new Decimal("100000000000000000000")) }) }),
    result: c.decimal(2).min(new Decimal(1)), effects: c.variants("kind", {}),
  });
  const impl = c.implement(definition, { cases: { input: c.model("add", input => ({ result: c.arithmetic("add", input.amount, new Decimal(1)), effects: [] })) } });
  expect(c.verify(impl).status).toBe("verified");
});
it("enumerates a small int64 range exhaustively", () => {
  const domain = domainOf(c.int64().min(9007199254740993n).max(9007199254740995n), 100);
  expect(domain.exhaustive).toBe(true);
  expect(new Set(domain.values)).toStrictEqual(new Set([9007199254740993n, 9007199254740994n, 9007199254740995n]));
});
it("reports an evaluation budget as undecided rather than a counterexample", () => {
  const definition = c.behavior("budget", { input: c.variants("kind", { input: c.object({}) }), result: c.decimal(0), effects: c.variants("kind", {}) });
  const impl = c.implement(definition, { cases: { input: c.model("large", () => ({ result: c.arithmetic("multiply", new Decimal("1e10001"), new Decimal(1)), effects: [] })) } });
  const proof = c.verify(impl);
  expect(proof.status).toBe("undetermined");
  expect(proof.decisions[0]).not.toHaveProperty("counterexample");
});
it("snapshots Decimal constants when a model is declared", async () => {
  const value = new Decimal(1);
  const definition = c.behavior("snapshot", { input: c.variants("kind", { input: c.object({}) }), result: c.decimal(0), effects: c.variants("kind", {}) });
  const impl = c.implement(definition, { cases: { input: c.model("constant", () => ({ result: value, effects: [] })) } });
  value.d[0] = 9;
  expect(String((await c.perform(impl, { kind: "input" })).result)).toBe("1");
});
it("serializes report documents containing int64 counterexamples without a replacer", async () => {
  const definition = c.behavior("int64 report", {
    input: c.variants("kind", { input: c.object({ n: c.int64().min(0n).max(1n) }) }),
    result: c.int64().min(1n), effects: c.variants("kind", {}),
  });
  const impl = c.implement(definition, { cases: { input: c.model("identity", input => ({ result: input.n, effects: [] })) } });
  const report = await c.check(c.spec("report", { implementation: impl, examples: c.examples(definition, {}) }));
  const document = c.reportDocument([report], { id: "report", name: "report" });
  const encoded = JSON.parse(JSON.stringify(document));
  expect(encoded.reports[0].measures.constructions.decisions[0].counterexample.n).toBe("0");
});
