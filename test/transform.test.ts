import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import type { CompareRule } from "../src/rule.js";
import { describeRule, holds, satisfy, selfTerm } from "../src/rule.js";
import { witnessesOf } from "../src/feasibility.js";

describe("transforms", () => {
  const text = selfTerm<string>();

  it("read the string as the String.prototype method of that name gives it back", () => {
    expect(holds(text.$trim().$eq("x"), "  x \n")).toBe(true);
    expect(holds(text.$lowercase().$eq("abc"), "AbC")).toBe(true);
    expect(holds(text.$uppercase().$eq("ABC"), "abc")).toBe(true);
    expect(holds(text.$eq("abc"), "AbC")).toBe(false);
  });

  it("apply in the order they are written", () => {
    expect(holds(text.$trim().$lowercase().$eq("abc"), " ABC ")).toBe(true);
    expect(holds(text.$lowercase().$trim().$length().$eq(3), " ABC ")).toBe(true);
    expect(describeRule(text.$trim().$lowercase().$length().$eq(3))).toBe("length(lowercase(trim($))) == 3");
  });

  it("reads the length of the string without the whitespace at either end", () => {
    expect(holds(text.$trim().$length().$eq(1), "  x \n")).toBe(true);
    expect(holds(text.$trim().$length().$eq(0), " \t ")).toBe(true);
    expect(holds(text.$trim().$length().$eq(3), "a b")).toBe(true);
    expect(holds(text.$length().$eq(3), " \t ")).toBe(true);
  });

  it("is described as the length of the trimmed string", () => {
    expect(describeRule(text.$trim().$length().$gt(0))).toBe("length(trim($)) > 0");
  });

  it("refuses a value its invariant breaks", () => {
    const reason = c.string().refine("not blank", value => value.$trim().$length().$gte(1));
    expect(reason.parse("  x ").success).toBe(true);
    expect(reason.parse("   ").success).toBe(false);
    expect(reason.parse("").success).toBe(false);
  });
});

// A rejection that needs a reason with something besides whitespace in it.
// The trimmed length is a coordinate of its own, beside the length.
const reject = c.behavior("reject", {
  input: c.variants("kind", { request: c.object({ reason: c.string() }) }),
  result: c.variants("outcome", { rejected: c.object({ reason: c.string() }), reasonRequired: c.object({}) }),
  effects: c.variants("type", {}),
});
type Answer = c.Execution<c.BehaviorResult<typeof reject>, c.BehaviorEffect<typeof reject>>;
const rejectImplementation = c.implement(reject, {
  cases: {
    request: c.model("a reason must not be blank", request =>
      c.choose<Answer>(
        request.reason.$trim().$length().$gt(0),
        { result: { outcome: "rejected" as const, reason: request.reason }, effects: [] },
        { result: { outcome: "reasonRequired" as const }, effects: [] },
      ),
    ),
  },
});
const rejected = (reason: string) => ({ result: { outcome: "rejected" as const, reason }, effects: [] });
const required = { result: { outcome: "reasonRequired" as const }, effects: [] };

