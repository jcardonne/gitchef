import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffLine, FileDiff } from "../types";
import { useVirtual } from "../useVirtual";

const ROW_H = 18; // must match .diff-line / .diff-hunk-header height in CSS

interface Props {
  diff: FileDiff | null;
  // Right-click a hunk. `selected` carries the chosen line keys when the
  // right-clicked hunk has a line selection (empty otherwise), which lets the
  // caller offer line-level stage/discard alongside the whole-hunk actions.
  onHunkMenu?: (header: string, text: string, selected: string[]) => void;
}

type Row = { hunk: string; hi: number } | { line: DiffLine; hi: number };

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
export default function DiffViewer({ diff, onHunkMenu }: Props) {
  // Line selection for partial staging, scoped to a single hunk at a time.
  const [selHunk, setSelHunk] = useState<number | null>(null);
  const [selKeys, setSelKeys] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null); // last single-clicked key, for shift-range

  const rows = useMemo<Row[]>(() => {
    if (!diff) return [];
    const out: Row[] = [];
    diff.hunks.forEach((h, hi) => {
      if (h.header) out.push({ hunk: h.header, hi });
      for (const l of h.lines) out.push({ line: l, hi });
    });
    return out;
  }, [diff]);

  const { ref, start, end, padTop, padBottom } = useVirtual(rows.length, ROW_H, diff);

  // Clear the line selection whenever the shown diff changes - including a
  // reload of the same file after staging (keys may no longer exist). The
  // scroll reset is handled by useVirtual's resetKey above.
  useEffect(() => {
    setSelHunk(null);
    setSelKeys(new Set());
    anchor.current = null;
  }, [diff]);

  if (!diff) return <div className="empty-hint">Select a file to view its diff.</div>;
  if (diff.binary) return <div className="empty-hint">Binary file - no text diff.</div>;
  if (rows.length === 0) return <div className="empty-hint">No changes in {diff.path}.</div>;

  const selectable = !!onHunkMenu;

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
    <div className="diff">
      <div className="diff-scroll" ref={ref}>
        <div style={{ paddingTop: padTop, paddingBottom: padBottom }}>
          {rows.slice(start, end).map((row, i) => {
            if ("hunk" in row) {
              return (
                <div
                  key={start + i}
                  className="diff-hunk-header"
                  onContextMenu={
                    onHunkMenu
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
            const key = lineKey(row.line);
            const sel = selectable && key !== null && selHunk === row.hi && selKeys.has(key);
            return (
              <DiffRow
                key={start + i}
                line={row.line}
                selected={sel}
                onClick={
                  selectable && key !== null ? (e) => clickLine(row.hi, key, e.shiftKey) : undefined
                }
                onContextMenu={
                  onHunkMenu
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
  selected,
  onClick,
  onContextMenu,
}: {
  line: DiffLine;
  selected?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const cls = line.origin === "+" ? "add" : line.origin === "-" ? "del" : "ctx";
  return (
    <div
      className={`diff-line ${cls}${selected ? " sel" : ""}${onClick ? " selectable" : ""}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span className="ln">{line.old_lineno ?? ""}</span>
      <span className="ln">{line.new_lineno ?? ""}</span>
      <span className="sign">{line.origin === " " ? "" : line.origin}</span>
      <span className="code">{line.content || " "}</span>
    </div>
  );
}
