import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { describeRule, holds, satisfy, selfTerm } from "../src/rule.js";

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

  it("names a point no value reads back as, rather than offering a row away from it", () => {
    const definition = coded(c.string());
    const implementation = guarded(definition, code => code.$lowercase().$eq("ABC"));
    const rows = c.examples(definition, { other: { given: { kind: "request", code: "xyz" }, expect: { result: { outcome: "no" as const }, effects: [] } } });
    const generated = c.generate(rows, implementation);
    expect(generated.rows.filter(row => row.name.includes('ON (= "ABC")'))).toStrictEqual([]);
    expect(generated.notComposed.some(label => label.includes('ON (= "ABC")'))).toBe(true);
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
