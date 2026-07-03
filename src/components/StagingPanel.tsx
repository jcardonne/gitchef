import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import * as api from "../api";
import type { FileStatus, StatusResult } from "../types";
import { getChangesView, setChangesView, type ChangesView } from "../storage";
import { useRepo, type RefreshOpts } from "../repoContext";
import ChangeList from "./ChangeList";
import { comboHint } from "../shortcuts";
import { affectedPaths } from "../util";

/// Conventional Commits types offered by the optional prefix helper.
const COMMIT_TYPES = ["feat", "fix", "docs", "refactor", "perf", "test", "build", "ci", "chore", "style", "revert"];

interface Props {
  status: StatusResult;
  onSelectFile: (path: string, staged: boolean) => void;
  onCommit: (message: string, amend: boolean) => void;
  /// Message of the current HEAD commit, to prefill when amending. null when
  /// there's no commit to amend (unborn / detached HEAD) - hides the toggle.
  lastCommitMessage: string | null;
  isActive: boolean;
}

/// The commit composer + changes browser. Owns the List/Tree view, the
/// multi-file selection, bulk (un)stage, and the per-file right-click menu.
export default function StagingPanel({
  status,
  onSelectFile,
  onCommit,
  lastCommitMessage,
  isActive,
}: Props) {
  const { repoPath, busy, activeAction, run, refresh, notify } = useRepo();
  const [view, setView] = useState<ChangesView>(getChangesView());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  // Filter off a deferred copy of the query so each keystroke stays responsive
  // (the O(N) filter runs at React's deferred cadence, not per keystroke).
  const deferredQuery = useDeferredValue(query);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  // Optional Conventional Commits prefix. Kept separate from `message` and
  // composed at commit time, so it never fights the amend prefill.
  const [type, setType] = useState("");
  const [scope, setScope] = useState("");
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const canAmend = lastCommitMessage !== null;
  // Turning amend on prefills the last message (unless the user already typed);
  // turning it off clears that prefill again (unless the user edited it), so an
  // un-amended commit can't inherit the old message by accident.
  const toggleAmend = (on: boolean) => {
    setAmend(on);
    if (on && !message.trim() && lastCommitMessage) setMessage(lastCommitMessage);
    else if (!on && message === lastCommitMessage) setMessage("");
  };
  const [movedPaths, setMovedPaths] = useState<Set<string>>(new Set());
  const moveTimer = useRef<number>();
  // Flash files that just changed staged-state so the eye can follow the move
  // across the two lists (a true cross-list FLIP fights the virtualizer).
  const markMoved = (paths: string[]) => {
    setMovedPaths(new Set(paths));
    clearTimeout(moveTimer.current);
    moveTimer.current = window.setTimeout(() => setMovedPaths(new Set()), 650);
  };
  useEffect(() => () => clearTimeout(moveTimer.current), []);

  // Stable identity (keys never depend on closure state) so the selUnstaged/
  // selStaged memos below don't bust on every render.
  const keyOf = useCallback((f: FileStatus) => `${f.staged ? 1 : 0}${f.path}`, []);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filterFiles = (files: FileStatus[]) =>
    normalizedQuery ? files.filter((f) => f.path.toLowerCase().includes(normalizedQuery)) : files;
  const unstagedFiles = useMemo(
    () => filterFiles(status.unstaged),
    [normalizedQuery, status.unstaged]
  );
  const stagedFiles = useMemo(
    () => filterFiles(status.staged),
    [normalizedQuery, status.staged]
  );
  const hasSearch = normalizedQuery.length > 0;

  useEffect(() => {
    setSelected(new Set());
  }, [normalizedQuery]);

  const changeView = (v: ChangesView) => {
    setView(v);
    setChangesView(v);
  };

  const afterMutation = async (opts?: RefreshOpts) => {
    setSelected(new Set());
    await refresh(opts);
  };

  const stageFiles = (fs: FileStatus[]) =>
    run(async () => {
      await api.stagePaths(repoPath, affectedPaths(fs));
      await afterMutation({ history: false, stats: false });
      markMoved(fs.map((f) => f.path));
    });
  const unstageFiles = (fs: FileStatus[]) =>
    run(async () => {
      await api.unstagePaths(repoPath, affectedPaths(fs));
      await afterMutation({ history: false, stats: false });
      markMoved(fs.map((f) => f.path));
    });
  const quickToggle = (f: FileStatus) => (f.staged ? unstageFiles([f]) : stageFiles([f]));

  // Wrap a fire-and-forget file action with busy/error handling + optional toast.
  const act = (fn: () => Promise<unknown>, okMsg?: string) =>
    run(async () => {
      await fn();
      if (okMsg) notify(okMsg);
    });

  const selUnstaged = useMemo(
    () => status.unstaged.filter((f) => selected.has(keyOf(f))),
    [status.unstaged, selected, keyOf]
  );
  const selStaged = useMemo(
    () => status.staged.filter((f) => selected.has(keyOf(f))),
    [status.staged, selected, keyOf]
  );
  const allLocalFiles = useMemo(() => {
    const byPath = new Map<string, FileStatus>();
    for (const file of [...status.unstaged, ...status.staged]) byPath.set(file.path, file);
    return [...byPath.values()];
  }, [status.staged, status.unstaged]);

  // Right-clicking a file acts on the whole selection if that file is part of
  // it, otherwise on just that file.
  const contextGroup = (f: FileStatus) => {
    const sel = f.staged ? selStaged : selUnstaged;
    return sel.some((x) => x.path === f.path) ? sel : [f];
  };

  const fullPath = (f: FileStatus) => `${repoPath.replace(/\/$/, "")}/${f.path}`;
  const extPattern = (f: FileStatus) => {
    const m = f.path.match(/\.([^./]+)$/);
    return m ? `*.${m[1]}` : null;
  };
  const folderPattern = (f: FileStatus) => {
    const i = f.path.lastIndexOf("/");
    return i >= 0 ? `${f.path.slice(0, i)}/` : null;
  };

  const ignore = (pattern: string) =>
    run(async () => {
      await api.ignorePath(repoPath, pattern);
      await afterMutation({ history: false });
      notify(`Ignored ${pattern}`);
    });
  const stash = (path: string) =>
    run(async () => {
      await api.stashFile(repoPath, path);
      await afterMutation();
      notify("Stashed file");
    });
  const discard = (group: FileStatus[]) =>
    run(async () => {
      const ok = await confirm(`Discard changes to ${group.length} file(s)? This cannot be undone.`, {
        title: "Discard changes",
        kind: "warning",
      });
      if (!ok) return;
      await api.discardPaths(repoPath, affectedPaths(group));
      await afterMutation({ history: false });
    });
  const discardAllLocalChanges = () =>
    run(async () => {
      const ok = await confirm(
        `Discard all local changes to ${allLocalFiles.length} file(s)? This will also delete untracked files and cannot be undone.`,
        {
          title: "Discard all local changes",
          kind: "warning",
        }
      );
      if (!ok) return;
      if (status.staged.length) await api.unstagePaths(repoPath, affectedPaths(status.staged));
      await api.discardPaths(repoPath, affectedPaths([...status.unstaged, ...status.staged]));
      await afterMutation({ history: false });
    });
  const createPatch = (f: FileStatus) =>
    run(async () => {
      const dest = await save({
        defaultPath: `${f.path.split("/").pop()}.patch`,
        filters: [{ name: "Patch", extensions: ["patch"] }],
      });
      if (!dest) return;
      await api.savePatch(repoPath, f.path, dest);
      notify("Patch saved");
    });
  const deleteFile = (f: FileStatus) =>
    run(async () => {
      const ok = await confirm(`Delete ${f.path}? This cannot be undone.`, {
        title: "Delete file",
        kind: "warning",
      });
      if (!ok) return;
      await api.deleteFile(repoPath, f.path);
      await afterMutation({ history: false });
      notify("File deleted");
    });

  // Build and pop a NATIVE OS context menu (renders outside the webview, so it
  // never clips at the window edge). Item actions run here in JS.
  const showFileMenu = async (f: FileStatus) => {
    const group = contextGroup(f);
    const n = group.length > 1 ? ` (${group.length})` : "";

    const ignoreItems = [{ text: f.path, action: () => ignore(f.path) }];
    const ext = extPattern(f);
    if (ext) ignoreItems.push({ text: ext, action: () => ignore(ext) });
    const folder = folderPattern(f);
    if (folder) ignoreItems.push({ text: folder, action: () => ignore(folder) });

    const items = await Promise.all([
      MenuItem.new(
        f.staged
          ? { text: `Unstage${n}`, action: () => unstageFiles(group) }
          : { text: `Stage${n}`, action: () => stageFiles(group) }
      ),
      ...(f.staged ? [] : [MenuItem.new({ text: "Discard changes", action: () => discard(group) })]),
      Submenu.new({ text: "Ignore", items: await Promise.all(ignoreItems.map((i) => MenuItem.new(i))) }),
      MenuItem.new({ text: "Stash file", action: () => stash(f.path) }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: "Open in external diff tool", action: () => act(() => api.openDifftool(repoPath, f.path)) }),
      MenuItem.new({ text: "Open in external editor", action: () => act(() => api.openInEditor(repoPath, f.path)) }),
      MenuItem.new({ text: "Open file in default program", action: () => act(() => api.openDefault(repoPath, f.path)) }),
      MenuItem.new({ text: "Show in Finder", action: () => act(() => api.revealInFinder(repoPath, f.path)) }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: "Copy file path", action: () => act(() => api.copyText(fullPath(f)), "Path copied") }),
      MenuItem.new({ text: "Create patch from file changes", action: () => createPatch(f) }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: "Delete file", action: () => deleteFile(f) }),
    ]);

    const menu = await Menu.new({ items });
    await menu.popup();
  };

  // Folder right-click (tree view): bulk-act on every file in the subtree. All
  // files in one tree belong to the same section, so the staged flag is uniform.
  const showFolderMenu = async (files: FileStatus[], folderPath: string) => {
    if (files.length === 0) return;
    const staged = files[0].staged;
    const n = files.length;
    const plural = n === 1 ? "" : "s";
    const items = await Promise.all([
      staged
        ? MenuItem.new({ text: `Unstage ${n} file${plural}`, action: () => unstageFiles(files) })
        : MenuItem.new({ text: `Stage ${n} file${plural}`, action: () => stageFiles(files) }),
      ...(staged
        ? []
        : [MenuItem.new({ text: `Discard ${n} file${plural}`, action: () => discard(files) })]),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: `Ignore ${folderPath}/`, action: () => ignore(`${folderPath}/`) }),
    ]);
    await (await Menu.new({ items })).popup();
  };

  const handleCommit = () => {
    const doAmend = amend && canAmend;
    // Amend can commit a message-only change (no staged files); a normal commit
    // needs something staged.
    if (!message.trim() || (!doAmend && status.staged.length === 0)) return;
    const prefix = type ? `${type}${scope.trim() ? `(${scope.trim()})` : ""}: ` : "";
    onCommit(prefix + message, doAmend);
    setMessage("");
    setAmend(false);
    // Clear the prefix too, or it silently rides onto the next commit (and would
    // double-prefix an amend, whose message is already prefixed).
    setType("");
    setScope("");
  };

  // Keyboard: commit / stage / unstage from anywhere in the active tab (the
  // commit message + selection state live here). Modifier combos only, so they
  // never clash with typing in the message box.
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "enter") {
        e.preventDefault();
        handleCommit();
      } else if (e.shiftKey && k === "s") {
        e.preventDefault();
        stageFiles(selUnstaged.length ? selUnstaged : status.unstaged);
        messageRef.current?.focus();
      } else if (e.shiftKey && k === "u") {
        e.preventDefault();
        unstageFiles(selStaged.length ? selStaged : status.staged);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, handleCommit, stageFiles, unstageFiles, selUnstaged, selStaged, status]);

  const sectionCount = (visible: number, total: number) =>
    hasSearch ? `${visible}/${total}` : String(total);

  return (
    <div className="staging">
      <div className="changes-toolbar">
        <button
          className="discard-all-btn"
          disabled={busy || !allLocalFiles.length}
          onClick={discardAllLocalChanges}
          title="Discard all local changes"
          aria-label="Discard all local changes"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 4.5h9" />
            <path d="M6 4.5V3.2h4v1.3" />
            <path d="M5 6.5l.5 6h5l.5-6" />
            <path d="M7 7.5v3.5" />
            <path d="M9.5 7.5v3.5" />
          </svg>
        </button>
        <div className="changes-search">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4" />
            <path d="M10.2 10.2 13 13" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Search files"
          />
          {query && (
            <button
              className="changes-search-clear"
              onClick={() => setQuery("")}
              title="Clear search"
              aria-label="Clear search"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          )}
        </div>
        <div className="view-toggle">
          <button className={view === "list" ? "active" : ""} onClick={() => changeView("list")}>
            List
          </button>
          <button className={view === "tree" ? "active" : ""} onClick={() => changeView("tree")}>
            Tree
          </button>
        </div>
      </div>

      {status.unstaged.length === 0 && status.staged.length === 0 ? (
        <div className="empty-state">
          <svg width="30" height="30" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="5.7" />
            <path d="M5.5 8.2l1.7 1.7 3.3-3.5" />
          </svg>
          <div className="empty-state-title">Working tree clean</div>
          <div className="empty-state-hint">No changes to commit. Edit files and they'll show up here.</div>
        </div>
      ) : (
        <>
          <div className="staging-section">
            <div className="section-head">
              <span>Unstaged ({sectionCount(unstagedFiles.length, status.unstaged.length)})</span>
              <button
                className="mini-btn"
                disabled={!unstagedFiles.length}
                onClick={() => stageFiles(selUnstaged.length > 1 ? selUnstaged : unstagedFiles)}
                title={`Stage all or selection (${comboHint(["mod", "shift", "S"])})`}
              >
                {selUnstaged.length > 1
                  ? `Stage (${selUnstaged.length})`
                  : hasSearch
                    ? "Stage visible"
                    : "Stage all"}
              </button>
            </div>
            <ChangeList
              files={unstagedFiles}
              staged={false}
              view={view}
              selected={selected}
              keyOf={keyOf}
              onSelectionChange={setSelected}
              onShowDiff={(f) => onSelectFile(f.path, false)}
              onContext={showFileMenu}
              onFolderContext={showFolderMenu}
              onQuickToggle={quickToggle}
              recentlyMoved={movedPaths}
            />
          </div>

          <div className="staging-section">
            <div className="section-head">
              <span>Staged ({sectionCount(stagedFiles.length, status.staged.length)})</span>
              <button
                className="mini-btn"
                disabled={!stagedFiles.length}
                onClick={() => unstageFiles(selStaged.length > 1 ? selStaged : stagedFiles)}
                title={`Unstage all or selection (${comboHint(["mod", "shift", "U"])})`}
              >
                {selStaged.length > 1
                  ? `Unstage (${selStaged.length})`
                  : hasSearch
                    ? "Unstage visible"
                    : "Unstage all"}
              </button>
            </div>
            <ChangeList
              files={stagedFiles}
              staged
              view={view}
              selected={selected}
              keyOf={keyOf}
              onSelectionChange={setSelected}
              onShowDiff={(f) => onSelectFile(f.path, true)}
              onContext={showFileMenu}
              onFolderContext={showFolderMenu}
              onQuickToggle={quickToggle}
              recentlyMoved={movedPaths}
            />
          </div>
        </>
      )}

      <div className="commit-box">
        <div className="commit-type-row">
          <select value={type} onChange={(e) => setType(e.target.value)} title="Conventional Commit type (optional)">
            <option value="">type</option>
            {COMMIT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            className="commit-scope"
            placeholder="scope (optional)"
            value={scope}
            disabled={!type}
            onChange={(e) => setScope(e.target.value)}
            title="Optional scope, e.g. api"
          />
        </div>
        <textarea
          ref={messageRef}
          placeholder={`Commit message  (${comboHint(["mod", "Enter"])} to commit)`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        {canAmend && (
          <label className="amend-toggle" title="Rewrite the last commit instead of creating a new one">
            <input type="checkbox" checked={amend} onChange={(e) => toggleAmend(e.target.checked)} />
            Amend last commit
          </label>
        )}
        <button
          className="primary-btn"
          disabled={busy || !message.trim() || (!(amend && canAmend) && status.staged.length === 0)}
          onClick={handleCommit}
          title={`${amend && canAmend ? "Amend" : "Commit"} (${comboHint(["mod", "Enter"])})`}
        >
          {activeAction === "commit" && (
            <svg className="spinner" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <circle cx="8" cy="8" r="6" strokeOpacity={0.3} />
              <path d="M8 2a6 6 0 0 1 6 6" />
            </svg>
          )}
          {amend && canAmend ? "Amend" : `Commit ${status.staged.length ? `(${status.staged.length})` : ""}`}
        </button>
      </div>
    </div>
  );
}
