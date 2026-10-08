// Strict deep equality, as Node's `util.isDeepStrictEqual` decides it:
// primitives by `Object.is`, then objects of one prototype and one tag by their
// own enumerable keys, arrays with their holes, dates by time, regular
// expressions by source, flags and index, boxed primitives by value, URLs by
// text, errors by message, name, cause and errors, typed arrays and array
// buffers by byte, maps and sets regardless of order, and weak maps, weak sets
// and promises only when they are the same one. It needs no Node module, so the
// runtime runs where only Web APIs exist.
//
// Not only schema-read values reach it: a fake table's rows are compared as
// written, and with the value a handler asks, before any schema reads them, so
// a URL there is a value of `{ href: string }`.
//
// Unlike Node, it compares Temporal values by what they hold: they keep it in
// internal slots, no own key, so `isDeepStrictEqual` took every two dates as
// equal and an example expecting the wrong date passed. It also takes two
// objects of different prototypes as different where Node, finding one
// constructor, takes them as equal.
export function deepEqual(left: unknown, right: unknown): boolean {
  return equal(left, right, { left: new Map(), right: new Map() });
}

// The objects being compared on the path from the root, each side's mapped to
// the depth it was entered at. A pair leaves it once compared, so a candidate
// tried and refused while matching sets and maps is not later taken as equal.
type Seen = { left: Map<object, number>; right: Map<object, number> };

function equal(left: unknown, right: unknown, seen: Seen): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  const tag = Object.prototype.toString.call(left);
  if (tag !== Object.prototype.toString.call(right)) return false;
  // Met again on the path, as Node decides it: a cycle holds when both sides
  // close it at the same depth and the rest is equal.
  const leftDepth = seen.left.get(left);
  const rightDepth = seen.right.get(right);
  if (leftDepth !== undefined || rightDepth !== undefined) return leftDepth === rightDepth;
  seen.left.set(left, seen.left.size);
  seen.right.set(right, seen.right.size);
  try {
    return contentsEqual(left, right, seen);
  } finally {
    seen.left.delete(left);
    seen.right.delete(right);
  }
}

// What a built-in's own method reads of a value, or `none` where the value lacks
// the internal slot it reads: a built-in is told by that slot, as Node tells
// it, not by its prototype, so one of another realm is read and an object that
// only inherits a built-in's prototype (`Object.create(Date.prototype)`) is not
// read as one. Its tag picks the method, so a plain object costs no throw.
const none = Symbol("none");
function slot(read: (this: unknown) => unknown, value: object): unknown {
  try {
    return read.call(value);
  } catch {
    return none;
  }
}
const getter = (prototype: object, key: string) =>
  Object.getOwnPropertyDescriptor(prototype, key)!.get as (this: unknown) => unknown;
// Methods answering a primitive that must be equal, by tag.
const readers: Readonly<Record<string, (this: unknown) => unknown>> = {
  "[object Date]": Date.prototype.getTime,
  "[object RegExp]": function (this: unknown) {
    const source = getter(RegExp.prototype, "source").call(this);
    const pattern = this as RegExp;
    return `${pattern.lastIndex}/${pattern.flags}/${source as string}`;
  },
  "[object Number]": Number.prototype.valueOf,
  "[object String]": String.prototype.valueOf,
  "[object Boolean]": Boolean.prototype.valueOf,
  "[object BigInt]": BigInt.prototype.valueOf,
  "[object Symbol]": Symbol.prototype.valueOf,
  ...(typeof URL === "undefined" ? {} : { "[object URL]": getter(URL.prototype, "href") }),
};
const weak: Readonly<Record<string, (this: unknown) => unknown>> = {
  "[object WeakMap]": function (this: unknown) { return WeakMap.prototype.has.call(this as WeakMap<object, unknown>, {}); },
  "[object WeakSet]": function (this: unknown) { return WeakSet.prototype.has.call(this as WeakSet<object>, {}); },
};
const buffers: Readonly<Record<string, (this: unknown) => unknown>> = {
  "[object ArrayBuffer]": getter(ArrayBuffer.prototype, "byteLength"),
  ...(typeof SharedArrayBuffer === "undefined" ? {} : { "[object SharedArrayBuffer]": getter(SharedArrayBuffer.prototype, "byteLength") }),
};

