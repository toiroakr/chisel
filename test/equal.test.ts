import { Decimal } from "decimal.js";
import { isDeepStrictEqual } from "node:util";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { deepEqual } from "../src/equal.js";
import { behavior, check, date, dependency, examples, fake, implement, int, object, spec, string, test, variants } from "../src/index.js";
import { Rational } from "../src/exact.js";

const cycle = () => {
  const node: { next?: unknown; value: number } = { value: 1 };
  node.next = node;
  return node;
};
// A loop of `length` nodes, each pointing at the next.
const loop = (length: number) => {
  const first: { next?: unknown } = {};
  let last = first;
  for (let i = 1; i < length; i++) last = last.next = {};
  last.next = first;
  return first;
};
const symbol = Symbol("key");
const bytes = (...values: number[]) => new Uint8Array(values).buffer;
const shared = (value: number) => {
  const buffer = new SharedArrayBuffer(1);
  new Uint8Array(buffer)[0] = value;
  return buffer;
};
// Two views of one buffer at different offsets: bytes 1, 2 at 0 and at 4, 2, 3 at 1.
const offsets = new Uint8Array([1, 2, 3, 4, 1, 2]).buffer;
const [k1, k2, x, y, z] = [{ a: 1 }, { a: 1 }, { a: 1 }, { a: 1 }, { a: 2 }];
// Matching the sets tries `one` against `two` first and refuses it; the pair
// compared again after the sets must still differ.
const [one, two, otherTwo, otherOne] = [{ v: 1 }, { v: 2 }, { v: 2 }, { v: 1 }];
// Values of another realm, as an iframe or a vm context makes them.
const realm = createContext({});
const foreign = (source: string): unknown => runInContext(source, realm);
const pairs: [string, unknown, unknown][] = [
  ["equal numbers", 1, 1],
  ["NaN", Number.NaN, Number.NaN],
  ["0 and -0", 0, -0],
  ["number and string", 1, "1"],
  ["null and undefined", null, undefined],
  ["equal objects", { a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }],
  ["a missing key and an undefined one", { note: undefined }, {}],
  ["different values", { a: 1 }, { a: 2 }],
  ["arrays of different length", [1, 2], [1, 2, 3]],
  ["a hole and undefined", [1, , 3], [1, undefined, 3]], // eslint-disable-line no-sparse-arrays
  ["an array and an object", [1], { 0: 1 }],
  ["a null prototype", Object.assign(Object.create(null), { a: 1 }), { a: 1 }],
  ["equal dates", new Date(0), new Date(0)],
  ["different dates", new Date(0), new Date(1)],
  ["regular expressions", /a/g, /a/g],
  ["different flags", /a/g, /a/i],
  ["boxed numbers", new Number(1), new Number(2)],
  ["typed arrays", new Uint8Array([1, 2]), new Uint8Array([1, 2])],
  ["different typed arrays", new Uint8Array([1, 2]), new Uint8Array([1, 3])],
  ["array buffers", bytes(1, 2), bytes(1, 2)],
  ["different array buffers", bytes(1), bytes(2)],
  ["different shared array buffers", shared(0), shared(1)],
  ["sets in another order", new Set([1, { a: 1 }]), new Set([{ a: 1 }, 1])],
  ["different sets", new Set([{ a: 1 }]), new Set([{ a: 2 }])],
  ["maps", new Map([["a", { b: 1 }]]), new Map([["a", { b: 1 }]])],
  ["maps keyed by objects", new Map([[{ k: 1 }, 1]]), new Map([[{ k: 1 }, 1]])],
  ["a set reusing an identical item", new Set([x, y]), new Set([x, z])],
  ["equal map keys holding crossed values", new Map([[k1, 1], [k2, 2]]), new Map([[k1, 2], [k2, 1]])],
  ["a map reusing an identical key", new Map([[x, 1], [y, 1]]), new Map([[x, 1], [z, 1]])],
  ["different map values", new Map([["a", 1]]), new Map([["a", 2]])],
  ["symbol keys", { [symbol]: 1 }, { [symbol]: 2 }],
  ["errors", new Error("a"), new Error("b")],
  ["equal errors", new Error("a"), new Error("a")],
  ["errors of different names", Object.defineProperty(new Error("a"), "name", { value: "Refused" }), new Error("a")],
  ["errors holding different keys", Object.assign(new Error("a"), { code: 1 }), Object.assign(new Error("a"), { code: 2 })],
  ["regular expressions at different indexes", Object.assign(/a/g, { lastIndex: 1 }), /a/g],
  ["different patterns", /a/, /b/],
  ["equal boxed strings", new String("a"), new String("a")],
  ["boxed strings", new String("a"), new String("b")],
  ["boxed booleans", new Boolean(true), new Boolean(false)],
  ["boxed bigints", Object(1n), Object(2n)],
  ["boxed symbols", Object(Symbol.iterator), Object(Symbol.asyncIterator)],
  ["boxed zeros", new Number(0), new Number(-0)],
  ["a boxed and a bare number", new Number(1), 1],
  ["boxed strings holding different keys", Object.assign(new String("a"), { x: 1 }), new String("a")],
  ["typed arrays of different types", new Uint8Array([1]), new Int8Array([1])],
  ["float zeros", new Float64Array([0]), new Float64Array([-0])],
  ["views at different offsets holding the same bytes", new Uint8Array(offsets, 0, 2), new Uint8Array(offsets, 4, 2)],
  ["views at different offsets", new Uint8Array(offsets, 0, 2), new Uint8Array(offsets, 1, 2)],
  ["data views holding the same bytes", new DataView(offsets, 0, 2), new DataView(offsets, 4, 2)],
  ["different data views", new DataView(offsets, 0, 2), new DataView(offsets, 2, 2)],
  ["typed arrays holding different keys", Object.assign(new Uint8Array([1]), { x: 1 }), new Uint8Array([1])],
  ["typed arrays holding different symbols", Object.assign(new Uint8Array([1]), { [symbol]: 1 }), new Uint8Array([1])],
  ["dates holding different keys", Object.assign(new Date(0), { x: 1 }), new Date(0)],
  ["invalid dates", new Date(Number.NaN), new Date(Number.NaN)],
  ["a non-enumerable symbol", Object.defineProperty({}, symbol, { value: 1, enumerable: false }), {}],
  ["two symbols of one description", { [Symbol("a")]: 1 }, { [Symbol("a")]: 1 }],
  ["equal decimals", new Decimal("1.50"), new Decimal("1.5")],
  ["different decimals", new Decimal(1), new Decimal(2)],
  ["rationals", new Rational(1n, 3n), new Rational(2n, 6n)],
  ["temporal dates", Temporal.PlainDate.from("2020-01-01"), Temporal.PlainDate.from("2020-01-01")],
  ["cycles", cycle(), cycle()],
  ["cycles of different length", loop(1), loop(2)],
  ["a pair refused while matching a set", [new Set([one, two]), one], [new Set([otherTwo, otherOne]), otherTwo]],
  ["urls", new URL("http://a/"), new URL("http://a")],
  ["different urls", new URL("http://a/"), new URL("http://b/")],
  ["errors of different causes", new Error("a", { cause: 1 }), new Error("a", { cause: 2 })],
  ["errors of equal causes", new Error("a", { cause: { b: 1 } }), new Error("a", { cause: { b: 1 } })],
  ["an error with a cause and one without", new Error("a", { cause: undefined }), new Error("a")],
  ["aggregate errors of different errors", new AggregateError([1], "a"), new AggregateError([2], "a")],
  ["weak maps", new WeakMap(), new WeakMap()],
  ["weak sets", new WeakSet(), new WeakSet()],
  ["promises", Promise.resolve(1), Promise.resolve(1)],
  ["dates of another realm", foreign("new Date(0)"), foreign("new Date(1)")],
  ["maps of another realm", foreign("new Map([[1, 1]])"), foreign("new Map([[1, 2]])")],
  ["sets of another realm", foreign("new Set([1])"), foreign("new Set([2])")],
  ["patterns of another realm", foreign("/a/"), foreign("/b/")],
  ["errors of another realm", foreign("new Error('a')"), foreign("new Error('b')")],
  ["boxed numbers of another realm", foreign("new Number(1)"), foreign("new Number(2)")],
  ["array buffers of another realm", foreign("new Uint8Array([1]).buffer"), foreign("new Uint8Array([2]).buffer")],
  ["objects inheriting a date's prototype", Object.create(Date.prototype), Object.create(Date.prototype)],
  ["objects inheriting a map's prototype", Object.create(Map.prototype), Object.create(Map.prototype)],
  ["a map and an object inheriting its prototype", new Map(), Object.create(Map.prototype)],
  ["a date and an object inheriting its prototype", new Date(0), Object.create(Date.prototype)],
  ["objects inheriting a set's prototype", Object.create(Set.prototype), Object.create(Set.prototype)],
  ["objects inheriting a number's prototype", Object.create(Number.prototype), Object.create(Number.prototype)],
  ["objects inheriting a pattern's prototype", Object.create(RegExp.prototype), Object.create(RegExp.prototype)],
  ["objects inheriting an array buffer's prototype", Object.create(ArrayBuffer.prototype), Object.create(ArrayBuffer.prototype)],
  ["a pair refused while matching a map", [new Map([[one, 0], [two, 0]]), one], [new Map([[otherTwo, 0], [otherOne, 0]]), otherTwo]],
];

