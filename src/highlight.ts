// Class-based syntax highlighting for the diff viewer. Prism is used only as a
// tokenizer (Prism.tokenize), not its HTML/inline-color output, so tokens map to
// `.token.<type>` classes that styles.css recolors per theme via CSS variables -
// and they compose with the word-diff `.diff-seg` background.

import Prism from "prismjs";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-css";
import "prismjs/components/prism-json";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-python";
import "prismjs/components/prism-go";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-java";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-sql";
import type { Segment } from "./wordDiff";

// We tokenize on demand, never the DOM-scanning auto-highlighter.
Prism.manual = true;

export interface Token {
  text: string;
  type?: string;
}

export interface RenderSpan {
  text: string;
  type?: string;
  changed: boolean;
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  rs: "rust", py: "python", go: "go", json: "json", jsonc: "json",
  css: "css", scss: "css", less: "css",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup",
  sh: "bash", bash: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml", toml: "toml",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  java: "java", rb: "ruby", md: "markdown", markdown: "markdown", sql: "sql",
};

// Lines longer than this skip highlighting (minified bundles etc.).
const MAX_LEN = 2000;

/// Prism language id for a file path, or null when unsupported.
export function langForPath(path: string): string | null {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ext) return null;
  const lang = EXT_LANG[ext];
  return lang && Prism.languages[lang] ? lang : null;
}

/// Tokenize one line into class-tagged spans. Untyped runs (whitespace, plain
/// text) carry no type. Falls back to a single plain token when unsupported.
export function highlightTokens(text: string, lang: string | null): Token[] {
  const grammar = lang ? Prism.languages[lang] : undefined;
  if (!grammar || text.length > MAX_LEN) return [{ text }];
  const out: Token[] = [];
  flatten(Prism.tokenize(text, grammar), out, undefined);
  return out;
}

function flatten(stream: Prism.TokenStream, out: Token[], parentType: string | undefined): void {
  const tokens = Array.isArray(stream) ? stream : [stream];
  for (const t of tokens) {
    if (typeof t === "string") {
      if (t) out.push({ text: t, type: parentType });
    } else if (typeof t.content === "string") {
      out.push({ text: t.content, type: t.type });
    } else {
      flatten(t.content, out, t.type);
    }
  }
}

/// Merge syntax tokens with the word-diff segments of the same line so each final
/// span carries both its syntax type and whether it's a changed segment. Both
/// inputs cover the identical line text, so their lengths line up.
export function composeSpans(tokens: Token[], segs: Segment[] | null): RenderSpan[] {
  if (!segs) return tokens.map((t) => ({ text: t.text, type: t.type, changed: false }));
  const out: RenderSpan[] = [];
  let si = 0;
  let off = 0;
  for (const tok of tokens) {
    let rest = tok.text;
    while (rest.length > 0) {
      const seg = segs[si];
      if (!seg) {
        out.push({ text: rest, type: tok.type, changed: false });
        break;
      }
      const take = Math.min(rest.length, seg.text.length - off);
      out.push({ text: rest.slice(0, take), type: tok.type, changed: seg.changed });
      rest = rest.slice(take);
      off += take;
      if (off >= seg.text.length) {
        si++;
        off = 0;
      }
    }
  }
  return out;
}