function contentsEqual(left: object, right: object, seen: Seen): boolean {
  const tag = Object.prototype.toString.call(left);
  // Its string names the value with its calendar and time zone, as `equals` compares them.
  const text = function (this: unknown) { return String(this); };
  if (tag.startsWith("[object Temporal.") && slot(text, left) !== slot(text, right)) return false;
  const read = readers[tag];
  if (read !== undefined && !Object.is(slot(read, left), slot(read, right))) return false;
  // What they hold cannot be read, so only the same one is equal.
  if (tag === "[object Promise]" || (weak[tag] !== undefined && slot(weak[tag], left) !== none)) return false;
  if (tag === "[object Error]") {
    const [a, b] = [left as Error & { errors?: unknown }, right as Error & { errors?: unknown }];
    if (a.message !== b.message || a.name !== b.name) return false;
    for (const key of ["cause", "errors"] as const) {
      if (Object.hasOwn(a, key) !== Object.hasOwn(b, key) || (Object.hasOwn(a, key) && !equal(a[key], b[key], seen))) return false;
    }
  }
  if (ArrayBuffer.isView(left)) {
    const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const b = new Uint8Array((right as ArrayBufferView).buffer, (right as ArrayBufferView).byteOffset, (right as ArrayBufferView).byteLength);
    if (a.length !== b.length || a.some((byte, i) => byte !== b[i])) return false;
  }
  if (buffers[tag] !== undefined && slot(buffers[tag], left) !== none) {
    const a = new Uint8Array(left as ArrayBufferLike);
    const b = new Uint8Array(right as ArrayBufferLike);
    if (a.length !== b.length || a.some((byte, i) => byte !== b[i])) return false;
  }
  if (tag === "[object Map]" || tag === "[object Set]") {
    const size = getter(tag === "[object Map]" ? Map.prototype : Set.prototype, "size");
    const [a, b] = [slot(size, left) !== none, slot(size, right) !== none];
    if (a !== b) return false;
    if (a && !(tag === "[object Map]"
      ? mapsEqual(left as Map<unknown, unknown>, right as Map<unknown, unknown>, seen)
      : setsEqual(left as Set<unknown>, right as Set<unknown>, seen))) return false;
  }
  if (Array.isArray(left) && left.length !== (right as unknown[]).length) return false;

  const keys = ownEnumerableKeys(left);
  const others = ownEnumerableKeys(right);
  if (keys.length !== others.length) return false;
  const otherKeys = new Set(others);
  return keys.every(key =>
    otherKeys.has(key) &&
    equal((left as Record<PropertyKey, unknown>)[key], (right as Record<PropertyKey, unknown>)[key], seen));
}

// The keys `isDeepStrictEqual` reads: own enumerable string keys (an array's
// indexes among them, so a hole differs from `undefined`) and own enumerable
// symbols. A typed array's indexes were compared as bytes above.
function ownEnumerableKeys(value: object): PropertyKey[] {
  const keys = Reflect.ownKeys(value).filter(key => Object.prototype.propertyIsEnumerable.call(value, key));
  return ArrayBuffer.isView(value) ? keys.filter(key => typeof key === "symbol" || !/^\d+$/.test(key)) : keys;
}

// A primitive is found by `has`; an object is matched with a right one left
// over, itself included, so no right object stands for two.
function setsEqual(left: Set<unknown>, right: Set<unknown>, seen: Seen): boolean {
  if (left.size !== right.size) return false;
  const unmatched = [...right].filter(isObject);
  for (const item of left) {
    if (!isObject(item)) {
      if (!right.has(item)) return false;
      continue;
    }
    const index = unmatched.findIndex(other => equal(item, other, seen));
    if (index === -1) return false;
    unmatched.splice(index, 1);
  }
  return true;
}

// An object key is matched with any right entry left over whose key and value
// are equal, not only the entry of the same key: two equal keys may hold their
// values crossed.
function mapsEqual(left: Map<unknown, unknown>, right: Map<unknown, unknown>, seen: Seen): boolean {
  if (left.size !== right.size) return false;
  const unmatched = [...right].filter(([key]) => isObject(key));
  for (const [key, value] of left) {
    if (!isObject(key)) {
      if (!right.has(key) || !equal(value, right.get(key), seen)) return false;
      continue;
    }
    const index = unmatched.findIndex(([other, otherValue]) => equal(key, other, seen) && equal(value, otherValue, seen));
    if (index === -1) return false;
    unmatched.splice(index, 1);
  }
  return true;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
