/// Pure helpers for keyboard navigation of the change list. Kept DOM-free so the
/// index math (clamping, inclusive ranges) is unit-tested in isolation.

/// Next focusable index in `dir`, clamped to [0, length-1]. Returns -1 if empty.
export function nextIndex(current: number, dir: 1 | -1, length: number): number {
  if (length <= 0) return -1;
  return Math.max(0, Math.min(current + dir, length - 1));
}

/// Keys of `items` between indices a and b inclusive, regardless of order.
export function rangeKeys<T>(items: T[], keyOf: (t: T) => string, a: number, b: number): string[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out: string[] = [];
  for (let i = lo; i <= hi; i++) {
    if (items[i] !== undefined) out.push(keyOf(items[i]));
  }
  return out;
}