describe("a guard on a trimmed length", () => {
  it("draws its border on the trimmed length, and is satisfied by rows on either side", async () => {
    const specification = c.spec("reject", {
      implementation: rejectImplementation,
      examples: c.examples(reject, {
        empty: { given: { kind: "request", reason: "" }, expect: required },
        blank: { given: { kind: "request", reason: "   " }, expect: required },
        "one letter": { given: { kind: "request", reason: "x" }, expect: rejected("x") },
        "one letter padded": { given: { kind: "request", reason: " x " }, expect: rejected(" x ") },
        "two letters": { given: { kind: "request", reason: "xy" }, expect: rejected("xy") },
      }),
    });
    const report = await c.check(specification);
    expect(report.verdict).toBe("satisfied");
    expect(report.failures).toStrictEqual([]);
  });

  it("holds a blank reason to the guard, not to the reason's length", async () => {
    const specification = c.spec("reject", {
      implementation: rejectImplementation,
      examples: c.examples(reject, {
        blank: { given: { kind: "request", reason: "   " }, expect: rejected("   ") },
      }),
    });
    const report = await c.check(specification);
    expect(report.failures.map(failure => failure.name)).toStrictEqual(["blank"]);
  });

  it("generates rows at the points of the trimmed length", () => {
    const rows = c.examples(reject, {
      "one letter": { given: { kind: "request", reason: "x" }, expect: rejected("x") },
    });
    const given = c.generate(rows, rejectImplementation).rows.map(row => row.given);
    const lengths = given.map(input => (input as { reason: string }).reason.trim().length);
    expect(lengths).toContain(0);
    expect(lengths.some(length => length > 1)).toBe(true);
  });

  it("stands at a trimmed length of 0 with whitespace where the reason may not be empty", () => {
    const required = c.behavior("reject", {
      input: c.variants("kind", { request: c.object({ reason: c.string().min(1) }) }),
      result: c.variants("outcome", { rejected: c.object({}), reasonRequired: c.object({}) }),
      effects: c.variants("type", {}),
    });
    const implementation = c.implement(required, {
      cases: {
        request: c.action("a reason must not be blank", {
          guards: request => [
            request.reason.$trim().$length().$gt(0).$else(() => ({ result: { outcome: "reasonRequired" as const }, effects: [] })),
          ],
          run: () => ({ result: { outcome: "rejected" as const }, effects: [] }),
        }),
      },
    });
    const rows = c.examples(required, {
      "one letter": { given: { kind: "request", reason: "x" }, expect: { result: { outcome: "rejected" }, effects: [] } },
    });
    const generated = c.generate(rows, implementation);
    expect(generated.notComposed).toStrictEqual([]);
    expect(
      generated.rows.filter(row => row.name.includes("OFF (= 0)")).map(row => row.given),
    ).toStrictEqual([{ kind: "request", reason: " " }]);
  });

  it("stands at a trimmed length with whitespace where the reason may be left out", () => {
    const optional = c.behavior("reject", {
      input: c.variants("kind", { request: c.object({ reason: c.string().min(2).optional() }) }),
      result: c.variants("outcome", { rejected: c.object({}), reasonRequired: c.object({}) }),
      effects: c.variants("type", {}),
    });
    const implementation = c.implement(optional, {
      cases: {
        request: c.action("a reason must not be blank", {
          guards: request => [
            request.reason.$trim().$length().$gt(0).$else(() => ({ result: { outcome: "reasonRequired" as const }, effects: [] })),
          ],
          run: () => ({ result: { outcome: "rejected" as const }, effects: [] }),
        }),
      },
    });
    const rows = c.examples(optional, {
      "three letters": { given: { kind: "request", reason: "abc" }, expect: { result: { outcome: "rejected" }, effects: [] } },
    });
    const generated = c.generate(rows, implementation);
    expect(generated.notComposed).toStrictEqual([]);
    expect(
      generated.rows.filter(row => /ON \(= 1\)|OFF \(= 0\)/.test(row.name)).map(row => [row.name, row.given]),
    ).toStrictEqual([
      ["reject: @request.reason ON (= 1)", { kind: "request", reason: "a " }],
      ["reject: @request.reason OFF (= 0)", { kind: "request", reason: "  " }],
    ]);
  });
});

