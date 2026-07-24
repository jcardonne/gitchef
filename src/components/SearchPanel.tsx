import { useEffect, useState } from "react";
import * as api from "../api";
import type { ContentSearch, FileHistoryEntry } from "../types";
import { relativeTime } from "../util";

/// Repo-wide search overlay (Cmd+Shift+F), distinct from the in-file find and the
/// commit-graph search. Two modes: "Files" greps tracked file contents
/// (`git grep`), "History" runs a pickaxe (`git log -S`/`-G`) for the commits
/// that changed a string. A content hit opens the file at its line; a history hit
/// reveals the commit in the graph. Case + regex toggles apply to both. The query
/// is debounced so each keystroke doesn't spawn a git process.
export default function SearchPanel({
  repoPath,
  onOpenFile,
  onPickCommit,
  onClose,
}: {
  repoPath: string;
  onOpenFile: (path: string, line: number) => void;
  onPickCommit: (sha: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"files" | "history">("files");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [content, setContent] = useState<ContentSearch | null>(null);
  const [commits, setCommits] = useState<FileHistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const q = query.trim();
  useEffect(() => {
    if (!q) {
      setContent(null);
      setCommits(null);
      setError("");
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    // Debounce: a git grep / git log per keystroke would be wasteful.
    const timer = setTimeout(async () => {
      try {
        if (mode === "files") {
          const r = await api.searchContent(repoPath, q, regex, caseSensitive);
          if (alive) { setContent(r); setError(""); }
        } else {
          const c = await api.searchPickaxe(repoPath, q, regex);
          if (alive) { setCommits(c); setError(""); }
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) setLoading(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [repoPath, q, mode, regex, caseSensitive]);

  // A mode switch clears the other mode's stale results so the correct empty
  // state (or "Searching…") shows instead of a flash of the previous mode's.
  useEffect(() => {
    setContent(null);
    setCommits(null);
  }, [mode]);

  const hitCount = content ? content.files.reduce((n, f) => n + f.hits.length, 0) : 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <div className="search-head">
          <div className="search-modes" role="tablist">
            <button className={`search-mode${mode === "files" ? " active" : ""}`} onClick={() => setMode("files")}>Files</button>
            <button className={`search-mode${mode === "history" ? " active" : ""}`} onClick={() => setMode("history")}>History</button>
          </div>
          <input
            className="graph-search-input"
            autoFocus
            spellCheck={false}
            value={query}
            placeholder={mode === "files" ? "Search file contents…" : "Search history for a string…"}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className={`search-nav text${caseSensitive ? " active" : ""}`} onClick={() => setCaseSensitive((v) => !v)} disabled={mode === "history"} title="Match case (files only)">Aa</button>
          <button className={`search-nav text${regex ? " active" : ""}`} onClick={() => setRegex((v) => !v)} title="Regular expression">.*</button>
          <button className="search-nav" onClick={onClose} title="Close (Esc)">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>

        <div className="search-body">
          {error ? (
            <div className="search-empty">{error}</div>
          ) : !q ? (
            <div className="search-empty">Type to search {mode === "files" ? "file contents" : "history"}.</div>
          ) : loading && !content && !commits ? (
            <div className="search-empty">Searching…</div>
          ) : mode === "files" ? (
            hitCount === 0 ? (
              <div className="search-empty">No matches.</div>
            ) : (
              <>
                {content!.files.map((f) => (
                  <div className="search-file" key={f.path}>
                    <div className="search-file-path" title={f.path}>{f.path}</div>
                    {f.hits.map((h, i) => (
                      <button className="search-hit" key={`${h.line}-${i}`} onClick={() => { onOpenFile(f.path, h.line); onClose(); }}>
                        <span className="search-hit-line">{h.line}</span>
                        <span className="search-hit-text">{h.text.trim()}</span>
                      </button>
                    ))}
                  </div>
                ))}
                {content!.truncated && <div className="search-note">Showing the first matches - refine your query.</div>}
              </>
            )
          ) : !commits || commits.length === 0 ? (
            <div className="search-empty">No commits changed that string.</div>
          ) : (
            <div className="reflog-list">
              {commits.map((c) => (
                <div className="reflog-item clickable" key={c.id} onClick={() => { onPickCommit(c.id); onClose(); }}>
                  <div className="reflog-item-info">
                    <span className="reflog-sha">{c.short_id}</span>
                    <span className="reflog-msg" title={c.summary}>{c.summary}</span>
                    <span className="reflog-time">{c.author} · {relativeTime(c.time)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
