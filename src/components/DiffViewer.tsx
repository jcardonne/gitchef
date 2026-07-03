import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffLine, FileDiff } from "../types";
import { useVirtual } from "../useVirtual";
import { wordDiff } from "../wordDiff";
import { langForPath, highlightTokens, composeSpans } from "../highlight";
import EmptyState, { DocIcon, BinaryIcon, CheckIcon } from "./EmptyState";

const ROW_H = 18; // must match .diff-line / .diff-hunk-header height in CSS

interface Props {
  diff: FileDiff | null;
  // Right-click a hunk. `selected` carries the chosen line keys when the
  // right-clicked hunk has a line selection (empty otherwise), which lets the
  // caller offer line-level stage/discard alongside the whole-hunk actions.
  onHunkMenu?: (header: string, text: string, selected: string[]) => void;
  /// "split" renders old|new side-by-side (read-only); "unified" (default) is the
  /// stacked view with line-level staging.
  mode?: "unified" | "split";
}

type Row = { hunk: string; hi: number } | { line: DiffLine; hi: number; pair?: string };
// Split rows collapse each replacement pair into ONE row (left old / right new),
// so the fixed-height virtualization stays in sync with the rendered rows.
type SplitRow = { hunk: string; hi: number } | { left: DiffLine | null; right: DiffLine | null };

// A changed line's identity for partial staging: "+<new_lineno>" / "-<old_lineno>"
// (matches the backend's apply_lines keys). Context lines aren't changes -> null.
function lineKey(line: DiffLine): string | null {
  if (line.origin === "+") return `+${line.new_lineno}`;
  if (line.origin === "-") return `-${line.old_lineno}`;
  return null;
}