// A code matched without regard to case or surrounding whitespace.
const lookup = c.behavior("lookup", {
  input: c.variants("kind", { request: c.object({ code: c.string() }) }),
  result: c.variants("outcome", { found: c.object({}), missing: c.object({}) }),
  effects: c.variants("type", {}),
});
type LookupAnswer = c.Execution<c.BehaviorResult<typeof lookup>, c.BehaviorEffect<typeof lookup>>;
const lookupImplementation = c.implement(lookup, {
  cases: {
    request: c.model("codes match without case", request =>
      c.choose<LookupAnswer>(
        request.code.$trim().$lowercase().$eq("abc"),
        { result: { outcome: "found" as const }, effects: [] },
        { result: { outcome: "missing" as const }, effects: [] },
      ),
    ),
  },
});
const found = { result: { outcome: "found" as const }, effects: [] };
const missing = { result: { outcome: "missing" as const }, effects: [] };

describe("a guard on a transformed value", () => {
  it("draws its border on the transformed value", async () => {
    const report = await c.check(
      c.spec("lookup", {
        implementation: lookupImplementation,
        examples: c.examples(lookup, {
          "as written": { given: { kind: "request", code: "abc" }, expect: found },
          "padded and in capitals": { given: { kind: "request", code: " ABC " }, expect: found },
          before: { given: { kind: "request", code: "aaa" }, expect: missing },
          after: { given: { kind: "request", code: "xyz" }, expect: missing },
        }),
      }),
    );
    expect(report.verdict).toBe("satisfied");
  });

  it("is not taken for the value itself", async () => {
    // "ZZZ" lies below "abc" as written, but "zzz" does not: no row stands below the border.
    const report = await c.check(
      c.spec("lookup", {
        implementation: lookupImplementation,
        examples: c.examples(lookup, {
          "as written": { given: { kind: "request", code: "abc" }, expect: found },
          capitals: { given: { kind: "request", code: "ZZZ" }, expect: missing },
        }),
      }),
    );
    expect(report.verdict).toBe("not_satisfied");
    expect(report.failures).toStrictEqual([]);
  });
});

describe("writing a transformed coordinate", () => {
  const text = selfTerm<string>();

  it("writes a transformed length the transforms read back", () => {
    const written = satisfy(text.$trim().$length().$eq(3), "ab cd");
    expect(holds(text.$trim().$length().$eq(3), written)).toBe(true);
  });

  it("writes a transformed value only where the transforms leave it as it is", () => {
    expect(satisfy(text.$lowercase().$eq("abc"), "x")).toBe("abc");
    // No value lowercases to "M" or below it as written, so the value is left as it is.
    expect(satisfy(text.$lowercase().$lte("M"), "zz")).toBe("zz");
  });

  it("chooses an enum's value the transforms read as the rule asks, rather than writing the target", () => {
    const level = c.enum(["Low", "High"]).refine(value => value.$lowercase().$eq("high"));
    expect(level.placeholder()).toBe("High");
    const request = c.object({ level: c.enum(["Low", "High"]) }).refine(value => value.level.$lowercase().$eq("high"));
    expect(request.placeholder()).toStrictEqual({ level: "High" });
  });

  it("stands in for a string its transform leaves as it is with the transformed placeholder", () => {
    const code = c.string().refine(value => value.$uppercase().$eq(value));
    expect(code.placeholder("code")).toBe("<CODE>");
    const request = c.object({ code: c.string() }).refine(value => value.code.$trim().$lowercase().$eq(value.code));
    expect(request.parse(request.placeholder())).toStrictEqual({ success: true, value: { code: "<code>" } });
    const upper = c.object({ code: c.string() }).refine(value => value.code.$uppercase().$eq(value.code));
    expect(upper.placeholder()).toStrictEqual({ code: "<CODE>" });

    const lookup = c.behavior("lookup", {
      input: c.variants("type", { go: c.object({ code: code }), other: c.object({}) }),
      result: c.variants("type", { ok: c.object({}) }),
      effects: c.variants("type", {}),
    });
    const generated = c.generate(lookup);
    expect(generated.rows.map(row => row.given)).toStrictEqual([{ type: "go", code: "<CODE>" }, { type: "other" }]);
    expect(generated.notComposed).toStrictEqual([]);
  });
});

