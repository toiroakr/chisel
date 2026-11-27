import { Decimal } from "decimal.js";
export class EvaluationLimit extends Error {
  constructor(message: string) { super(message); this.name = "EvaluationLimit"; }
}

// A run that has no room to write an answer the model defines (ADR-0128): the
// platform failing, not the model. Told apart by its name, since a model may
// be run by a copy of Chisel another module graph loaded.
export class OutOfRoom extends EvaluationLimit {
  constructor(message: string) { super(message); this.name = "OutOfRoom"; }
}

export function isOutOfRoom(error: unknown): boolean {
  return error instanceof Error && error.name === "OutOfRoom";
}

export type Rounding = "half-up" | "half-down" | "half-even" | "up" | "down" | "ceiling" | "floor";

// A rational rounded to `scale` digits after the point, as Souther's
// Decimal.round does: exact, at any scale.
export function roundedAt(value: Rational, scale: number, mode: Rounding): Rational {
  // The power below is built before any digit is read, so a scale past the budget fractionOf holds numbers to is refused here.
  if (scale > 10000) throw new OutOfRoom("Exact arithmetic exceeds the 10000-digit budget");
  const unit = 10n ** BigInt(scale);
  const scaled = value.times(new Rational(unit));
  const { numerator, denominator } = scaled;
  const floor = numerator >= 0n ? numerator / denominator : -((-numerator + denominator - 1n) / denominator);
  const remainder = numerator - floor * denominator;
  if (remainder === 0n) return new Rational(floor, unit);
  const ceil = floor + 1n;
  const twice = remainder * 2n;
  const awayFromZero = numerator >= 0n ? ceil : floor;
  const towardZero = numerator >= 0n ? floor : ceil;
  const nearest = twice < denominator ? floor : twice > denominator ? ceil : undefined;
  const chosen =
    mode === "floor" ? floor
    : mode === "ceiling" ? ceil
    : mode === "up" ? awayFromZero
    : mode === "down" ? towardZero
    : nearest !== undefined ? nearest
    : mode === "half-up" ? awayFromZero
    : mode === "half-down" ? towardZero
    : floor % 2n === 0n ? floor : ceil;
  return new Rational(chosen, unit);
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
  if (Math.abs(shift) > 10000) throw new OutOfRoom("Exact arithmetic exceeds the 10000-digit budget");
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

// A run cut short by a limit of evaluation, OutOfRoom included, told apart by
// name too since a model may run in another module graph.
export function isEvaluationLimit(error: unknown): boolean {
  return error instanceof EvaluationLimit || (error instanceof Error && (error.name === "EvaluationLimit" || error.name === "OutOfRoom"));
}
