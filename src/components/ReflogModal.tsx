import { useEffect, useState } from "react";
import * as api from "../api";
import type { ReflogNode } from "../types";
import { relativeTime } from "../util";

/// Browse the HEAD reflog and jump back to any entry - the safety net beyond the
/// one-level Undo. Checkout detaches at the entry; Reset --hard moves the current
/// branch there (its own confirm lives in the RepoView handler).
export default function ReflogModal({
  repoPath,
  onCheckout,
  onReset,
  onClose,
}: {
  repoPath: string;
  onCheckout: (sha: string) => void;
  onReset: (sha: string) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<ReflogNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.reflog(repoPath).then(
      (e) => alive && setEntries(e),
      (err) => alive && setError(String(err))
    );
    return () => {
      alive = false;
    };
  }, [repoPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="reflog-modal" onClick={(e) => e.stopPropagation()}>
        <h3>HEAD reflog</h3>
        {error ? (
          <div className="reflog-empty">{error}</div>
        ) : entries === null ? (
          <div className="reflog-empty">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="reflog-empty">No reflog entries.</div>
        ) : (
          <div className="reflog-list">
            {entries.map((e, i) => (
              // Shas repeat as HEAD moves back and forth, so index is the stable key.
              <div key={i} className="reflog-item">
                <div className="reflog-item-info">
                  <span className="reflog-sha">{e.short_id}</span>
                  <span className="reflog-msg" title={e.message}>
                    {e.message}
                  </span>
                  <span className="reflog-time">{relativeTime(e.time)}</span>
                </div>
                <div className="reflog-item-actions">
                  <button
                    onClick={() => {
                      onClose();
                      onCheckout(e.id);
                    }}
                  >
                    Checkout
                  </button>
                  <button
                    onClick={() => {
                      onClose();
                      onReset(e.id);
                    }}
                  >
                    Reset --hard
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