describe("proving a transformed value", () => {
  type Text = ReturnType<typeof c.string>;
  const behaviorAnswering = (result: Text, input: Text) =>
    c.behavior("name", {
      input: c.variants("kind", { request: c.object({ name: input }) }),
      result,
      effects: c.variants("kind", {}),
    });

  it("does not take a transformed value for the value it transforms", () => {
    const definition = behaviorAnswering(
      c.string().refine(value => value.$trim().$ne("")),
      c.string().refine(value => value.$ne("")),
    );
    const implementation = c.implement(definition, {
      cases: { request: c.model("carry", request => ({ result: request.name, effects: [] })) },
    });
    // "  " is not empty, but trims to "".
    expect(c.verify(implementation).status).not.toBe("verified");
  });

  it("reads a transformed value off a constant", () => {
    const definition = behaviorAnswering(c.string().refine(value => value.$trim().$eq("a")), c.string());
    const implementation = c.implement(definition, {
      cases: { request: c.model("answer", () => ({ result: " a", effects: [] })) },
    });
    expect(c.verify(implementation).status).toBe("verified");
  });
});

describe("generating rows at a transformed coordinate", () => {
  const coded = (code: ReturnType<typeof c.string>) =>
    c.behavior("coded", {
      input: c.variants("kind", { request: c.object({ code }) }),
      result: c.variants("outcome", { yes: c.object({}), no: c.object({}) }),
      effects: c.variants("type", {}),
    });
  type Coded = ReturnType<typeof coded>;
  const guarded = (definition: Coded, condition: (code: c.TermOf<string>) => c.Rule) =>
    c.implement(definition, {
      cases: {
        request: c.model("guarded", request =>
          c.choose<c.Execution<c.BehaviorResult<Coded>, c.BehaviorEffect<Coded>>>(
            condition(request.code),
            { result: { outcome: "yes" as const }, effects: [] },
            { result: { outcome: "no" as const }, effects: [] },
          ),
        ),
      },
    });
  const yes = { result: { outcome: "yes" as const }, effects: [] };

  it("leaves a field that is left out as it is", () => {
    const definition = c.behavior("coded", {
      input: c.variants("kind", { request: c.object({ code: c.string().optional() }) }),
      result: c.variants("outcome", { yes: c.object({}), no: c.object({}) }),
      effects: c.variants("type", {}),
    });
    const implementation = c.implement(definition, {
      cases: {
        request: c.action("long codes", {
          guards: request => [
            request.code.$trim().$length().$gt(2).$else(() => ({ result: { outcome: "no" as const }, effects: [] })),
          ],
          run: () => yes,
        }),
      },
    });
    const rows = c.examples(definition, { "left out": { given: { kind: "request" }, expect: yes } });
    expect(() => c.generate(rows, implementation)).not.toThrow();
  });

  it("steps past a bound as the transforms read it", () => {
    const definition = coded(c.string());
    const implementation = guarded(definition, code => code.$uppercase().$gt("ABC"));
    const rows = c.examples(definition, { "at the bound": { given: { kind: "request", code: "ABC" }, expect: { result: { outcome: "no" as const }, effects: [] } } });
    const above = c.generate(rows, implementation).rows.filter(row => row.name.includes('> "ABC"'));
    expect(above.length).toBeGreaterThan(0);
    for (const row of above) {
      expect((row.given as { code: string }).code.toUpperCase() > "ABC").toBe(true);
    }
  });

  it("owes no row at a point no value reads back as", () => {
    const definition = coded(c.string());
    const implementation = guarded(definition, code => code.$lowercase().$eq("ABC"));
    const rows = c.examples(definition, { other: { given: { kind: "request", code: "xyz" }, expect: { result: { outcome: "no" as const }, effects: [] } } });
    const generated = c.generate(rows, implementation);
    expect(generated.rows.filter(row => row.name.includes('ON (= "ABC")'))).toStrictEqual([]);
    expect(generated.notComposed.filter(label => label.includes('ON (= "ABC")'))).toStrictEqual([]);
  });
});

