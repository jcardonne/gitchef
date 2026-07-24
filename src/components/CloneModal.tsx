import { useEffect, useState } from "react";
import * as api from "../api";

/// Clone a remote repository. The user provides a URL, picks a parent folder
/// to clone into, and confirms the destination folder name (defaulted from the
/// URL). App-level: there is no repo open yet, so this keeps its own local
/// error state rather than routing through the repo bus.
function folderFromUrl(url: string): string {
  const last = url.trim().replace(/\/+$/, "").split("/").pop() ?? "";
  return last.replace(/\.git$/, "");
}

export default function CloneModal({
  onSubmit,
  onClose,
}: {
  onClose: () => void;
  onSubmit: (url: string, dest: string) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const [folder, setFolder] = useState("");
  const [folderEdited, setFolderEdited] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onUrlChange = (v: string) => {
    setUrl(v);
    if (!folderEdited) setFolder(folderFromUrl(v));
  };

  const browse = async () => {
    try {
      const dir = await api.pickRepoFolder("Choose where to clone");
      if (dir) setParent(dir);
    } catch (e) {
      setError(String(e));
    }
  };

  const valid = url.trim() !== "" && parent !== "" && folder.trim() !== "";

  const submit = async () => {
    if (!valid || busy) return;
    setError("");
    setBusy(true);
    try {
      await onSubmit(url.trim(), `${parent}/${folder.trim()}`);
    } catch (e) {
      // Clone failed (bad URL, auth, offline, dest exists): show it, stay open.
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal pr-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Clone a repository</h3>
        <label className="pr-field">
          <span>Repository URL</span>
          <input
            autoFocus
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="https://github.com/owner/repo.git"
          />
        </label>
        <label className="pr-field">
          <span>Clone into</span>
          <div className="clone-parent-row">
            <input readOnly value={parent} placeholder="Choose a parent folder" />
            <button onClick={() => void browse()}>Browse…</button>
          </div>
        </label>
        <label className="pr-field">
          <span>Folder name</span>
          <input
            value={folder}
            onChange={(e) => {
              setFolderEdited(true);
              setFolder(e.target.value);
            }}
            placeholder="repo"
          />
        </label>
        {error && <div className="clone-error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary-btn" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? "Cloning…" : "Clone"}
          </button>
        </div>
      </div>
    </div>
  );
}
