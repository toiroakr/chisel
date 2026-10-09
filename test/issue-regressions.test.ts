import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

describe("issue regressions", () => {
  it("checks a decimal with numeric lower and upper bounds (#53)", async () => {
    const price = c.behavior("price", {
      input: c.variants("kind", { set: c.object({ amount: c.decimal(2).min(0 as never).max(10 as never) }) }),
      result: c.variants("outcome", { ok: c.object({}) }),
      effects: c.variants("type", {}),
    });
    await expect(c.check(c.spec("price", { examples: c.examples(price, {}) }))).resolves.toBeDefined();
    expect(c.generate(c.examples(price, {}))).toHaveProperty("rows");
  });

  it.each(["$eq", "$ne", "$gte"] as const)("checks an omitted optional string with %s (#54)", async method => {
    const note = c.behavior("note", {
      input: c.variants("kind", { go: c.object({ note: c.string().optional() }) }),
      result: c.variants("outcome", { a: c.object({}), b: c.object({}) }),
      effects: c.variants("type", {}),
    });
    const implementation = c.implement(note, {
      cases: { go: c.action("go", {
        guards: r => [r.note[method]("ab").$else(() => ({ result: { outcome: "b" as const }, effects: [] }))],
        run: () => ({ result: { outcome: "a" as const }, effects: [] }),
      }) },
    });
    const rows = c.examples(note, { left: { given: { kind: "go" }, expect: { result: { outcome: "b" }, effects: [] } } });
    const specification = c.spec("note", { examples: rows, implementation });
    await expect(c.check(specification)).resolves.toBeDefined();
    expect(c.generate(rows, implementation)).toHaveProperty("rows");
  });

  it.each(["+275760-09-13", "-271821-04-19"])("checks a date bound at %s (#55)", async text => {
    const at = Temporal.PlainDate.from(text);
    const bounded = text.startsWith("+") ? c.date().max(at) : c.date().min(at);
    const definition = c.behavior("date bound", {
      input: c.variants("kind", { go: c.object({ at: bounded }) }),
      result: c.variants("outcome", { ok: c.object({}) }),
      effects: c.variants("type", {}),
    });
    const report = await c.check(c.spec("date bound", { examples: c.examples(definition, {}) }));
    expect(report.borders[0]!.points.find(point => point.role === "OFF")!.status).toBe("no point");
  });

  it.each([
    ["+275760-09-13T12:00", "+275760-09-13T13:00"],
    ["+275760-09-13T23:59:59.999999999", "+275760-09-13T23:59:59.999999999"],
    ["-271821-04-19T00:00:00.000000001", "-271821-04-19T00:00:00.000000001"],
  ])("checks a date-time relation at %s (#55)", async (at, to) => {
    const definition = c.behavior("date-time relation", {
      input: c.variants("kind", { go: c.object({ at: c.datetime(), to: c.datetime() }) }),
      result: c.variants("outcome", { yes: c.object({}), no: c.object({}) }),
      effects: c.variants("type", {}),
    });
    const implementation = c.implement(definition, { cases: { go: c.action("compare", {
      guards: r => [r.at.$lte(r.to).$else(() => ({ result: { outcome: "no" as const }, effects: [] }))],
      run: () => ({ result: { outcome: "yes" as const }, effects: [] }),
    }) } });
    const rows = c.examples(definition, { edge: {
      given: { kind: "go", at: Temporal.PlainDateTime.from(at), to: Temporal.PlainDateTime.from(to) },
      expect: { result: { outcome: "yes" }, effects: [] },
    } });
    await expect(c.check(c.spec("date-time relation", { examples: rows, implementation }))).resolves.toBeDefined();
    expect(c.generate(rows, implementation)).toHaveProperty("rows");
  });

  it("leaves a date result against a date-time bound unproved (#56)", () => {
    const pass = c.behavior("pass", {
      input: c.variants("kind", { go: c.object({ at: c.date().max(Temporal.PlainDate.from("2000-12-31")) }) }),
      result: c.variants("outcome", { ok: c.object({ at: c.date().refine(v => v.$lt(Temporal.PlainDateTime.from("2000-12-31T12:00") as never)) }) }),
      effects: c.variants("type", {}),
      requires: { n: c.dependency(c.object({}), c.object({ n: c.int().min(0).max(1) })) },
    });
    const implementation = c.implement(pass, { cases: { go: c.model("pass", (given, deps) =>
      c.bind<{ n: number }, c.Execution<c.Infer<typeof pass.result>, never>>(c.object({ n: c.int().min(0).max(1) }), c.call(deps.n, {}), () =>
        ({ result: { outcome: "ok" as const, at: given.at }, effects: [] }))) } });
    expect(c.verify(implementation).status).toBe("undetermined");
  });

  it.each(["5", 5n, new c.Rational(5n)])("leaves an integer result against %s unproved (#57)", bound => {
    const inc = c.behavior("inc", {
      input: c.variants("kind", { go: c.object({ x: c.int().min(0).max(3) }) }),
      result: c.variants("outcome", { ok: c.object({ v: c.int().refine(v => v.$lte(bound as never)) }) }),
      effects: c.variants("type", {}),
      requires: { n: c.dependency(c.object({}), c.object({ n: c.int().min(0).max(1) })) },
    });
    const implementation = c.implement(inc, { cases: { go: c.model("inc", (given, deps) =>
      c.bind<{ n: number }, c.Execution<c.Infer<typeof inc.result>, never>>(c.object({ n: c.int().min(0).max(1) }), c.call(deps.n, {}), () =>
        ({ result: { outcome: "ok" as const, v: c.arithmetic("add", given.x, 1) }, effects: [] }))) } });
    expect(c.verify(implementation).status).toBe("undetermined");
  });
});
