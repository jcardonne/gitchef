import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { renderCode } from "./CodeLine";
import { langForPath, highlightTokens, composeSpans } from "../highlight";
import { computeMatches, type Hit } from "../find";

// Render one file line exactly as FileView/BlameView do, then group its matches
// the way useFind's `matchesByRow` does, so this exercises the real render path.
function renderLine(text: string, path: string, query: string): string {
  const lang = langForPath(path);
  const base = composeSpans(highlightTokens(text, lang), null);
  const hits: Hit[] = computeMatches([[text]], query, false).map((m) => ({
    start: m.start,
    end: m.end,
    current: false,
  }));
  return renderToStaticMarkup(createElement("span", null, renderCode(text, base, hits)));
}

describe("renderCode (integration)", () => {
  it("emits syntax token classes for a colored line", () => {
    const html = renderLine("const x = 1;", "a.ts", "");
    expect(html).toContain('class="token keyword"'); // const
    expect(html).toContain('class="token number"'); // 1
    // The rendered text still reconstructs the original line.
    expect(html.replace(/<[^>]+>/g, "")).toBe("const x = 1;");
  });

  it("wraps find matches in <mark class=\"find-hit\"> over the syntax coloring", () => {
    const html = renderLine("const x = 1;", "a.ts", "const");
    expect(html).toContain('<mark class="find-hit">');
    // The keyword coloring survives inside the mark.
    expect(html).toContain('<mark class="find-hit"><span class="token keyword">const</span></mark>');
  });

  it("renders a plain (unsupported) line with a highlighted match", () => {
    const html = renderLine("plain text here", "notes.unknownext", "text");
    expect(html).toContain('<mark class="find-hit">text</mark>');
    expect(html.replace(/<[^>]+>/g, "")).toBe("plain text here");
  });

  it("renders empty content as a space to preserve row height", () => {
    const html = renderToStaticMarkup(createElement("span", null, renderCode("", [], undefined)));
    expect(html).toBe("<span> </span>");
  });
});
