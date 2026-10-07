// Strict deep equality, as Node's `util.isDeepStrictEqual` decides it for the
// values Chisel compares: primitives by `Object.is`, then objects of one
// prototype and one tag by their own enumerable keys, arrays with their holes,
// dates by time, regular expressions by source and flags, boxed primitives by
// value, typed arrays by element, and maps and sets regardless of order. It
// needs no Node module, so the runtime runs where only Web APIs exist.
export function deepEqual(left: unknown, right: unknown): boolean {
  return equal(left, right, new Map());
}

type Seen = Map<object, Set<object>>;

function equal(left: unknown, right: unknown, seen: Seen): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  const tag = Object.prototype.toString.call(left);
  if (tag !== Object.prototype.toString.call(right)) return false;
  // A pair already being compared is assumed equal; a cycle holds when the rest does.
  const pairs = seen.get(left);
  if (pairs?.has(right)) return true;
  if (pairs) pairs.add(right);
  else seen.set(left, new Set([right]));

  if (left instanceof Date && !Object.is(left.getTime(), (right as Date).getTime())) return false;
  if (left instanceof RegExp) {
    const other = right as RegExp;
    if (left.source !== other.source || left.flags !== other.flags || left.lastIndex !== other.lastIndex) return false;
  }
  if (left instanceof Error) {
    const other = right as Error;
    if (left.message !== other.message || left.name !== other.name) return false;
  }
  for (const box of [Number, String, Boolean, BigInt, Symbol] as const) {
    if (left instanceof box && !Object.is(left.valueOf(), (right as typeof left).valueOf())) return false;
  }
  if (ArrayBuffer.isView(left)) {
    const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const b = new Uint8Array((right as ArrayBufferView).buffer, (right as ArrayBufferView).byteOffset, (right as ArrayBufferView).byteLength);
    if (a.length !== b.length || a.some((byte, i) => byte !== b[i])) return false;
  }
  if (left instanceof Map && !mapsEqual(left, right as Map<unknown, unknown>, seen)) return false;
  if (left instanceof Set && !setsEqual(left, right as Set<unknown>, seen)) return false;
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

function setsEqual(left: Set<unknown>, right: Set<unknown>, seen: Seen): boolean {
  if (left.size !== right.size) return false;
  const unmatched = [...right].filter(item => typeof item === "object" && item !== null);
  for (const item of left) {
    if (right.has(item)) continue;
    if (typeof item !== "object" || item === null) return false;
    const index = unmatched.findIndex(other => equal(item, other, seen));
    if (index === -1) return false;
    unmatched.splice(index, 1);
  }
  return true;
}

function mapsEqual(left: Map<unknown, unknown>, right: Map<unknown, unknown>, seen: Seen): boolean {
  if (left.size !== right.size) return false;
  const unmatched = [...right].filter(([key]) => typeof key === "object" && key !== null);
  for (const [key, value] of left) {
    if (right.has(key)) {
      if (!equal(value, right.get(key), seen)) return false;
      continue;
    }
    if (typeof key !== "object" || key === null) return false;
    const index = unmatched.findIndex(([other, otherValue]) => equal(key, other, seen) && equal(value, otherValue, seen));
    if (index === -1) return false;
    unmatched.splice(index, 1);
  }
  return true;
}
