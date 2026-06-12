import { describe, it, expect } from "vitest";
import { nextIndex, rangeKeys } from "./changeNav";

describe("nextIndex", () => {
  it("moves within bounds", () => {
    expect(nextIndex(0, 1, 3)).toBe(1);
    expect(nextIndex(1, -1, 3)).toBe(0);
  });
  it("clamps at both ends", () => {
    expect(nextIndex(2, 1, 3)).toBe(2);
    expect(nextIndex(0, -1, 3)).toBe(0);
  });
  it("returns -1 for an empty list", () => {
    expect(nextIndex(0, 1, 0)).toBe(-1);
  });
});

describe("rangeKeys", () => {
  const items = [{ p: "a" }, { p: "b" }, { p: "c" }, { p: "d" }];
  const k = (x: { p: string }) => x.p;
  it("builds an inclusive range regardless of direction", () => {
    expect(rangeKeys(items, k, 1, 2)).toEqual(["b", "c"]);
    expect(rangeKeys(items, k, 2, 0)).toEqual(["a", "b", "c"]);
    expect(rangeKeys(items, k, 1, 1)).toEqual(["b"]);
  });
  it("skips out-of-range indices", () => {
    expect(rangeKeys(items, k, 2, 9)).toEqual(["c", "d"]);
  });
});
