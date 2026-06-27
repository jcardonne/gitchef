import { describe, it, expect } from "vitest";
import { langForPath, highlightTokens, composeSpans } from "./highlight";

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
