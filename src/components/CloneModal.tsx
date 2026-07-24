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
        <div className="clone-head">
          <h3>Clone a repository</h3>
          <button className="clone-close" onClick={onClose} aria-label="Close">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>

        <div className="clone-tabs" role="tablist">
          <button className={`clone-tab${tab === "github" ? " active" : ""}`} onClick={() => { setTab("github"); setFilter(""); }}>GitHub</button>
          <button className={`clone-tab${tab === "gitlab" ? " active" : ""}`} onClick={() => { setTab("gitlab"); setFilter(""); }}>GitLab</button>
          <button className={`clone-tab${tab === "url" ? " active" : ""}`} onClick={() => setTab("url")}>Paste URL</button>
        </div>

        {tab === "url" ? (
          <div className="clone-url-wrap">
            <span className="clone-url-label">Repository URL</span>
            <input
              autoFocus
              value={url}
              onChange={(e) => setUrlAndFolder(e.target.value)}
              placeholder="https://github.com/owner/repo.git"
            />
          </div>
        ) : (
          <>
            <div className="clone-search">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4.5" /><path d="M11 11l3 3" strokeLinecap="round" /></svg>
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={`Filter your ${tab === "github" ? "GitHub" : "GitLab"} repositories…`}
              />
            </div>
            <div className="clone-repo-list">
              {loading && <div className="clone-empty">Loading repositories…</div>}
              {!loading && listError && (
                <div className="clone-empty">
                  {listError}
                  <div>
                    Sign in with <code>{tab === "github" ? "gh auth login" : "glab auth login"}</code>.
                  </div>
                </div>
              )}
              {!loading && !listError && filtered.length === 0 && (
                <div className="clone-empty">{repos && repos.length ? "No matching repository." : "No repositories to show."}</div>
              )}
              {!loading &&
                !listError &&
                filtered.map((r) => {
                  const cut = r.name.lastIndexOf("/");
                  const owner = cut >= 0 ? r.name.slice(0, cut + 1) : "";
                  const short = cut >= 0 ? r.name.slice(cut + 1) : r.name;
                  return (
                    <button
                      key={r.url}
                      className={`clone-repo-row${url === r.url ? " selected" : ""}`}
                      title={`${r.url}\nDouble-click to clone`}
                      onClick={() => setUrlAndFolder(r.url)}
                      onDoubleClick={() => quickClone(r)}
                    >
                      <span className="clone-repo-info">
                        <span className="clone-repo-name">
                          {owner && <span className="owner">{owner}</span>}
                          {short}
                        </span>
                        {r.description && <span className="clone-repo-desc">{r.description}</span>}
                      </span>
                      <span className="clone-repo-tags">
                        {r.private && <span className="clone-tag">private</span>}
                        {r.fork && <span className="clone-tag">fork</span>}
                      </span>
                    </button>
                  );
                })}
            </div>
          </>
        )}

        <div className="clone-foot">
          <div className="clone-dest">
            <span className="clone-dest-label">Clone into</span>
            <div className="clone-dest-field">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h5.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" strokeLinejoin="round" /></svg>
              <button className="clone-dest-parent" title="Change folder" onClick={() => void browse()}>
                {parent || "Choose a folder…"}
              </button>
              <span className="clone-dest-sep">/</span>
              <input
                value={folder}
                onChange={(e) => {
                  setFolderEdited(true);
                  setFolder(e.target.value);
                }}
                placeholder="repo"
              />
            </div>
          </div>
          {error && <div className="clone-error">{error}</div>}
          <div className="modal-actions">
            <button onClick={onClose}>Cancel</button>
            <button className="primary-btn" disabled={!valid || busy} onClick={submit}>
              {busy ? "Cloning…" : "Clone"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
