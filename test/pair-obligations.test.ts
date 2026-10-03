import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";
import { domainOf } from "../src/domain.js";

const flags = c.behavior("flags", { input: c.variants("type", { input: c.object({ a: c.boolean(), b: c.boolean() }) }), result: c.boolean(), effects: c.variants("type", {}) });
const implementation = c.implement(flags, { cases: { input: c.action("flags", { run: value => ({ result: value.a && value.b, effects: [] }) }) } });
const rows = c.examples(flags, {
  none: { given: { type: "input", a: false, b: false }, expect: { result: false, effects: [] } },
  both: { given: { type: "input", a: true, b: true }, expect: { result: true, effects: [] } },
});

describe("pair obligations", () => {
  it("fails adequacy when each class is covered but their realizable combinations are not", async () => {
    const report = await c.check(c.spec("flags", { examples: rows, implementation }));
    expect(report.partitions.every(partition => partition.kind !== "divided" || partition.missing.length === 0)).toBe(true);
    expect(report.measures.pairs.obligations.filter(pair => pair.status === "gap").map(pair => pair.classes)).toStrictEqual([["true", "false"], ["false", "true"]]);
    expect(report.adequate).toBe(false);
  });

  it("generates the missing pairs and does not generate them again while answers are owed", () => {
    const generated = c.generate(rows, implementation);
    expect(generated.rows.map(row => row.given)).toContainEqual({ type: "input", a: true, b: false });
    expect(generated.rows.map(row => row.given)).toContainEqual({ type: "input", a: false, b: true });
    const pending = c.examples(flags, Object.fromEntries([...rows.rows.map(row => [row.name, row]), ...generated.rows.map(row => [row.name, { given: row.given as c.BehaviorInput<typeof flags>, expect: c.todo(row.reason) }])]));
    expect(c.generate(pending, implementation).rows).toStrictEqual([]);
  });

  it("proves a finite impossible pair is not owed", async () => {
    const equal = c.behavior("equal", { result: c.boolean(), effects: c.variants("type", {}), input: c.variants("type", { input: c.object({ a: c.boolean(), b: c.boolean() }).refine(v => v.a.$eq(v.b)) }) });
    const report = await c.check(c.spec("equal", { examples: c.examples(equal, {}) }));
    expect(report.measures.pairs.obligations.filter(pair => pair.status === "no row owed").map(pair => pair.classes)).toStrictEqual([["true", "false"], ["false", "true"]]);
  });

  it("reports an obligation limit rather than silently dropping combinations", async () => {
    const report = await c.check(c.spec("flags", { examples: rows, implementation }), { pairs: { obligations: 1 } });
    expect(report.measures.pairs.status).toBe("partial");
    expect(report.measures.pairs.notRead).toHaveLength(1);
  });

  it("does not equate a failed candidate search with an impossibility proof", () => {
    const schema = c.object({ a: c.int(), b: c.boolean() }).refine(v => v.a.$gt(1000000));
    expect(domainOf(schema, 1).exhaustive).toBe(false);
  });

  it("enumerates a bounded integer domain and rejects correlated values", () => {
    const schema = c.object({ a: c.int().min(1).max(3), b: c.boolean() }).refine(v => v.a.$eq(2).$or(v.b.$eq(true)));
    const domain = domainOf(schema, 100);
    expect(domain.exhaustive).toBe(true);
    expect(domain.values).toHaveLength(4);
  });
});

it("does not combine classes from different elements of one collection", async () => {
  const item = c.object({ a: c.boolean(), b: c.boolean() }).refine(value => value.a.$eq(value.b));
  const definition = c.behavior("items", { input: c.variants("kind", { input: c.object({ items: c.array(item).length(2) }) }), result: c.boolean(), effects: c.variants("kind", {}) });
  const examples = c.examples(definition, { mixed: { given: { kind: "input", items: [{ a: false, b: false }, { a: true, b: true }] }, expect: { result: true, effects: [] } } });
  const report = await c.check(c.spec("items", { examples }));
  const cross = report.measures.pairs.obligations.filter(pair => pair.classes[0] !== pair.classes[1]);
  expect(cross.map(pair => pair.status)).toStrictEqual(["no row owed", "no row owed"]);
});
