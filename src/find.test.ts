import { describe, it, expect } from "vitest";
import { computeMatches } from "./find";

describe("computeMatches", () => {
  it("finds every occurrence in reading order (row, cell, position)", () => {
    const rows = [["foo bar foo"], ["baz"], ["a foo"]];
    const m = computeMatches(rows, "foo", false);
    expect(m).toEqual([
      { row: 0, cell: 0, start: 0, end: 3 },
      { row: 0, cell: 0, start: 8, end: 11 },
      { row: 2, cell: 0, start: 2, end: 5 },
    ]);
  });

  it("is case-insensitive by default and exact when caseSensitive", () => {
    const rows = [["Foo FOO foo"]];
    expect(computeMatches(rows, "foo", false)).toHaveLength(3);
    const cs = computeMatches(rows, "foo", true);
    expect(cs).toEqual([{ row: 0, cell: 0, start: 8, end: 11 }]);
  });

  it("walks cells left-to-right within a row (split diff sides)", () => {
    const rows = [["x = 1", "x = 2"]];
    const m = computeMatches(rows, "x", false);
    expect(m).toEqual([
      { row: 0, cell: 0, start: 0, end: 1 },
      { row: 0, cell: 1, start: 0, end: 1 },
    ]);
  });

  it("counts non-overlapping matches only", () => {
    // "aa" in "aaaa" -> positions 0 and 2, not 1.
    expect(computeMatches([["aaaa"]], "aa", false)).toEqual([
      { row: 0, cell: 0, start: 0, end: 2 },
      { row: 0, cell: 0, start: 2, end: 4 },
    ]);
  });

  it("returns nothing for an empty query or empty cells", () => {
    expect(computeMatches([["hello"]], "", false)).toEqual([]);
    expect(computeMatches([[""], []], "x", false)).toEqual([]);
  });
});
