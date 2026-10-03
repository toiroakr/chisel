export function compareText(left: string, right: string): number {
  const a = [...left.normalize("NFC")];
  const b = [...right.normalize("NFC")];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return Math.sign(difference);
  }
  return Math.sign(a.length - b.length);
}
