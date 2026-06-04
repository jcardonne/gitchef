import type { FileDiff } from "../types";

interface Props {
  diff: FileDiff | null;
}

/// Side-by-side-ish unified diff: old/new line numbers in a gutter, content
/// colored by origin (+ added, - removed, blank = context).
export default function DiffViewer({ diff }: Props) {
  if (!diff) {
    return <div className="empty-hint">Select a file to view its diff.</div>;
  }
  if (diff.binary) {
    return <div className="empty-hint">Binary file - no text diff.</div>;
  }
  if (diff.hunks.length === 0) {
    return <div className="empty-hint">No changes in {diff.path}.</div>;
  }

  return (
    <div className="diff">
      <div className="diff-path">{diff.path}</div>
      <div className="diff-body">
        {diff.hunks.map((hunk, hi) => (
          <div key={hi}>
            {hunk.header && <div className="diff-hunk-header">{hunk.header}</div>}
            {hunk.lines.map((line, li) => {
              const cls =
                line.origin === "+"
                  ? "add"
                  : line.origin === "-"
                  ? "del"
                  : "ctx";
              return (
                <div key={li} className={`diff-line ${cls}`}>
                  <span className="ln">{line.old_lineno ?? ""}</span>
                  <span className="ln">{line.new_lineno ?? ""}</span>
                  <span className="sign">{line.origin === " " ? "" : line.origin}</span>
                  <span className="code">{line.content || " "}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
