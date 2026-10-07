// Strict deep equality, as Node's `util.isDeepStrictEqual` decides it for the
// values Chisel compares: primitives by `Object.is`, then objects of one
// prototype and one tag by their own enumerable keys, arrays with their holes,
// dates by time, regular expressions by source and flags, boxed primitives by
// value, typed arrays and array buffers by byte, and maps and sets regardless of order. It
// needs no Node module, so the runtime runs where only Web APIs exist.
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

function contentsEqual(left: object, right: object, seen: Seen): boolean {
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
  if (left instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && left instanceof SharedArrayBuffer)) {
    const a = new Uint8Array(left);
    const b = new Uint8Array(right as ArrayBufferLike);
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
