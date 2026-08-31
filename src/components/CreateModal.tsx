import { useState } from "react";
import { useEscape } from "../useEscape";
import * as api from "../api";
import { getCloneDir, setCloneDir } from "../storage";

/// Create a new repository: `git init` at a picked parent/folder, with a chosen
/// initial branch and an optional empty root commit. Mirrors CloneModal's
/// destination row (and reuses its CSS) but drops all the forge/repo-list
/// machinery - there's nothing to fetch. App-level (no repo open yet), so errors
/// live in local state, and the parent folder is remembered across opens.
export default function CreateModal({
  onSubmit,
  onClose,
}: {
  onClose: () => void;
  onSubmit: (dest: string, branch: string, initialCommit: boolean) => Promise<void>;
}) {
  const [parent, setParent] = useState(getCloneDir);
  const [folder, setFolder] = useState("");
  const [branch, setBranch] = useState("main");
  const [initialCommit, setInitialCommit] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEscape(onClose);

  const browse = async () => {
    try {
      const dir = await api.pickRepoFolder("Choose where to create");
      if (dir) setParent(dir);
    } catch (e) {
      setError(String(e));
    }
  };

  const valid = parent !== "" && folder.trim() !== "";
  const create = async () => {
    if (!valid || busy) return;
    setError("");
    setBusy(true);
    try {
      await onSubmit(`${parent}/${folder.trim()}`, branch.trim(), initialCommit);
      setCloneDir(parent); // remember the destination for next time
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal clone-modal create-modal" onClick={(e) => e.stopPropagation()}>
        <div className="clone-head">
          <h3>Create a repository</h3>
          <button className="clone-close" onClick={onClose} aria-label="Close">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>

        <div className="clone-foot">
          <div className="clone-dest">
            <span className="clone-dest-label">Create in</span>
            <div className="clone-dest-field">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h5.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" strokeLinejoin="round" /></svg>
              <button className="clone-dest-parent" title="Change folder" onClick={() => void browse()}>
                {parent || "Choose a folder…"}
              </button>
              <span className="clone-dest-sep">/</span>
              <input
                autoFocus
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="repo"
              />
            </div>
          </div>

          <div className="create-row">
            <label className="create-field">
              <span>Initial branch</span>
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
            </label>
            <label className="create-check">
              <input type="checkbox" checked={initialCommit} onChange={(e) => setInitialCommit(e.target.checked)} />
              <span>Create an initial commit</span>
            </label>
          </div>

          {error && <div className="clone-error">{error}</div>}
          <div className="modal-actions">
            <button onClick={onClose}>Cancel</button>
            <button className="primary-btn" disabled={!valid || busy} onClick={() => void create()}>
              {busy && (
                <svg className="spinner" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                  <circle cx="8" cy="8" r="6" strokeOpacity={0.3} />
                  <path d="M8 2a6 6 0 0 1 6 6" />
                </svg>
              )}
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
