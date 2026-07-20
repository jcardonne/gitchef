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

  // Whatever the tokenizer fails to match is dropped from the rendered row, so
  // the segments must always rejoin to the original line. NFD text (what macOS
  // hands us) is the case that catches a non-exhaustive alternation.
  it("never drops a character, whatever the input", () => {
    const lines = [
      'const x = foo(2);',
      'const café = "crème";', // NFD then NFC accents
      "́leading combining mark",
      'const flag = "\u{1F1EB}\u{1F1F7}";',
      "\tif (a !== b) { c += 1; }",
      "中文 identifiers",
    ];
    for (const a of lines) {
      const r = wordDiff(a, "x");
      expect(r!.del.map((s) => s.text).join("")).toBe(a);
    }
  });

  it("never splits an astral character across segments", () => {
    const r = wordDiff('const label = "done 🎉";', 'const label = "ok 🎈";');
    // A lone surrogate in any segment renders as U+FFFD in the diff row.
    for (const seg of [...r!.del, ...r!.add])
      expect(seg.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(r!.del.map((s) => s.text).join("")).toBe('const label = "done 🎉";');
    expect(r!.add.map((s) => s.text).join("")).toBe('const label = "ok 🎈";');
  });

  it("bails out on pathologically long lines", () => {
    expect(wordDiff("a".repeat(500), "b")).toBeNull();
  });
});
