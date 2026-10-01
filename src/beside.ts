// Souther's E1938: a border every point of which has a row may still be the
// wrong line, turned about its points; a row on the other side of a line beside
// it tells the two apart.

export type Beside =
  | { readonly status: "told" }
  | { readonly status: "not told"; readonly another: string; readonly input?: string }
  | { readonly status: "undecided"; readonly reason: string };

export const allOnOneSide = "境界に届いた行がすべて境界の外側にある";

export interface LineBeside {
  readonly weights: readonly number[];
  readonly cut: number;
}

// The lines one weight away from the border's, each part's weight moved by +1
// and then -1 in the order of the parts, and reduced by their common divisor.
export function linesBeside(weights: readonly number[]): readonly (readonly number[])[] {
  const seen = [reduced(weights)];
  const lines: number[][] = [];
  weights.forEach((_, index) => {
    for (const step of [1, -1]) {
      const moved = reduced(weights.map((weight, other) => (other === index ? weight + step : weight)));
      if (moved.every(weight => weight === 0) || seen.some(line => same(line, moved))) {
        continue;
      }
      seen.push(moved);
      lines.push(moved);
    }
  });
  return lines;
}

// The first line beside the border on which a cut keeps every row the border
// keeps and refuses every row it refuses.
export function lineTheRowsAllow(
  weights: readonly number[],
  keptBelow: boolean,
  kept: readonly (readonly number[])[],
  refused: readonly (readonly number[])[],
): LineBeside | undefined {
  for (const line of linesBeside(weights)) {
    const at = (values: readonly number[]) => line.reduce((total, weight, index) => total + weight * values[index]!, 0);
    const cut = keptBelow ? Math.max(...kept.map(at)) : Math.min(...kept.map(at));
    if (refused.every(values => (keptBelow ? at(values) > cut : at(values) < cut))) {
      return { weights: line, cut };
    }
  }
  return undefined;
}

export function spelled(paths: readonly string[], line: LineBeside): string {
  const terms = line.weights.flatMap((weight, index) => (weight === 0 ? [] : [{ weight, path: paths[index]! }]));
  const written = terms
    .map(({ weight, path }, index) => {
      const size = Math.abs(weight);
      const body = size === 1 ? path : `${size} * ${path}`;
      return index === 0 ? (weight < 0 ? `-${body}` : body) : `${weight < 0 ? "-" : "+"} ${body}`;
    })
    .join(" ");
  return `${written} = ${line.cut}`;
}

function reduced(weights: readonly number[]): number[] {
  const divisor = weights.reduce((common, weight) => gcd(common, Math.abs(weight)), 0);
  return divisor <= 1 ? [...weights] : weights.map(weight => weight / divisor);
}

function gcd(left: number, right: number): number {
  return right === 0 ? left : gcd(right, left % right);
}

function same(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((weight, index) => weight === right[index]);
}
