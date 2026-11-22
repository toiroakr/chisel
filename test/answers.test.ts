import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const found = c.variants("kind", { missing: c.object({}), ok: c.object({ amount: c.int().min(1) }) });
const price = c.behavior("price", {
  input: c.variants("kind", { ask: c.object({ sku: c.string() }) }),
  result: c.variants("verdict", { priced: c.object({ amount: c.int().min(1) }), unknown: c.object({}), cheap: c.object({}) }),
  effects: c.variants("kind", {}),
  dependencies: { lookup: c.dependency(c.string(), found) },
});
type Verdict = c.Infer<typeof price.result>;
const implementation = c.implement(price, { cases: { ask: c.model("price", (input, deps) => ({
  result: c.matchValue<typeof found, Verdict>(found, c.call(deps.lookup, input.sku), {
    missing: () => ({ verdict: "unknown" }),
    ok: answer => c.choose<Verdict>(answer.amount.$gte(100), { verdict: "priced", amount: answer.amount }, { verdict: "cheap" }),
  }),
  effects: [],
})) } });
const fakes = [c.fake(price, "lookup", [
  ["at", { kind: "ok", amount: 100 }],
  ["below", { kind: "ok", amount: 99 }],
  ["above", { kind: "ok", amount: 101 }],
  ["far below", { kind: "ok", amount: 50 }],
  ["gone", { kind: "missing" }],
])];
const asked = (sku: string, verdict: Verdict) => ({ given: { kind: "ask" as const, sku }, expect: { result: verdict, effects: [] } });

describe("a match over a dependency's answer", () => {
  it("is measured as ways through the answer, which fakes answer", async () => {
    const report = await c.check(c.spec("price", { implementation, fakes, examples: c.examples(price, {
      at: asked("at", { verdict: "priced", amount: 100 }),
      below: asked("below", { verdict: "cheap" }),
      above: asked("above", { verdict: "priced", amount: 101 }),
      "far below": asked("far below", { verdict: "cheap" }),
      gone: asked("gone", { verdict: "unknown" }),
    }) }));
    expect(report.measures.rules.status === "complete" ? report.measures.rules.rules.map(rule => [rule.way, rule.status]) : report.measures.rules).toStrictEqual([
      ['lookup().kind == "missing" holds → otherwise', "met"],
      ['lookup().kind == "missing" fails, lookup().amount >= 100 holds → otherwise', "met"],
      ['lookup().kind == "missing" fails, lookup().amount >= 100 fails → otherwise', "met"],
    ]);
    expect(report.borders.map(border => [border.rule, border.points.map(point => point.status)])).toContainEqual(
      ["guard lookup().amount >= 100", ["met", "met", "met", "met"]],
    );
    expect(report.verdict).toBe("satisfied");
  });

  it("is composed by generate from the input a fake row asks", () => {
    const generated = c.generate(c.examples(price, { at: asked("at", { verdict: "priced", amount: 100 }) }), implementation, { fakes });
    expect(generated.notComposed).toStrictEqual([]);
    expect(generated.rows.map(row => [row.name.replace("price: ", ""), row.given])).toStrictEqual([
      ["@ask.lookup()@ok.amount OFF (= 99)", { kind: "ask", sku: "below" }],
      ["@ask.lookup()@ok.amount IN (> 100)", { kind: "ask", sku: "above" }],
      ["@ask.lookup()@ok.amount OUT (< 99)", { kind: "ask", sku: "far below" }],
      ['price lookup().kind == "missing" holds → otherwise', { kind: "ask", sku: "gone" }],
    ]);
  });

  it("names what a fake must answer where no fake row does", () => {
    expect(c.generate(c.examples(price, {}), implementation).notComposed).toContain(
      'price: lookup().kind == "missing" holds → otherwise — lookup()がそう答えるfakeの行がない',
    );
  });

  it("owes no row where the dependency's ensures leave the answer no value", async () => {
    const answer = c.variants("kind", { ok: c.object({ amount: c.int() }), missing: c.object({}) });
    const lookup = c.behavior("lookup", {
      input: c.variants("kind", { request: c.object({ minimum: c.int().min(1) }) }), result: answer, effects: c.variants("kind", {}),
      ensures: clause => [clause.when("at least", ["ok"], (input, value) => value.amount.$gte(input.minimum))],
    });
    const quote = c.behavior("quote", {
      input: c.variants("kind", { ask: c.object({ min: c.int().min(1) }) }),
      result: c.variants("v", { fine: c.object({}), below: c.object({}), none: c.object({}) }), effects: c.variants("kind", {}),
      dependencies: { lookup: c.dependency(lookup) },
    });
    type Quoted = c.Infer<typeof quote.result>;
    const quoting = c.implement(quote, { cases: { ask: c.model("quote", (input, deps) => ({
      result: c.matchValue<typeof answer, Quoted>(answer, c.call(deps.lookup, { kind: "request", minimum: input.min }), {
        missing: () => ({ v: "none" }),
        ok: amount => c.choose<Quoted>(amount.amount.$lt(input.min), { v: "below" }, { v: "fine" }),
      }),
      effects: [],
    })) } });
    const report = await c.check(c.spec("quote", { implementation: quoting, examples: c.examples(quote, {}) }));
    expect(report.measures.rules.status === "complete" ? report.measures.rules.rules.map(rule => rule.status) : report.measures.rules)
      .toStrictEqual(["no row owed", "gap", "gap"]);
  });
});

describe("the answer a match is bound under", () => {
  it("is what the dependency answers that the match's schema also takes", async () => {
    const answer = c.variants("kind", { ok: c.object({ amount: c.int().min(0).max(1000) }), missing: c.object({}) });
    const narrower = c.variants("kind", { ok: c.object({ amount: c.int().min(10).max(1000) }), missing: c.object({}) });
    const priced = c.behavior("priced", {
      input: c.variants("kind", { request: c.object({ sku: c.string() }) }), result: c.int(), effects: c.variants("kind", {}),
      dependencies: { lookup: c.dependency(c.string(), answer) },
    });
    const matched = c.implement(priced, { cases: { request: c.model("matched", (input, deps) => ({
      result: c.matchValue(narrower, c.call(deps.lookup, input.sku), { ok: found => c.choose(found.amount.$lt(5), 1, 2), missing: () => 0 }),
      effects: [],
    })) } });
    const report = await c.check(c.spec("priced", { implementation: matched, examples: c.examples(priced, {}) }));
    expect(report.measures.rules.status === "complete" ? report.measures.rules.rules.map(rule => rule.status) : report.measures.rules)
      .toStrictEqual(["no row owed", "gap", "gap"]);
  });
});
