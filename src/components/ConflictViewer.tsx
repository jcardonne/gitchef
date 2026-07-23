import { useEffect, useMemo, useRef, useState } from "react";
import type { ConflictFile, ConflictSegment } from "../types";
import * as api from "../api";
import { useRepo } from "../repoContext";
import { useFind, type FindApi } from "../useFind";
import FindBar from "./FindBar";
import { renderCode } from "./CodeLine";

// One choice per conflict block, in document order. "both" = ours then theirs;
// "both_reversed" = theirs then ours (toggled by the bar).
type Choice = "ours" | "theirs" | "both" | "both_reversed" | "neither";

const ACTIONS: { value: Choice; label: string }[] = [
  { value: "ours", label: "Accept current" },
  { value: "theirs", label: "Accept incoming" },
  { value: "both", label: "Accept both" },
  { value: "neither", label: "Accept neither" },
];

interface Props {
  path: string; // the conflicted file path
  onResolved: () => void; // call AFTER a successful resolve so the parent can refresh + close the preview
  findOpen: boolean;
  onFindClose: () => void;
}

/// GitHub-merge-editor-style resolver: a conflicted file split into context and
/// conflict blocks, each block letting you pick a side. Mirrors DiffViewer's row
/// look (.diff-line add/del/ctx) so ours/theirs read as added/removed lines.
// ponytail: renders every line, no virtualization. A conflicted file is small
// (a few blocks); reach for the virtualized DiffViewer path if a giant conflict
// ever shows up.
export default function ConflictViewer({ path, onResolved, findOpen, onFindClose }: Props) {
  const { repoPath, busy, run } = useRepo();
  const [file, setFile] = useState<ConflictFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [choices, setChoices] = useState<(Choice | undefined)[]>([]);
  // Order applied when "Accept both" is clicked (current-first vs incoming-first).
  const [reverseBoth, setReverseBoth] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current; // a newer path bumps this; stale responses bail
    setLoading(true);
    setFile(null);
    api
      .conflictBlocks(repoPath, path)
      .then((f) => {
        if (id !== reqId.current) return;
        const n = f.segments.filter((s) => s.kind === "conflict").length;
        setFile(f);
        setChoices(new Array(n).fill(undefined));
        setLoading(false);
      })
      .catch(() => {
        if (id !== reqId.current) return;
        setLoading(false);
      });
  }, [repoPath, path]);

  // Ctrl/Cmd+F find. Unlike the virtualized previews every line is mounted, so
  // the corpus is a flat walk of the rendered lines (context, then per block
  // ours/base/theirs) and `scrollToRow` scrolls that line's element into view.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // First global line index of each segment, so a rendered `Lines` block knows
  // its rows' indices for match lookup (parallels the corpus walk below).
  const segStart = useMemo<number[]>(() => {
    const starts: number[] = [];
    let g = 0;
    for (const seg of file?.segments ?? []) {
      starts.push(g);
      g += seg.kind === "context" ? seg.lines.length : seg.ours.length + (seg.base?.length ?? 0) + seg.theirs.length;
    }
    return starts;
  }, [file]);
  const rowCells = useMemo<string[][]>(() => {
    if (!findOpen || !file) return [];
    const cells: string[][] = [];
    for (const seg of file.segments) {
      if (seg.kind === "context") for (const l of seg.lines) cells.push([l]);
      else {
        for (const l of seg.ours) cells.push([l]);
        if (seg.base) for (const l of seg.base) cells.push([l]);
        for (const l of seg.theirs) cells.push([l]);
      }
    }
    return cells;
  }, [findOpen, file]);
  const find = useFind(findOpen, rowCells, (row) =>
    scrollRef.current?.querySelectorAll<HTMLElement>(".diff-line")[row]?.scrollIntoView({ block: "center" })
  );

  if (loading) return <div className="conflict-bar">Loading conflicts...</div>;
  if (!file) return null;

  const resolve = (cs: string[]) =>
    run(async () => {
      await api.resolveConflict(repoPath, path, cs);
      onResolved();
    }, "resolve");

  const blocks = choices.length;
  if (blocks === 0) {
    // Already resolved on disk (markers gone): just stage and close.
    return (
      <div className="conflict">
        <div className="conflict-bar">
          <span className="conflict-note">No conflicts remaining</span>
          <button className="mini-btn" disabled={busy} onClick={() => resolve([])}>
            Mark resolved
          </button>
        </div>
      </div>
    );
  }

  const ready = choices.every((c) => c !== undefined) && !busy;

  const takeSide = (side: "ours" | "theirs") =>
    run(async () => {
      await api.takeConflictSide(repoPath, path, side);
      onResolved();
    }, "resolve");

  // Walk the segments; a running index ties each conflict block to its slot in
  // `choices` (keyed by conflict-block document order).
  let ci = -1;
  return (
    <div className="conflict">
      <div className="conflict-bar">
        <button className="mini-btn" disabled={busy} onClick={() => takeSide("ours")}>
          Take all current
        </button>
        <button className="mini-btn" disabled={busy} onClick={() => takeSide("theirs")}>
          Take all incoming
        </button>
        <button
          className="mini-btn"
          onClick={() => setReverseBoth((v) => !v)}
          title="Order used when accepting both sides of a block"
        >
          Both: {reverseBoth ? "incoming first" : "current first"}
        </button>
        <span className="conflict-spacer" />
        <button className="mini-btn" disabled={!ready} onClick={() => resolve(choices as string[])}>
          Mark resolved
        </button>
      </div>
      <div className="diff">
        {findOpen && <FindBar api={find} onClose={onFindClose} />}
        <div className="diff-scroll" ref={scrollRef}>
          <div className="diff-rows">
            {file.segments.map((seg, i) => {
              if (seg.kind === "context") return <Lines key={i} kind="ctx" lines={seg.lines} start={segStart[i]} matches={find.matchesByRow} />;
              const idx = (ci += 1);
              return (
                <ConflictBlock
                  key={i}
                  seg={seg}
                  start={segStart[i]}
                  matches={find.matchesByRow}
                  choice={choices[idx]}
                  reverseBoth={reverseBoth}
                  onChoose={(c) =>
                    setChoices((prev) => {
                      const next = prev.slice();
                      next[idx] = c;
                      return next;
                    })
                  }
                />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function ConflictBlock({
  seg,
  choice,
  reverseBoth,
  onChoose,
  start,
  matches,
}: {
  seg: Extract<ConflictSegment, { kind: "conflict" }>;
  choice: Choice | undefined;
  reverseBoth: boolean;
  onChoose: (c: Choice) => void;
  start: number;
  matches: FindApi["matchesByRow"];
}) {
  const chosen = choice !== undefined;
  const isBoth = choice === "both" || choice === "both_reversed";
  const inOurs = choice === "ours" || isBoth;
  const inTheirs = choice === "theirs" || isBoth;
  // Sub-block line offsets, matching the corpus/render order: ours, base, theirs.
  const baseStart = start + seg.ours.length;
  const theirStart = baseStart + (seg.base?.length ?? 0);
  return (
    <div className="conflict-block">
      <div className="conflict-actions">
        {ACTIONS.map((a) => {
          // "Accept both" stores ours-first or theirs-first per the bar toggle;
          // its highlight covers either both-variant.
          const value = a.value === "both" ? (reverseBoth ? "both_reversed" : "both") : a.value;
          const isChosen = a.value === "both" ? isBoth : choice === value;
          return (
            <button
              key={a.value}
              className={`mini-btn${isChosen ? " chosen" : ""}`}
              onClick={() => onChoose(value)}
            >
              {a.label}
            </button>
          );
        })}
      </div>
      <div className={`conflict-side${chosen && !inOurs ? " dim" : ""}`}>
        <div className="conflict-head ours">Current (ours)</div>
        <Lines kind="add" lines={seg.ours} start={start} matches={matches} />
      </div>
      {seg.base && (
        <div className="conflict-side dim">
          <div className="conflict-head">Base (not selectable)</div>
          <Lines kind="ctx" lines={seg.base} start={baseStart} matches={matches} />
        </div>
      )}
      <div className={`conflict-side${chosen && !inTheirs ? " dim" : ""}`}>
        <div className="conflict-head theirs">Incoming (theirs)</div>
        <Lines kind="del" lines={seg.theirs} start={theirStart} matches={matches} />
      </div>
    </div>
  );
}

// Reuse DiffViewer's row look: .diff-line with add/del/ctx coloring.
function Lines({
  kind,
  lines,
  start,
  matches,
}: {
  kind: "add" | "del" | "ctx";
  lines: string[];
  start: number;
  matches: FindApi["matchesByRow"];
}) {
  const sign = kind === "add" ? "+" : kind === "del" ? "-" : "";
  return (
    <>
      {lines.map((ln, i) => (
        <div key={i} className={`diff-line ${kind}`}>
          <span className="sign">{sign}</span>
          <span className="code">{renderCode(ln, [{ text: ln, changed: false }], matches.get(start + i))}</span>
        </div>
      ))}
    </>
  );
}