describe("deepEqual", () => {
  it.each(pairs)("agrees with isDeepStrictEqual on %s", (_, left, right) => {
    expect(deepEqual(left, right)).toBe(isDeepStrictEqual(left, right));
    expect(deepEqual(right, left)).toBe(isDeepStrictEqual(right, left));
  });

  // isDeepStrictEqual reads no own key of a Temporal value, so it takes any two as equal.
  it.each([
    ["dates", Temporal.PlainDate.from("2020-01-01"), Temporal.PlainDate.from("2099-12-31")],
    ["times", Temporal.PlainTime.from("09:00"), Temporal.PlainTime.from("09:00:00.000000001")],
    ["date-times", Temporal.PlainDateTime.from("2020-01-01T00:00"), Temporal.PlainDateTime.from("2020-01-02T00:00")],
    ["instants", Temporal.Instant.from("2020-01-01T00:00Z"), Temporal.Instant.from("2020-01-02T00:00Z")],
    ["calendars", Temporal.PlainDate.from("2020-01-01"), Temporal.PlainDate.from("2020-01-01").withCalendar("japanese")],
  ])("tells different temporal %s apart", (_, left, right) => {
    expect(deepEqual(left, right)).toBe(false);
    expect(deepEqual(left, Temporal[left.constructor.name as "PlainDate"].from(String(left)))).toBe(true);
  });

  it("fails an example expecting another date than the model answers", async () => {
    const due = behavior("due", {
      input: variants("kind", { given: object({ at: date() }) }),
      result: variants("outcome", { ok: object({ due: date() }) }),
      effects: variants("type", {}),
    });
    const rows = examples(due, {
      wrong: {
        given: { kind: "given", at: Temporal.PlainDate.from("2020-01-01") },
        expect: { result: { outcome: "ok", due: Temporal.PlainDate.from("2099-12-31") }, effects: [] },
      },
    });
    const { failures } = await test(rows, async given => ({ result: { outcome: "ok" as const, due: given.at }, effects: [] }));
    expect(failures.map(failure => failure.name)).toStrictEqual(["wrong"]);
  });

  // A fake row is compared as written, before any schema reads it, and a URL
  // is a value of `{ href: string }`: two of them must not stand for one.
  it("answers a fake row keyed by a URL with its own answer", async () => {
    const fetches = behavior("fetches", {
      input: variants("kind", { asked: object({ to: string() }) }),
      result: variants("outcome", { ok: object({ status: int() }) }),
      effects: variants("type", {}),
      requires: { fetch: dependency(object({ href: string() }), int()) },
    });
    const report = await check(spec("fetches", {
      examples: examples(fetches, {
        b: { given: { kind: "asked", to: "http://b/" }, expect: { result: { outcome: "ok", status: 2 }, effects: [] } },
      }),
      implementation: implement(fetches, {
        cases: {
          asked: { kind: "decision", id: "fetch", run: (given, deps) => ({ result: { outcome: "ok", status: deps.fetch(new URL(given.to)) }, effects: [] }) },
        },
        controls: {},
      }),
      fakes: [fake(fetches, "fetch", [[new URL("http://a/"), 1], [new URL("http://b/"), 2]])],
    }));
    expect([report.fakeIssues, report.failures]).toStrictEqual([[], []]);
  });
});
