import { useEffect, useState } from "react";
import * as api from "../api";
import type { FileHistoryEntry } from "../types";
import { relativeTime } from "../util";

/// Lists the commits that changed `filePath` (newest first). Picking one jumps
/// to that commit. Reuses the reflog modal's list styling.
export default function FileHistoryModal({
  repoPath,
  filePath,
  onPick,
  onClose,
}: {
  repoPath: string;
  filePath: string;
  onPick: (sha: string) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<FileHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.fileHistory(repoPath, filePath).then(
      (e) => alive && setEntries(e),
      (err) => alive && setError(String(err))
    );
    return () => {
      alive = false;
    };
  }, [repoPath, filePath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="reflog-modal" onClick={(e) => e.stopPropagation()}>
        <h3 title={filePath}>History · {filePath.split("/").pop()}</h3>
        {error ? (
          <div className="reflog-empty">{error}</div>
        ) : entries === null ? (
          <div className="reflog-empty">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="reflog-empty">No history for this file.</div>
        ) : (
          <div className="reflog-list">
            {entries.map((e) => (
              <div
                key={e.id}
                className="reflog-item clickable"
                onClick={() => {
                  onClose();
                  onPick(e.id);
                }}
              >
                <div className="reflog-item-info">
                  <span className="reflog-sha">{e.short_id}</span>
                  <span className="reflog-msg" title={e.summary}>
                    {e.summary}
                  </span>
                  <span className="reflog-time">
                    {e.author} · {relativeTime(e.time)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
