import { useEffect, useState } from "react";
import * as api from "../api";
import type { ForgeRepo } from "../types";
import { getCloneDir, setCloneDir } from "../storage";

type Tab = "github" | "gitlab" | "url";

/// Last path segment of a clone URL, minus a trailing `.git` - the default local
/// folder name. Works for deep GitLab group paths (…/group/sub/name.git -> name).
function folderFromUrl(url: string): string {
  const last = url.trim().replace(/\/+$/, "").split("/").pop() ?? "";
  return last.replace(/\.git$/, "");
}

/// Clone a repository. The GitHub/GitLab tabs list the signed-in user's repos via
/// the `gh`/`glab` CLIs so a click fills the URL + folder (least typing);
/// double-click clones straight away when a destination is already set. The URL
/// tab is the manual fallback. The destination parent is remembered across opens.
/// App-level (no repo open yet), so errors live in local state, not the repo bus.
export default function CloneModal({
  onSubmit,
  onClose,
}: {
  onClose: () => void;
  onSubmit: (url: string, dest: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("github");
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState(getCloneDir);
  const [folder, setFolder] = useState("");
  const [folderEdited, setFolderEdited] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  // Per-provider repo cache; null = not fetched yet (fetched on first tab view).
  const [gh, setGh] = useState<ForgeRepo[] | null>(null);
  const [gl, setGl] = useState<ForgeRepo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lazily fetch a provider's repos the first time its tab is shown.
  useEffect(() => {
    if (tab === "url") return;
    if ((tab === "github" ? gh : gl) !== null) return;
    let cancelled = false;
    setLoading(true);
    setListError("");
    api
      .listForgeRepos(tab)
      .then((repos) => !cancelled && (tab === "github" ? setGh(repos) : setGl(repos)))
      .catch((e) => !cancelled && setListError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const setUrlAndFolder = (u: string) => {
    setUrl(u);
    if (!folderEdited) setFolder(folderFromUrl(u));
  };

  const browse = async () => {
    try {
      const dir = await api.pickRepoFolder("Choose where to clone");
      if (dir) setParent(dir);
    } catch (e) {
      setError(String(e));
    }
  };

  const clone = async (u: string, dest: string) => {
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      await onSubmit(u, dest);
      setCloneDir(parent); // remember the destination for next time
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const valid = url.trim() !== "" && parent !== "" && folder.trim() !== "";
  const submit = () => valid && void clone(url.trim(), `${parent}/${folder.trim()}`);

  // Double-clicking a repo clones it immediately when a destination is already
  // set (the common repeat case); otherwise it just fills the fields.
  const quickClone = (r: ForgeRepo) => {
    setUrlAndFolder(r.url);
    const name = folderEdited && folder.trim() ? folder.trim() : folderFromUrl(r.url);
    if (parent && name && !busy) void clone(r.url.trim(), `${parent}/${name}`);
  };

  const repos = tab === "github" ? gh : gl;
  const q = filter.trim().toLowerCase();
  const filtered = (repos ?? []).filter(
    (r) => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal clone-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Clone a repository</h3>
        <div className="seg clone-tabs" role="tablist">
          <button className={tab === "github" ? "active" : ""} onClick={() => { setTab("github"); setFilter(""); }}>GitHub</button>
          <button className={tab === "gitlab" ? "active" : ""} onClick={() => { setTab("gitlab"); setFilter(""); }}>GitLab</button>
          <button className={tab === "url" ? "active" : ""} onClick={() => setTab("url")}>Paste URL</button>
        </div>

        {tab === "url" ? (
          <label className="pr-field">
            <span>Repository URL</span>
            <input
              autoFocus
              value={url}
              onChange={(e) => setUrlAndFolder(e.target.value)}
              placeholder="https://github.com/owner/repo.git"
            />
          </label>
        ) : (
          <div className="clone-picker">
            <input
              className="clone-search"
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter your ${tab === "github" ? "GitHub" : "GitLab"} repositories…`}
            />
            <div className="clone-repo-list">
              {loading && <div className="empty-hint small">Loading repositories…</div>}
              {!loading && listError && (
                <div className="clone-list-error">
                  {listError}
                  <div className="clone-hint">
                    Sign in with <code>{tab === "github" ? "gh auth login" : "glab auth login"}</code>.
                  </div>
                </div>
              )}
              {!loading && !listError && filtered.length === 0 && (
                <div className="empty-hint small">{repos && repos.length ? "No match" : "No repositories"}</div>
              )}
              {!loading &&
                !listError &&
                filtered.map((r) => (
                  <div
                    key={r.url}
                    className={`clone-repo-row${url === r.url ? " selected" : ""}`}
                    title={`${r.url}\nDouble-click to clone`}
                    onClick={() => setUrlAndFolder(r.url)}
                    onDoubleClick={() => quickClone(r)}
                  >
                    <div className="clone-repo-main">
                      <span className="clone-repo-name">{r.name}</span>
                      {r.private && <span className="clone-badge">private</span>}
                      {r.fork && <span className="clone-badge">fork</span>}
                    </div>
                    {r.description && <span className="clone-repo-desc">{r.description}</span>}
                  </div>
                ))}
            </div>
          </div>
        )}

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
        {url && (
          <div className="clone-target">
            Clone <code>{url}</code>
          </div>
        )}
        {error && <div className="clone-error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary-btn" disabled={!valid || busy} onClick={submit}>
            {busy ? "Cloning…" : "Clone"}
          </button>
        </div>
      </div>
    </div>
  );
}
