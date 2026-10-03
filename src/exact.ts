import { Decimal } from "decimal.js";
export class EvaluationLimit extends Error {
  constructor(message: string) { super(message); this.name = "EvaluationLimit"; }
}

export class Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
  constructor(numerator: bigint | string, denominator = 1n) {
    if (typeof numerator === "string") {
      const match = /^([+-]?\d+)(?:\/(\d+))?$/.exec(numerator);
      if (!match) throw new Error("Expected an integer or numerator/denominator");
      denominator *= BigInt(match[2] ?? "1");
      numerator = BigInt(match[1]!);
    }
    if (denominator === 0n) throw new Error("Rational denominator must be nonzero");
    const sign = denominator < 0n ? -1n : 1n;
    const divisor = gcd(numerator, denominator);
    this.numerator = sign * numerator / divisor;
    this.denominator = sign * denominator / divisor;
    Object.freeze(this);
  }
  plus(other: Rational): Rational { return new Rational(this.numerator * other.denominator + other.numerator * this.denominator, this.denominator * other.denominator); }
  minus(other: Rational): Rational { return this.plus(new Rational(-other.numerator, other.denominator)); }
  times(other: Rational): Rational { return new Rational(this.numerator * other.numerator, this.denominator * other.denominator); }
  dividedBy(other: Rational): Rational { return new Rational(this.numerator * other.denominator, this.denominator * other.numerator); }
  comparedTo(other: Rational): number {
    const difference = this.numerator * other.denominator - other.numerator * this.denominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }
  toString(): string { return this.denominator === 1n ? String(this.numerator) : `${this.numerator}/${this.denominator}`; }
  toJSON(): string { return this.toString(); }
}
function gcd(left: bigint, right: bigint): bigint {
  left = left < 0n ? -left : left;
  right = right < 0n ? -right : right;
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}
export function isRational(value: unknown): value is Rational {
  return typeof value === "object" && value !== null && value.constructor?.name === "Rational" &&
    typeof (value as Rational).numerator === "bigint" && typeof (value as Rational).denominator === "bigint" && typeof (value as Rational).comparedTo === "function";
}
export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;

export function fractionOf(value: number | bigint | Decimal | Rational): Rational {
  if (isRational(value)) return value;
  if (typeof value === "bigint") return new Rational(value);
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) throw new Error("Expected a finite exact numeric value");
  const shift = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  if (Math.abs(shift) > 10000) throw new EvaluationLimit("Exact arithmetic exceeds the 10000-digit budget");
  const numerator = BigInt(`${match[1]}${match[2]}${match[3] ?? ""}`);
  return shift >= 0 ? new Rational(numerator * 10n ** BigInt(shift)) : new Rational(numerator, 10n ** BigInt(-shift));
}
export function decimalOf(value: Rational): Decimal {
  let denominator = value.denominator;
  let twos = 0, fives = 0;
  while (denominator % 2n === 0n) { denominator /= 2n; twos++; }
  while (denominator % 5n === 0n) { denominator /= 5n; fives++; }
  if (denominator !== 1n) throw new Error("The result has no finite decimal representation; use quotient() for an exact Rational");
  const scale = Math.max(twos, fives);
  const units = value.numerator * 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives);
  const text = (units < 0n ? -units : units).toString().padStart(scale + 1, "0");
  return new Decimal(`${units < 0n ? "-" : ""}${scale ? `${text.slice(0, -scale)}.${text.slice(-scale)}` : text}`);
}
