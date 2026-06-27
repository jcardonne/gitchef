import { describe, it, expect } from "vitest";
import { wordDiff } from "./wordDiff";

describe("wordDiff", () => {
  it("flags only the changed tokens, preserving each side's text", () => {
    const r = wordDiff("const x = foo(1);", "const x = bar(2);");
    expect(r).not.toBeNull();
    if (!r) return;
    // Segments concatenate back to the exact original line on each side.
    expect(r.del.map((s) => s.text).join("")).toBe("const x = foo(1);");
    expect(r.add.map((s) => s.text).join("")).toBe("const x = bar(2);");
    // The shared prefix stays unchanged on both sides.
    expect(r.del.find((s) => s.text.includes("const"))?.changed).toBe(false);
    expect(r.add.find((s) => s.text.includes("const"))?.changed).toBe(false);
    // The differing identifiers/numbers are flagged as changed.
    expect(r.del.filter((s) => s.changed).map((s) => s.text).join("")).toContain("foo");
    expect(r.add.filter((s) => s.changed).map((s) => s.text).join("")).toContain("bar");
  });

  it("marks a whole-token replacement as changed on both sides", () => {
    expect(wordDiff("abc", "xyz")).toEqual({
      del: [{ text: "abc", changed: true }],
      add: [{ text: "xyz", changed: true }],
    });
  });

  it("bails out on pathologically long lines", () => {
    expect(wordDiff("a".repeat(500), "b")).toBeNull();
  });
});