describe("a border between a string's length and its transformed length", () => {
  // Both sides read $.code, so moving one moves the other: a row is offered only
  // where it stands at the point, and the point is otherwise named as not composed.
  const padded = (condition: (code: c.TermOf<string>) => c.Rule) =>
    c.behavior("padded", {
      input: c.variants("kind", { request: c.object({ code: c.string() }).refine(request => condition(request.code)) }),
      result: c.variants("outcome", { yes: c.object({}) }),
      effects: c.variants("type", {}),
    });
  const yes = { result: { outcome: "yes" as const }, effects: [] };
  const spaces = (code: string) => [...code].length - code.trim().length;

  it("offers no row away from a point of an invariant", () => {
    const definition = padded(code => code.$length().$gt(code.$trim().$length()));
    const implementation = c.implement(definition, { cases: { request: c.model("yes", () => yes) } });
    const rows = c.examples(definition, { wide: { given: { kind: "request", code: "    X    " }, expect: yes } });
    const generated = c.generate(rows, implementation);
    // ON is one space more than the trimmed length.
    for (const row of generated.rows.filter(row => row.name.includes("ON (= 1)"))) {
      expect(spaces((row.given as { code: string }).code)).toBe(1);
    }
    expect(
      generated.rows.some(row => row.name.includes("ON (= 1)")) ||
        generated.notComposed.some(label => label.includes("ON (= 1)")),
    ).toBe(true);
  });

  it("offers no row away from a point of a guard", () => {
    const definition = c.behavior("padded", {
      input: c.variants("kind", { request: c.object({ code: c.string() }) }),
      result: c.variants("outcome", { yes: c.object({}), no: c.object({}) }),
      effects: c.variants("type", {}),
    });
    const implementation = c.implement(definition, {
      cases: {
        request: c.action("few spaces", {
          guards: request => [
            request.code.$length().$minus(request.code.$trim().$length()).$lte(1)
              .$else(() => ({ result: { outcome: "no" as const }, effects: [] })),
          ],
          run: () => ({ result: { outcome: "yes" as const }, effects: [] }),
        }),
      },
    });
    const rows = c.examples(definition, {
      bare: { given: { kind: "request", code: "X" }, expect: { result: { outcome: "yes" as const }, effects: [] } },
    });
    const generated = c.generate(rows, implementation);
    const offered = generated.rows.filter(row => row.name.includes("−"));
    // ON (= 0) is one space, OFF (= 1) two, OUT (> 1) more than two.
    const wanted: Readonly<Record<string, (count: number) => boolean>> = {
      "ON (= 0)": count => count === 1,
      "OFF (= 1)": count => count === 2,
      "OUT (> 1)": count => count > 2,
    };
    for (const row of offered) {
      const [label, holdsAt] = Object.entries(wanted).find(([label]) => row.name.includes(label))!;
      expect([label, holdsAt(spaces((row.given as { code: string }).code))]).toStrictEqual([label, true]);
    }
    for (const label of Object.keys(wanted)) {
      expect(
        offered.some(row => row.name.includes(label)) || generated.notComposed.some(named => named.includes(label)),
      ).toBe(true);
    }
  });
});

