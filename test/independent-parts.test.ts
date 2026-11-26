import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { eachWayOf, describeWay } from "../src/ways.js";
import { feasibilityOf } from "../src/feasibility.js";
import { feasibilityScope } from "../src/guard-borders.js";
import { positionTerm } from "../src/rule.js";
import type { Rule } from "../src/rule.js";
import { fieldChange, fieldChangeRules } from "./fixtures/field-change.js";

const emptyEffects = c.variants("kind", {});
const Flags = c.variants("kind", { request: c.object({ a: c.int(), b: c.int(), d: c.int(), note: c.string() }) });
const flags = c.behavior("flags", { input: Flags, result: c.object({ 甲: c.int(), 乙: c.int(), 丙: c.int() }), effects: emptyEffects });
const flagsOf = c.implement(flags, {
  cases: {
    request: c.model("flags", input => ({
      result: {
        甲: c.choose(input.a.$gt(0), 1, 0),
        乙: c.choose(input.b.$gt(0), 1, 0),
        丙: c.choose(input.d.$gt(10), 3, c.choose(input.d.$gt(5), 2, c.choose(input.d.$gt(0), 1, 0))),
      },
      effects: [],
    })),
  },
});

describe("independent parts of a model", () => {
  it("lists the ways of fields that read nothing of one another apart, so they add up rather than multiply", () => {
    const ways = [...eachWayOf(flagsOf.cases.request as never)].map(describeWay);
    expect(ways).toStrictEqual([
      "result.甲: $.a > 0 holds → otherwise",
      "result.甲: $.a > 0 fails → otherwise",
      "result.乙: $.b > 0 holds → otherwise",
      "result.乙: $.b > 0 fails → otherwise",
      "result.丙: $.d > 10 holds → otherwise",
      "result.丙: $.d > 10 fails, $.d > 5 holds → otherwise",
      "result.丙: $.d > 10 fails, $.d > 5 fails, $.d > 0 holds → otherwise",
      "result.丙: $.d > 10 fails, $.d > 5 fails, $.d > 0 fails → otherwise",
    ]);
  });

  it("still combines a choice whose value another reads", () => {
    const combined = c.implement(flags, {
      cases: {
        request: c.model("combined", input => ({
          result: c.bind<number, { 甲: number; 乙: number; 丙: number }>(c.int(), c.choose(input.a.$gt(0), 1, 0), first => ({
            甲: first, 乙: c.choose(first.$eq(1), 2, c.choose(input.b.$gt(0), 1, 0)), 丙: 0,
          })),
          effects: [],
        })),
      },
    });
    expect([...eachWayOf(combined.cases.request as never)].length).toBe(6);
  });

  it("meets a part's way by a row whose run takes it there, whatever it takes through the others", async () => {
    const examples = c.examples(flags, {
      high: { given: { kind: "request", a: 1, b: 1, d: 11, note: "" }, expect: { result: { 甲: 1, 乙: 1, 丙: 3 }, effects: [] } },
      low: { given: { kind: "request", a: 0, b: 0, d: 0, note: "" }, expect: { result: { 甲: 0, 乙: 0, 丙: 0 }, effects: [] } },
    });
    const report = await c.check(c.spec("flags", { examples, implementation: flagsOf }));
    expect(report.measures.rules.status).toBe("complete");
    const rules = report.measures.rules.status === "complete" ? report.measures.rules.rules : [];
    expect(rules.map(rule => [rule.way, rule.status])).toStrictEqual([
      ["result.甲: $.a > 0 holds → otherwise", "met"],
      ["result.甲: $.a > 0 fails → otherwise", "met"],
      ["result.乙: $.b > 0 holds → otherwise", "met"],
      ["result.乙: $.b > 0 fails → otherwise", "met"],
      ["result.丙: $.d > 10 holds → otherwise", "met"],
      ["result.丙: $.d > 10 fails, $.d > 5 holds → otherwise", "gap"],
      ["result.丙: $.d > 10 fails, $.d > 5 fails, $.d > 0 holds → otherwise", "gap"],
      ["result.丙: $.d > 10 fails, $.d > 5 fails, $.d > 0 fails → otherwise", "met"],
    ]);
  });

  it("leaves out a way whose steps make one value equal to two constants", () => {
    const kinds = c.behavior("kinds", { input: c.variants("kind", { request: c.object({ type: c.string() }) }), result: c.int(), effects: emptyEffects });
    const impl = c.implement(kinds, {
      cases: { request: c.model("kinds", input => ({ result: c.choose(input.type.$eq("a"), 1, c.choose(input.type.$eq("b"), 2, 0)), effects: [] })) },
    });
    const ways = [...eachWayOf(c.implement(kinds, {
      cases: { request: c.model("twice", input => ({ result: c.choose(input.type.$eq("a").$and(input.type.$eq("b")), 1, 0), effects: [] })) },
    }).cases.request as never)].map(describeWay);
    expect(ways).toStrictEqual([`$.type == "a" holds, $.type == "b" fails → otherwise`, `$.type == "a" fails → otherwise`]);
    expect([...eachWayOf(impl.cases.request as never)].length).toBe(3);
  });

  it("settles an equality of two finite values, and of two strings, with what else the way asks of them", () => {
    const Pair = c.variants("kind", { request: c.object({ x: c.boolean(), y: c.boolean(), s: c.string(), t: c.string() }) });
    const pair = c.behavior("pair", { input: Pair, result: c.int(), effects: emptyEffects });
    const scope = feasibilityScope(pair as never, "request");
    const steps = (rule: Rule, outcome: boolean) => ({ distinction: rule as never, outcome });
    const x = { kind: "compare", operator: "==", left: positionTerm(["x"], "value"), right: positionTerm(["y"], "value") } as Rule;
    const xTrue = { kind: "compare", operator: "==", left: positionTerm(["x"], "value"), right: true } as Rule;
    const yFalse = { kind: "compare", operator: "==", left: positionTerm(["y"], "value"), right: false } as Rule;
    expect(feasibilityOf({ steps: [steps(x, true), steps(xTrue, true), steps(yFalse, true)] }, scope).kind).toBe("infeasible");
    expect(feasibilityOf({ steps: [steps(x, false), steps(xTrue, true), steps(yFalse, true)] }, scope).kind).toBe("feasible");
    const st = { kind: "compare", operator: "==", left: positionTerm(["s"], "value"), right: positionTerm(["t"], "value") } as Rule;
    const sA = { kind: "compare", operator: "==", left: positionTerm(["s"], "value"), right: "a" } as Rule;
    const tB = { kind: "compare", operator: "==", left: positionTerm(["t"], "value"), right: "b" } as Rule;
    expect(feasibilityOf({ steps: [steps(st, true), steps(sA, true), steps(tB, true)] }, scope).kind).toBe("infeasible");
    expect(feasibilityOf({ steps: [steps(st, false), steps(sA, true), steps(tB, true)] }, scope).kind).toBe("feasible");
    expect(feasibilityOf({ steps: [steps(st, false), steps(sA, true), steps({ ...tB, right: "a" } as Rule, true)] }, scope).kind).toBe("infeasible");
  });

  it("measures, settles and proves a model of many independent verdicts part by part", async () => {
    expect([...eachWayOf(fieldChangeRules.cases.modified as never)].length).toBeLessThan(200);
    const report = await c.check(c.spec("field change", { implementation: fieldChangeRules, examples: c.examples(fieldChange, {}) }));
    expect(report.measures.rules.status).toBe("complete");
    const rules = report.measures.rules.status === "complete" ? report.measures.rules.rules : [];
    expect(rules.filter(rule => rule.status === "undecided")).toStrictEqual([]);
    expect(report.measures.constructions.status).toBe("verified");
  }, 60_000);

  it("proves no part of a model that breaks a guarantee", () => {
    const broken = c.implement(fieldChange, {
      cases: {
        added: fieldChangeRules.cases.added,
        modified: c.model("forgets to loosen", change => ({
          result: {
            breaks: { typeChanged: "none" as const, arrayChanged: "none" as const, targetMoved: "none" as const, targetAdded: "none" as const,
              requiredAdded: "none" as const, madeRequired: "none" as const, scaleChanged: "none" as const, uniqueAdded: "none" as const,
              valuesRemoved: c.choose(change.before.type.$eq("enum"), "holds" as const, "none" as const) },
            relax: { optional: false, notUnique: false, withoutTarget: false, previousValues: c.choose(change.before.type.$eq("enum"), true, false) },
          },
          effects: [],
        })),
      },
    });
    const modified = c.verify(broken).decisions.find(decision => decision.decision === "forgets to loosen");
    expect(modified?.status).not.toBe("verified");
  });
});