/// Virtualized unified diff: only the rows in (and just around) the viewport are
/// mounted, so even a 168k-line file scrolls smoothly. Rows are fixed-height and
/// the scroll height is faked with top/bottom padding spacers. When `onHunkMenu`
/// is set (a working-file diff), changed lines are click-selectable for
/// line-level staging.
export default function DiffViewer({ diff, onHunkMenu, mode = "unified" }: Props) {
  // Line selection for partial staging, scoped to a single hunk at a time.
  const [selHunk, setSelHunk] = useState<number | null>(null);
  const [selKeys, setSelKeys] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null); // last single-clicked key, for shift-range

  const rows = useMemo<Row[]>(() => {
    if (!diff) return [];
    const out: Row[] = [];
    diff.hunks.forEach((h, hi) => {
      if (h.header) out.push({ hunk: h.header, hi });
      const lines = h.lines;
      let k = 0;
      while (k < lines.length) {
        if (lines[k].origin !== "-") {
          out.push({ line: lines[k], hi });
          k++;
          continue;
        }
        // A run of removed lines followed by added lines is a replacement block;
        // pair removed[i] with added[i] so each can word-diff against its mate.
        let d = k;
        while (d < lines.length && lines[d].origin === "-") d++;
        let a = d;
        while (a < lines.length && lines[a].origin === "+") a++;
        const paired = Math.min(d - k, a - d);
        for (let x = k; x < d; x++)
          out.push({ line: lines[x], hi, pair: x - k < paired ? lines[d + (x - k)].content : undefined });
        for (let x = d; x < a; x++)
          out.push({ line: lines[x], hi, pair: x - d < paired ? lines[k + (x - d)].content : undefined });
        k = a;
      }
    });
    return out;
  }, [diff]);
  // Side-by-side rows: context -> both columns; a removed run zipped with the
  // following added run -> one row per pair (surplus lines get an empty mate).
  const splitRows = useMemo<SplitRow[]>(() => {
    if (!diff) return [];
    const out: SplitRow[] = [];
    diff.hunks.forEach((h, hi) => {
      if (h.header) out.push({ hunk: h.header, hi });
      const lines = h.lines;
      let k = 0;
      while (k < lines.length) {
        const origin = lines[k].origin;
        if (origin === " ") {
          out.push({ left: lines[k], right: lines[k] });
          k++;
        } else if (origin === "+") {
          out.push({ left: null, right: lines[k] });
          k++;
        } else {
          let d = k;
          while (d < lines.length && lines[d].origin === "-") d++;
          let a = d;
          while (a < lines.length && lines[a].origin === "+") a++;
          const dels = lines.slice(k, d);
          const adds = lines.slice(d, a);
          for (let x = 0; x < Math.max(dels.length, adds.length); x++)
            out.push({ left: dels[x] ?? null, right: adds[x] ?? null });
          k = a;
        }
      }
    });
    return out;
  }, [diff]);
  const lang = useMemo(() => (diff ? langForPath(diff.path) : null), [diff]);

  // Split view is read-only: suppress the staging menu/selection there.
  const menu = mode === "split" ? undefined : onHunkMenu;
  const list: (Row | SplitRow)[] = mode === "split" ? splitRows : rows;
  const { ref, start, end, padTop, padBottom } = useVirtual(list.length, ROW_H, diff);

  // Clear the line selection whenever the shown diff changes - including a
  // reload of the same file after staging (keys may no longer exist). The
  // scroll reset is handled by useVirtual's resetKey above.
  useEffect(() => {
    setSelHunk(null);
    setSelKeys(new Set());
    anchor.current = null;
  }, [diff]);

  if (!diff) return <EmptyState icon={<DocIcon />} title="No file selected" hint="Pick a file from the list to see its changes." />;
  if (diff.binary) return <EmptyState icon={<BinaryIcon />} title="Binary file" hint="No text diff to show." />;
  if (list.length === 0) return <EmptyState icon={<CheckIcon />} title="No changes" hint={diff.path} />;

  const selectable = !!menu;

  const clickLine = (hi: number, key: string, shift: boolean) => {
    if (shift && selHunk === hi && anchor.current) {
      const keys = diff.hunks[hi].lines.map(lineKey).filter((k): k is string => k !== null);
      const a = keys.indexOf(anchor.current);
      const b = keys.indexOf(key);
      if (a >= 0 && b >= 0) {
        const [lo, hiIdx] = a < b ? [a, b] : [b, a];
        setSelKeys(new Set(keys.slice(lo, hiIdx + 1)));
        return;
      }
    }
    if (selHunk !== hi) {
      setSelHunk(hi);
      setSelKeys(new Set([key]));
    } else {
      const next = new Set(selKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setSelKeys(next);
      if (next.size === 0) setSelHunk(null);
    }
    anchor.current = key;
  };

  const openMenu = (hi: number) => {
    if (!onHunkMenu) return;
    const text = [diff.hunks[hi].header, ...diff.hunks[hi].lines.map((l) => l.origin + l.content)]
      .filter((s) => s.length > 0)
      .join("\n");
    onHunkMenu(diff.hunks[hi].header, text, selHunk === hi ? [...selKeys] : []);
  };

  return (
    <div className={`diff${mode === "split" ? " split" : ""}`}>
      <div className="diff-scroll" ref={ref}>
        <div className="diff-rows" style={{ paddingTop: padTop, paddingBottom: padBottom }}>
          {list.slice(start, end).map((row, i) => {
            if ("hunk" in row) {
              return (
                <div
                  key={start + i}
                  className="diff-hunk-header"
                  onContextMenu={
                    menu
                      ? (e) => {
                          e.preventDefault();
                          openMenu(row.hi);
                        }
                      : undefined
                  }
                >
                  {row.hunk}
                </div>
              );
            }
            if ("left" in row) {
              return <SplitRowView key={start + i} left={row.left} right={row.right} lang={lang} />;
            }
            const key = lineKey(row.line);
            const sel = selectable && key !== null && selHunk === row.hi && selKeys.has(key);
            return (
              <DiffRow
                key={start + i}
                line={row.line}
                pair={row.pair}
                lang={lang}
                selected={sel}
                onClick={
                  selectable && key !== null ? (e) => clickLine(row.hi, key, e.shiftKey) : undefined
                }
                onContextMenu={
                  menu
                    ? (e) => {
                        e.preventDefault();
                        openMenu(row.hi);
                      }
                    : undefined
                }
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DiffRow({
  line,
  pair,
  lang,
  selected,
  onClick,
  onContextMenu,
}: {
  line: DiffLine;
  pair?: string;
  lang: string | null;
  selected?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const cls = line.origin === "+" ? "add" : line.origin === "-" ? "del" : "ctx";
  const spans = useMemo(() => {
    const wd = pair == null ? null : wordDiff(line.origin === "+" ? pair : line.content, line.origin === "+" ? line.content : pair);
    const side = wd ? (line.origin === "+" ? wd.add : wd.del) : null;
    return composeSpans(highlightTokens(line.content, lang), side && side.length ? side : null);
  }, [line.content, line.origin, pair, lang]);
  return (
    <div
      className={`diff-line ${cls}${selected ? " sel" : ""}${onClick ? " selectable" : ""}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span className="ln">{line.old_lineno ?? ""}</span>
      <span className="ln">{line.new_lineno ?? ""}</span>
      <span className="sign">{line.origin === " " ? "" : line.origin}</span>
      <span className="code">{codeContent(line.content, spans)}</span>
    </div>
  );
}

/// Render highlighted + word-diff spans for a line's content (shared by the
/// unified and split rows). Empty content renders a space to keep row height.
function codeContent(content: string, spans: ReturnType<typeof composeSpans>) {
  if (content === "") return " ";
  return spans.map((s, i) => {
    const c = `${s.type ? `token ${s.type}` : ""}${s.changed ? " diff-seg" : ""}`.trim();
    return c ? (
      <span key={i} className={c}>
        {s.text}
      </span>
    ) : (
      s.text
    );
  });
}

/// One side-by-side row: old on the left, new on the right. A paired removal +
/// addition word-diffs against each other; a context line shows on both sides.
function SplitRowView({
  left,
  right,
  lang,
}: {
  left: DiffLine | null;
  right: DiffLine | null;
  lang: string | null;
}) {
  const paired = !!left && !!right && left.origin === "-" && right.origin === "+";
  return (
    <div className="split-line">
      <SplitCell line={left} lineno={left?.old_lineno ?? null} mate={paired ? right!.content : undefined} lang={lang} />
      <SplitCell line={right} lineno={right?.new_lineno ?? null} mate={paired ? left!.content : undefined} lang={lang} />
    </div>
  );
}

function SplitCell({
  line,
  lineno,
  mate,
  lang,
}: {
  line: DiffLine | null;
  lineno: number | null;
  mate?: string;
  lang: string | null;
}) {
  const spans = useMemo(() => {
    if (!line) return null;
    const wd = mate == null ? null : wordDiff(line.origin === "+" ? mate : line.content, line.origin === "+" ? line.content : mate);
    const side = wd ? (line.origin === "+" ? wd.add : wd.del) : null;
    return composeSpans(highlightTokens(line.content, lang), side && side.length ? side : null);
  }, [line, mate, lang]);
  if (!line || !spans) return <div className="split-cell empty" />;
  const cls = line.origin === "+" ? "add" : line.origin === "-" ? "del" : "ctx";
  return (
    <div className={`split-cell ${cls}`}>
      <span className="ln">{lineno ?? ""}</span>
      <span className="code">{codeContent(line.content, spans)}</span>
    </div>
  );
}