describe("a line beside a border between a string's length and its transformed length", () => {
  it("offers a row only at the input it names", async () => {
    const definition = c.behavior("padded", {
      input: c.variants("kind", { request: c.object({ code: c.string() }) }),
      result: c.variants("outcome", { yes: c.object({}), no: c.object({}) }),
      effects: c.variants("type", {}),
    });
    const yes = { result: { outcome: "yes" as const }, effects: [] };
    const no = { result: { outcome: "no" as const }, effects: [] };
    const implementation = c.implement(definition, {
      cases: {
        request: c.action("few spaces", {
          guards: request => [request.code.$length().$minus(request.code.$trim().$length()).$lte(1).$else(() => no)],
          run: () => yes,
        }),
      },
    });
    // Every row has one letter, so `length($.code) <= 2` parts them as well as the guard does.
    const rows = c.examples(definition, {
      none: { given: { kind: "request", code: "X" }, expect: yes },
      one: { given: { kind: "request", code: " X" }, expect: yes },
      two: { given: { kind: "request", code: "  X" }, expect: no },
      three: { given: { kind: "request", code: "   X" }, expect: no },
    });
    const report = await c.check(c.spec("padded", { implementation, examples: rows }));
    const beside = report.borders.flatMap(border => (border.beside?.status === "not told" ? [border.beside] : []));
    expect(beside.length).toBe(1);
    // Writing the trimmed length moves the length too: the row stands where both read as named.
    const [length, trimmed] = beside[0]!.input!.split(", ").map(part => Number(part.split(" = ")[1]));
    const offered = c.generate(rows, implementation).rows.filter(row => row.name.includes("隣の線"));
    expect(offered.length).toBe(1);
    const code = (offered[0]!.given as { code: string }).code;
    expect([[...code].length, code.trim().length]).toStrictEqual([length, trimmed]);
  });
});

describe("a match on a transformed value", () => {
  it("is refused, since no case is written for the value it reads", () => {
    const definition = c.behavior("levelled", {
      input: c.variants("kind", { request: c.object({ level: c.enum(["High", "Low"]) }) }),
      result: c.variants("outcome", { yes: c.object({}) }),
      effects: c.variants("type", {}),
    });
    const yes = () => ({ result: { outcome: "yes" as const }, effects: [] });
    expect(() =>
      c.implement(definition, {
        cases: { request: c.action("by level", { run: c.match(request => request.level.$lowercase(), { High: yes, Low: yes }) }) },
      }),
    ).toThrow(new c.SpecificationError("match in by level selects lowercase($.level), not the value of a field"));
  });
});

