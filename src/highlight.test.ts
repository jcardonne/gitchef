import { describe, it, expect } from "vitest";
import { langForPath, highlightTokens, composeSpans, overlayMatches } from "./highlight";

describe("langForPath", () => {
  it("maps known extensions and rejects the rest", () => {
    expect(langForPath("src/App.tsx")).toBe("tsx");
    expect(langForPath("main.rs")).toBe("rust");
    expect(langForPath("a/b/script.py")).toBe("python");
    expect(langForPath("x.unknownext")).toBeNull();
    expect(langForPath("Makefile")).toBeNull();
  });
});

describe("highlightTokens", () => {
  it("tokenizes a line into typed spans that rebuild the original text", () => {
    const toks = highlightTokens("const x = 1;", "typescript");
    expect(toks.map((t) => t.text).join("")).toBe("const x = 1;");
    expect(toks.some((t) => t.type === "keyword" && t.text === "const")).toBe(true);
    expect(toks.some((t) => t.type === "number" && t.text === "1")).toBe(true);
  });

  it("falls back to a single plain token without a language", () => {
    expect(highlightTokens("anything goes", null)).toEqual([{ text: "anything goes" }]);
  });
});

describe("composeSpans", () => {
  it("splits syntax tokens at word-diff boundaries", () => {
    const tokens = highlightTokens("const x = foo;", "typescript");
    const segs = [
      { text: "const x = ", changed: false },
      { text: "foo", changed: true },
      { text: ";", changed: false },
    ];
    const spans = composeSpans(tokens, segs);
    expect(spans.map((s) => s.text).join("")).toBe("const x = foo;");
    expect(spans.find((s) => s.text === "foo")?.changed).toBe(true);
    expect(spans.find((s) => s.text === "const")?.changed).toBe(false);
    // syntax type survives the merge
    expect(spans.find((s) => s.text === "const")?.type).toBe("keyword");
  });

  it("marks everything unchanged when there is no word diff", () => {
    const tokens = highlightTokens("let y = 2;", "typescript");
    const spans = composeSpans(tokens, null);
    expect(spans.every((s) => !s.changed)).toBe(true);
  });
});

describe("overlayMatches", () => {
  it("returns base spans unchanged when there are no hits", () => {
    const base = composeSpans(highlightTokens("let y = 2;", "typescript"), null);
    const out = overlayMatches(base, []);
    expect(out.map((s) => s.text).join("")).toBe("let y = 2;");
    expect(out.every((s) => !s.hit)).toBe(true);
  });

  it("splits a span at a match boundary and flags the hit", () => {
    const base = [{ text: "hello world", changed: false }];
    const out = overlayMatches(base, [{ start: 6, end: 11, current: false }]);
    expect(out.map((s) => s.text)).toEqual(["hello ", "world"]);
    expect(out.find((s) => s.text === "world")?.hit).toBe(true);
    expect(out.find((s) => s.text === "hello ")?.hit).toBeFalsy();
  });

  it("keeps the syntax type and marks the current hit", () => {
    const base = highlightTokens("const x = 1;", "typescript").map((t) => ({ text: t.text, type: t.type, changed: false }));
    // Highlight the "const" keyword as the active match.
    const out = overlayMatches(base, [{ start: 0, end: 5, current: true }]);
    const hit = out.find((s) => s.text === "const");
    expect(hit?.hit).toBe(true);
    expect(hit?.current).toBe(true);
    expect(hit?.type).toBe("keyword"); // syntax color survives the overlay
  });

  it("marks a match that spans multiple base spans", () => {
    // "x = 1" tokenizes into several spans; a match covering all of it must tag
    // every piece as a hit while preserving the reconstructed text.
    const base = highlightTokens("x = 1", "typescript").map((t) => ({ text: t.text, type: t.type, changed: false }));
    const out = overlayMatches(base, [{ start: 0, end: 5, current: false }]);
    expect(out.map((s) => s.text).join("")).toBe("x = 1");
    expect(out.every((s) => s.hit)).toBe(true);
  });

  it("handles multiple hits in one line", () => {
    const base = [{ text: "a foo b foo c", changed: false }];
    const out = overlayMatches(base, [
      { start: 2, end: 5, current: false },
      { start: 8, end: 11, current: true },
    ]);
    const hits = out.filter((s) => s.hit);
    expect(hits.map((s) => s.text)).toEqual(["foo", "foo"]);
    expect(hits[1].current).toBe(true);
    expect(out.map((s) => s.text).join("")).toBe("a foo b foo c");
  });
});
