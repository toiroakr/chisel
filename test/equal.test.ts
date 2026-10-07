import { Decimal } from "decimal.js";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { deepEqual } from "../src/equal.js";
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
const [k1, k2, x, y, z] = [{ a: 1 }, { a: 1 }, { a: 1 }, { a: 1 }, { a: 2 }];
// Matching the sets tries `one` against `two` first and refuses it; the pair
// compared again after the sets must still differ.
const [one, two, otherTwo, otherOne] = [{ v: 1 }, { v: 2 }, { v: 2 }, { v: 1 }];
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
  ["equal decimals", new Decimal("1.50"), new Decimal("1.5")],
  ["different decimals", new Decimal(1), new Decimal(2)],
  ["rationals", new Rational(1n, 3n), new Rational(2n, 6n)],
  ["temporal dates", Temporal.PlainDate.from("2020-01-01"), Temporal.PlainDate.from("2020-01-01")],
  ["cycles", cycle(), cycle()],
  ["cycles of different length", loop(1), loop(2)],
  ["a pair refused while matching a set", [new Set([one, two]), one], [new Set([otherTwo, otherOne]), otherTwo]],
  ["a pair refused while matching a map", [new Map([[one, 0], [two, 0]]), one], [new Map([[otherTwo, 0], [otherOne, 0]]), otherTwo]],
];

describe("deepEqual", () => {
  it.each(pairs)("agrees with isDeepStrictEqual on %s", (_, left, right) => {
    expect(deepEqual(left, right)).toBe(isDeepStrictEqual(left, right));
    expect(deepEqual(right, left)).toBe(isDeepStrictEqual(right, left));
  });
});
