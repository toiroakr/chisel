import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { eachWayOf, describeWay } from "../src/ways.js";
import { feasibilityOf } from "../src/feasibility.js";
import { NO_FACTS, withSteps } from "../src/outcomes.js";
import { feasibilityScope } from "../src/guard-borders.js";
import { positionTerm } from "../src/rule.js";
import type { Rule } from "../src/rule.js";
import { planChange, planChangeRules } from "./fixtures/plan-change.js";

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
    expect([...eachWayOf(planChangeRules.cases.changed as never)].length).toBeLessThan(200);
    const report = await c.check(c.spec("plan change", { implementation: planChangeRules, examples: c.examples(planChange, {}) }));
    expect(report.measures.rules.status).toBe("complete");
    const rules = report.measures.rules.status === "complete" ? report.measures.rules.rules : [];
    expect(rules.filter(rule => rule.status === "undecided")).toStrictEqual([]);
    expect(report.measures.constructions.status).toBe("verified");
  }, 60_000);

  it("proves no part of a model that breaks a guarantee", () => {
    const broken = c.implement(planChange, {
      cases: {
        started: planChangeRules.cases.started,
        changed: c.model("forgets to keep", change => ({
          result: {
            sets: { tierChanged: "none" as const, teamChanged: "none" as const, billingMoved: "none" as const, billingAdded: "none" as const,
              invoiceStarted: "none" as const, madeInvoiced: "none" as const, discountChanged: "none" as const, dedicatedAdded: "none" as const,
              featuresRemoved: c.choose(change.before.tier.$eq("pro"), "holds" as const, "none" as const) },
            keeps: { uninvoiced: false, shared: false, billing: false, features: c.choose(change.before.tier.$eq("pro"), true, false) },
          },
          effects: [],
        })),
      },
    });
    const changed = c.verify(broken).decisions.find(decision => decision.decision === "forgets to keep");
    expect(changed).toBeDefined();
    expect(changed?.status).not.toBe("verified");
  });

  it("proves a guarantee the model meets by the same quantified condition written negated", () => {
    const Lists = c.variants("kind", { request: c.object({ before: c.array(c.string()), after: c.array(c.string()), note: c.string() }) });
    const archive = c.behavior("archive", {
      input: Lists, result: c.object({ archive: c.boolean() }), effects: emptyEffects,
      ensures: clause => [clause.always("every tag before is kept or archived", (input, value) =>
        value.archive.$eq(true).$or(input.before.$all(item => input.after.$any(kept => kept.$eq(item)))))],
    });
    const impl = c.implement(archive, {
      cases: { request: c.model("archive", input => ({
        result: { archive: c.choose(input.before.$any(item => input.after.$all(kept => kept.$ne(item))), true, false) }, effects: [],
      })) },
    });
    expect(c.verify(impl).status).toBe("verified");
  });
  describe("the proof of a model of independent parts", () => {
    const Request = c.variants("kind", { request: c.object({ x: c.string(), list: c.array(c.int()) }) });
    const prove = (result: unknown, ensures: unknown, ways: number, answer: c.Schema<unknown> = c.object({ p: c.int(), q: c.int() })) => {
      const behavior = c.behavior("agree", { input: Request, result: answer, effects: emptyEffects, ...(ensures === undefined ? {} : { ensures }) } as never);
      const implementation = c.implement(behavior, { cases: { request: c.model("agree", (input: any) => ({ result: (result as (input: unknown) => unknown)(input), effects: [] })) } } as never);
      return c.verify(implementation, { ways }).decisions[0]!;
    };

    it("gives the proof over every way together a budget of its own after the factored proof could not prove the frame", () => {
      const decision = prove(
        (input: any) => ({ p: c.choose(input.x.$eq("A"), 1, 0), q: c.choose(input.x.$eq("A"), 1, 0) }),
        undefined,
        2,
        c.object({ p: c.int(), q: c.int() }).refine((value: any) => value.p.$eq(value.q)),
      );
      expect([decision.status, decision.reason]).toStrictEqual(["verified", expect.any(String)]);
    });
  });
  describe("the proof of parts that share a choice", () => {
    it("falls back to the proof over every way together when the factored proof ran out of paths that proof fits within", () => {
      const Request = c.variants("kind", { request: c.object({ x: c.string() }) });
      const behavior = c.behavior("agree", {
        input: Request,
        result: c.object({ p: c.int(), q: c.int() }),
        effects: emptyEffects,
        ensures: (clause: any) => [clause.always("the two agree", (input: any, value: any) => value.p.$eq(value.q).$or(input.x.$eq("none")))],
      } as never);
      const implementation = c.implement(behavior, { cases: { request: c.model("agree", (input: any) => ({ result: { p: c.choose(input.x.$eq("A"), 1, 0), q: c.choose(input.x.$eq("A"), 1, 0) }, effects: [] })) } } as never);
      expect(c.verify(implementation, { ways: 2 }).decisions[0]!.status).toBe("verified");
    });
  });
  describe("what the steps of a way settle of a value", () => {
    const compare = (operator: "==" | "!=", right: unknown) => ({ distinction: { kind: "compare", operator, left: positionTerm(["x"], "value"), right } as Rule as never, outcome: true });

    it("contradicts two different strings a position is equal to", () => {
      expect(withSteps(NO_FACTS, [compare("==", "a"), compare("==", "b")])).toBeUndefined();
    });

    it("does not contradict a number and a string of digits a decimal holds equal to, since the comparison reads both as the same decimal", () => {
      expect(withSteps(NO_FACTS, [compare("==", 1), compare("==", "1")])).toBeDefined();
      expect(withSteps(NO_FACTS, [compare("==", "1.0"), compare("==", "1")])).toBeDefined();
    });

    it("keeps its fact of a string that merely starts like a number, which no decimal reads", () => {
      expect(withSteps(NO_FACTS, [compare("==", "1abc"), compare("==", "1abd")])).toBeUndefined();
    });
  });
  it("lists the ways through the body of a walk that is itself a part once, as the walk's and not as a part's", () => {
    const Items = c.variants("kind", { request: c.object({ items: c.array(c.int()), f: c.int() }) });
    const walked = c.behavior("walked", { input: Items, result: c.object({ a: c.array(c.int()), q: c.int() }), effects: emptyEffects });
    const impl = c.implement(walked, { cases: { request: c.model("walked", (input: any) => ({
      result: { a: c.map(c.int(), c.int(), input.items, (item: any) => c.choose(item.$gt(0), 1, 0)), q: c.choose(input.f.$gt(0), 1, 0) },
      effects: [],
    })) } } as never);
    expect([...eachWayOf(impl.cases.request as never)].map(describeWay)).toStrictEqual([
      "result.q: $.f > 0 holds → otherwise",
      "result.q: $.f > 0 fails → otherwise",
      "each of $.items[]: $.items[] > 0 holds → otherwise",
      "each of $.items[]: $.items[] > 0 fails → otherwise",
    ]);
  });
  it("keeps a value of two enums the way equates that an ordering of one of them still allows", () => {
    const Pair = c.variants("kind", { request: c.object({ x: c.enum(["a", "b"]), y: c.enum(["a", "b"]) }) });
    const pair = c.behavior("pair", { input: Pair, result: c.int(), effects: emptyEffects });
    const scope = feasibilityScope(pair as never, "request");
    const steps = (rule: Rule, outcome: boolean) => ({ distinction: rule as never, outcome });
    const compare = (left: string, operator: "==" | "<=", right: unknown) => ({ kind: "compare", operator, left: positionTerm([left], "value"), right } as Rule);
    const same = { kind: "compare", operator: "==", left: positionTerm(["x"], "value"), right: positionTerm(["y"], "value") } as Rule;
    expect(feasibilityOf({ steps: [steps(same, true), steps(compare("x", "<=", "a"), true), steps(compare("y", "==", "a"), true)] }, scope).kind).toBe("feasible");
  });
  it("lists no way through the body of a walk that no way of choosing reaches", () => {
    const Walked = c.variants("kind", { request: c.object({ x: c.string(), items: c.array(c.int()), flag: c.boolean() }) });
    const dead = c.behavior("dead", { input: Walked, result: c.int(), effects: emptyEffects });
    const impl = c.implement(dead, { cases: { request: c.model("dead", (input: any) => ({
      result: c.choose(input.x.$eq("a"), c.choose(input.x.$eq("b"),
        c.fold(c.int(), c.int(), input.items, 0, (total: any, item: any) => c.choose(input.flag.$eq(true), item, total)), 0), 0),
      effects: [],
    })) } } as never);
    expect([...eachWayOf(impl.cases.request as never)].map(describeWay)).toStrictEqual([
      '$.x == "a" holds, $.x == "b" fails → otherwise',
      '$.x == "a" fails → otherwise',
    ]);
  });
});