describe("a bound no transformed value reads as", () => {
  // No string uppercases to "abc" or lowercases to "ABC" or "Ba".
  const coded = (code: ReturnType<typeof c.string>) =>
    c.behavior("coded", {
      input: c.variants("kind", { request: c.object({ code }) }),
      result: c.variants("outcome", { yes: c.object({}), no: c.object({}) }),
      effects: c.variants("type", {}),
    });
  const yes = { result: { outcome: "yes" as const }, effects: [] };
  const no = { result: { outcome: "no" as const }, effects: [] };
  const guarded = (condition: (code: c.TermOf<string>) => c.Condition) => {
    const definition = coded(c.string());
    return {
      definition,
      implementation: c.implement(definition, {
        cases: { request: c.action("guarded", { guards: request => [condition(request.code).$else(() => no)], run: () => yes }) },
      }),
    };
  };
  const pointsOf = (report: c.AdequacyReport) =>
    report.borders.flatMap(border => border.points.map(point => [point.role, point.relation, point.status]));

  it("has no point at the bound of an invariant, and owes the rows the others do", async () => {
    const definition = c.behavior("coded", {
      input: c.variants("kind", { request: c.object({ code: c.string().refine(value => value.$uppercase().$lte("abc")) }) }),
      result: c.variants("outcome", { yes: c.object({}) }),
      effects: c.variants("type", {}),
    });
    const implementation = c.implement(definition, { cases: { request: c.model("yes", () => yes) } });
    const rows = c.examples(definition, { capital: { given: { kind: "request", code: "A" }, expect: yes } });
    const report = await c.check(c.spec("coded", { implementation, examples: rows }));
    expect(pointsOf(report)).toStrictEqual([
      ["ON", 'none: no value reads as "abc"', "no point"],
      ["OFF", "neighbour not named", "not named"],
      ["IN", '< "abc"', "met"],
      ["OUT", '> "abc"', "excluded"],
    ]);
    expect(report.verdict).toBe("satisfied");
    expect(c.generate(rows, implementation)).toStrictEqual({ rows: [], notComposed: [] });
  });

  it("reports an invariant equal to such a bound as admitting no value", async () => {
    const definition = coded(c.string().refine(value => value.$lowercase().$eq("ABC")));
    const implementation = c.implement(definition, { cases: { request: c.model("yes", () => yes) } });
    const report = await c.check(c.spec("coded", { implementation, examples: c.examples(definition, {}) }));
    expect(report.modelIssues).toStrictEqual([
      '@request.code: 不変条件を満たす値がありません (invariant lowercase($) == "ABC")',
    ]);
  });

  it("owes no row to the arm of a guard equal to such a bound", async () => {
    const { definition, implementation } = guarded(code => code.$lowercase().$eq("ABC"));
    const report = await c.check(
      c.spec("coded", { implementation, examples: c.examples(definition, { other: { given: { kind: "request", code: "xyz" }, expect: no } }) }),
    );
    expect(report.measures.arms).toStrictEqual({
      status: "complete",
      arms: [
        { decision: "guarded", guard: 'lowercase($.code) == "ABC"', arm: "holds", status: "no row owed", reason: "ガードの条件がこの値について両立しない" },
        { decision: "guarded", guard: 'lowercase($.code) == "ABC"', arm: "else", status: "met" },
      ],
    });
    expect(pointsOf(report)[0]).toStrictEqual(["ON", 'none: no value reads as "ABC"', "no point"]);
  });

  it("finds a value below the bound where stepping down reads above it", async () => {
    // "Ba" steps down to "B", which lowercases to "b", above "Ba"; "" lies below it.
    const { definition, implementation } = guarded(code => code.$lowercase().$lt("Ba"));
    const rows = c.examples(definition, { other: { given: { kind: "request", code: "x" }, expect: no } });
    const report = await c.check(c.spec("coded", { implementation, examples: rows }));
    expect(pointsOf(report)).toStrictEqual([
      ["ON", "neighbour not named", "not named"],
      ["OFF", 'none: no value reads as "Ba"', "no point"],
      ["IN", '< "Ba"', "gap"],
      ["OUT", '> "Ba"', "met"],
    ]);
    const below = c.generate(rows, implementation).rows.filter(row => row.name.includes('IN (< "Ba")'));
    expect(below.map(row => (row.given as { code: string }).code.toLowerCase() < "Ba")).toStrictEqual([true]);
  });

  it("leaves a range between two bounds undecided where it finds no value in it", async () => {
    // Every string from "A" to "Z" starts with an uppercase letter, which no
    // lowercased string holds, so the arm is no gap a row could fill.
    const { definition, implementation } = guarded(code => code.$lowercase().$gte("A").$and(code.$lowercase().$lte("Z")));
    const rows = c.examples(definition, {
      empty: { given: { kind: "request", code: "" }, expect: no },
      letters: { given: { kind: "request", code: "abc" }, expect: no },
    });
    const report = await c.check(c.spec("coded", { implementation, examples: rows }));
    expect(report.measures.arms.status === "complete" && report.measures.arms.arms.map(arm => arm.status)).toStrictEqual([
      "undecided",
      "met",
    ]);
  });
});

describe("a transformed comparison of an enum", () => {
  // No value of the enum lowercases to "high" and equals "Low".
  const levelled = c.behavior("levelled", {
    input: c.variants("kind", { request: c.object({ name: c.string(), level: c.enum(["Low", "High"]) }) }),
    result: c.variants("outcome", { low: c.object({}), high: c.object({}), named: c.object({}), unnamed: c.object({}) }),
    effects: c.variants("type", {}),
  });
  const answer = (outcome: "low" | "high" | "named" | "unnamed") => () => ({ result: { outcome }, effects: [] });
  const rows = c.examples(levelled, {
    low: { given: { kind: "request", name: "x", level: "Low" }, expect: answer("low")() },
    high: { given: { kind: "request", name: "x", level: "High" }, expect: answer("high")() },
  });
  const statuses = (report: c.AdequacyReport) =>
    report.measures.rules.status === "complete" ? report.measures.rules.rules.map(rule => rule.status) : [];

  it("is read off each of its values, so a way no value takes owes no row", async () => {
    const implementation = c.implement(levelled, {
      cases: {
        request: c.action("by level", {
          guards: request => [
            request.level.$lowercase().$eq("high").$else(answer("low")),
            request.level.$eq("Low").$else(answer("high")),
          ],
          run: answer("named"),
        }),
      },
    });
    const report = await c.check(c.spec("levelled", { implementation, examples: rows }));
    expect(statuses(report)).toStrictEqual(["met", "met"]);
    expect(report.measures.arms.status === "complete" && report.measures.arms.arms.map(arm => arm.status)).toStrictEqual([
      "met",
      "met",
      "no row owed",
      "met",
    ]);
    expect(c.generate(rows, implementation, { ways: true }).notComposed).toStrictEqual([]);
  });

  it("is settled with the value's own comparison where a guard reads something else too", async () => {
    // The length of a string is no finite value, so the ways are not read off combinations.
    const implementation = c.implement(levelled, {
      cases: {
        request: c.action("by level", {
          guards: request => [
            request.level.$lowercase().$eq("high").$else(answer("low")),
            request.level.$eq("Low").$else(answer("high")),
            request.name.$length().$gt(0).$else(answer("unnamed")),
          ],
          run: answer("named"),
        }),
      },
    });
    const report = await c.check(c.spec("levelled", { implementation, examples: rows }));
    expect(statuses(report)).toStrictEqual(["no row owed", "no row owed", "met", "met"]);
  });

  it("is placed as the values the transforms read as the way asks", () => {
    const request = selfTerm<{ level: "Low" | "High" | "Mid" }>();
    const scope = c.object({ level: c.enum(["Low", "High", "Mid"]) });
    const witnesses = witnessesOf({ steps: [{ distinction: request.level.$uppercase().$ne("HIGH") as CompareRule, outcome: true }] }, scope);
    expect([...witnesses!]).toStrictEqual([[{ path: ["level"], value: "Low" }], [{ path: ["level"], value: "Mid" }]]);
  });

  it("is read in an invariant relating finite positions", async () => {
    // Only a High level may come with other B, so no row takes B and Low.
    const related = c.behavior("related", {
      input: c.variants("kind", {
        request: c
          .object({ name: c.string(), level: c.enum(["Low", "High"]), other: c.enum(["A", "B"]) })
          .refine(request => request.level.$lowercase().$eq("high").$or(request.other.$eq("A"))),
      }),
      result: c.variants("outcome", { a: c.object({}), b: c.object({}), named: c.object({}), unnamed: c.object({}) }),
      effects: c.variants("type", {}),
    });
    const answer = (outcome: "a" | "b" | "named" | "unnamed") => () => ({ result: { outcome }, effects: [] });
    const implementation = c.implement(related, {
      cases: {
        request: c.action("related", {
          guards: request => [
            request.other.$eq("B").$else(answer("a")),
            request.level.$eq("Low").$else(answer("b")),
            request.name.$length().$gt(0).$else(answer("unnamed")),
          ],
          run: answer("named"),
        }),
      },
    });
    const report = await c.check(
      c.spec("related", {
        implementation,
        examples: c.examples(related, {
          a: { given: { kind: "request", name: "x", level: "Low", other: "A" }, expect: answer("a")() },
          b: { given: { kind: "request", name: "x", level: "High", other: "B" }, expect: answer("b")() },
        }),
      }),
    );
    expect(statuses(report)).toStrictEqual(["no row owed", "no row owed", "met", "met"]);
  });
});
