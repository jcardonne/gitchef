import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import * as api from "../api";
import { RepoContext } from "../repoContext";
import type { PullAction } from "../storage";
import type {
  BranchInfo,
  CommitNode,
  FileDiff,
  RepoInfo,
  StatusResult,
  TagInfo,
  WorkStats,
} from "../types";
import Toolbar from "./Toolbar";
import Sidebar from "./Sidebar";
import GraphView from "./GraphView";
import StagingPanel from "./StagingPanel";
import DiffViewer from "./DiffViewer";

const EMPTY_STATUS: StatusResult = { staged: [], unstaged: [] };

interface Props {
  path: string;
  isActive: boolean;
  onLoaded: (path: string, info: RepoInfo) => void;
}

/// All the per-repository state and UI for one tab. Instances stay mounted while
/// their tab exists, so switching tabs preserves scroll + selection. Each
/// instance only talks to the backend while it is the active tab; on activation
/// it re-points the shared backend at its own path before issuing commands.
export default function RepoView({ path, isActive, onLoaded }: Props) {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [nodes, setNodes] = useState<CommitNode[]>([]);
  const [hiddenStashes, setHiddenStashes] = useState<string[]>([]);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [status, setStatus] = useState<StatusResult>(EMPTY_STATUS);
  const [workStats, setWorkStats] = useState<WorkStats | null>(null);

  const [rightTab, setRightTab] = useState<"changes" | "commit">("changes");
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<FileDiff[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  // Tracks the working-file currently shown so "Load full file" can refetch it.
  const [workSel, setWorkSel] = useState<{ path: string; staged: boolean } | null>(null);

  const [busy, setBusy] = useState(false);
  const [graphLimit, setGraphLimit] = useState(500);
  const [searchOpen, setSearchOpen] = useState(false);
  const [toast, setToast] = useState<{ msg: string; error: boolean } | null>(null);
  const [namePrompt, setNamePrompt] = useState<{
    title: string;
    placeholder: string;
    onSubmit: (value: string) => void;
    initial?: string;
    cta?: string;
  } | null>(null);
  const askName = (
    title: string,
    placeholder: string,
    onSubmit: (value: string) => void,
    opts?: { initial?: string; cta?: string }
  ) => setNamePrompt({ title, placeholder, onSubmit, ...opts });

  const loadedRef = useRef(false);
  const toastTimer = useRef<number | undefined>(undefined);

  // Info toasts auto-dismiss after 4s; error toasts persist (long git messages
  // need reading + copying) until the user closes them.
  const notify = useCallback((msg: string, error = false) => {
    setToast({ msg, error });
    window.clearTimeout(toastTimer.current);
    if (!error) toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // Cmd/Ctrl+F opens the commit search (active tab only).
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive]);

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        notify(String(e), true);
      } finally {
        setBusy(false);
      }
    },
    [notify]
  );

  const refresh = useCallback(async () => {
    const [s, g, b, t, w] = await Promise.all([
      api.repoStatus(path),
      api.commitGraph(path, graphLimit),
      api.listBranches(path),
      api.listTags(path),
      api.workStats(path),
    ]);
    setStatus(s);
    setNodes(g);
    setBranches(b);
    setTags(t);
    setWorkStats(w);
  }, [path, graphLimit]);

  // Load another page of commits into the graph (search beyond the window).
  const loadMore = () =>
    run(async () => {
      const next = graphLimit + 500;
      setGraphLimit(next);
      setNodes(await api.commitGraph(path, next));
    });

  // Load repo data on first activation (lazy: background tabs never hit the
  // backend until focused). `path`/`refresh`/`onLoaded` are intentionally NOT in
  // the deps - they're stable for a given tab and `loadedRef` guards re-loads, so
  // we only want this to fire when the tab becomes active.
  useEffect(() => {
    if (!isActive) return;
    let alive = true;
    (async () => {
      try {
        const info = await api.openRepo(path);
        if (!alive) return;
        setRepo(info);
        onLoaded(path, info);
        if (!loadedRef.current) {
          await refresh();
          loadedRef.current = true;
        }
      } catch (e) {
        notify(String(e), true);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // Edits often happen in an external editor while GitChef is in the background.
  // Refresh a loaded active tab when it becomes visible/focused again.
  useEffect(() => {
    if (!isActive) return;
    let inFlight = false;

    const refreshVisibleRepo = () => {
      if (!loadedRef.current || document.visibilityState === "hidden" || inFlight) return;
      inFlight = true;
      refresh()
        .catch((e) => notify(String(e), true))
        .finally(() => {
          inFlight = false;
        });
    };

    refreshVisibleRepo();
    window.addEventListener("focus", refreshVisibleRepo);
    document.addEventListener("visibilitychange", refreshVisibleRepo);
    return () => {
      window.removeEventListener("focus", refreshVisibleRepo);
      document.removeEventListener("visibilitychange", refreshVisibleRepo);
    };
  }, [isActive, notify, refresh]);

  const closeDiff = () => {
    setDiff(null);
    setSelectedPath(null);
    setWorkSel(null);
  };

  // Focus the uncommitted-changes view (clicking the WIP node atop the graph).
  const selectWork = () => {
    setSelectedCommit(null);
    setCommitFiles([]);
    setRightTab("changes");
  };

  const selectCommit = (id: string) => {
    // Re-clicking the selected commit deselects it and closes its file list.
    if (selectedCommit === id) {
      setSelectedCommit(null);
      setCommitFiles([]);
      setSelectedPath(null);
      setDiff(null);
      setRightTab("changes");
      return;
    }
    run(async () => {
      setSelectedCommit(id);
      setRightTab("commit");
      setSelectedPath(null);
      setDiff(null);
      setCommitFiles(await api.commitDiff(path, id));
    });
  };

  const selectWorkingFile = (p: string, staged: boolean) => {
    // Re-clicking the file that's already previewed closes the preview. Compared
    // against workSel (set synchronously) so it works even while the diff loads.
    if (workSel && workSel.path === p && workSel.staged === staged) {
      closeDiff();
      return;
    }
    setSelectedPath(p);
    setWorkSel({ path: p, staged });
    run(async () => {
      setDiff(await api.fileDiff(path, p, staged));
    });
  };

  const selectCommitFile = (file: FileDiff) => {
    if (diff && !workSel && selectedPath === file.path) {
      closeDiff();
      return;
    }
    setSelectedPath(file.path);
    setWorkSel(null);
    setDiff(file);
  };

  const loadFullDiff = () =>
    run(async () => {
      if (!workSel) return;
      setDiff(await api.fileDiff(path, workSel.path, workSel.staged, true));
    });

  const onCommit = (message: string) =>
    run(async () => {
      const sha = await api.commit(path, message);
      notify(`Committed ${sha.slice(0, 7)}`);
      setRightTab("changes");
      await refresh();
    });

  // Re-read RepoInfo (HEAD may have moved) and reload all repo data. Used after
  // any operation that can change the branch or history.
  const reload = async () => {
    setRepo(await api.openRepo(path));
    await refresh();
  };

  const onCheckout = (name: string) =>
    run(async () => void (await api.checkout(path, name), await reload()));

  const onCheckoutTag = (name: string) =>
    run(async () => {
      await api.checkout(path, name); // detaches HEAD at the tag
      await reload();
      notify(`Checked out tag ${name} (detached HEAD)`);
    });

  const onCreateBranch = (name: string) =>
    run(async () => {
      await api.createBranch(path, name, true);
      await reload();
      notify(`Created and switched to ${name}`);
    });

  const onMerge = (name: string) =>
    run(async () => {
      const out = await api.merge(path, name);
      await reload();
      notify(out.trim() || `Merged ${name}`);
    });

  const onPullAction = (action: PullAction) =>
    run(async () => {
      if (action === "fetch") {
        await api.fetchRemotes(path);
        await refresh();
        notify("Fetched from remotes");
      } else {
        const out = await api.pull(path, action);
        await reload();
        notify(out.trim() || "Pulled");
      }
    });
  const onPush = () =>
    run(async () => {
      await api.push(path);
      await refresh();
      notify("Pushed");
    });

  // --- commit context-menu actions ---
  const headBranch = branches.find((b) => b.is_head)?.name ?? "HEAD";

  const checkoutCommit = (sha: string) =>
    run(async () => {
      await api.checkout(path, sha);
      await reload();
      notify("Checked out commit (detached HEAD)");
    });
  const branchAt = (name: string, sha: string) =>
    run(async () => {
      await api.createBranchAt(path, name, sha, true);
      await reload();
      notify(`Created and switched to ${name}`);
    });
  const tagAt = (name: string, sha: string, annotated: boolean) =>
    run(async () => {
      await api.createTagAt(path, name, sha, annotated, annotated ? name : null);
      await refresh();
      notify(`Tagged ${name}`);
    });
  const cherryPick = (sha: string) =>
    run(async () => {
      const out = await api.cherryPick(path, sha);
      await reload();
      notify(out.trim() || "Cherry-picked");
    });
  const revertCommit = (sha: string) =>
    run(async () => {
      const ok = await confirm("Revert this commit? Creates a new commit undoing its changes.", {
        title: "Revert commit",
        kind: "warning",
      });
      if (!ok) return;
      const out = await api.revertCommit(path, sha);
      await reload();
      notify(out.trim() || "Reverted");
    });
  const resetTo = (sha: string, mode: "soft" | "mixed" | "hard") =>
    run(async () => {
      if (mode === "hard") {
        const ok = await confirm("Hard reset discards all uncommitted changes. Continue?", {
          title: "Reset --hard",
          kind: "warning",
        });
        if (!ok) return;
      }
      await api.resetTo(path, sha, mode);
      await reload();
      notify(`Reset (${mode}) to ${sha.slice(0, 7)}`);
    });
  const compareWorkdir = (sha: string) =>
    run(async () => {
      const files = await api.compareWorkdir(path, sha);
      setSelectedCommit(sha);
      setRightTab("commit");
      setSelectedPath(null);
      setDiff(null);
      setCommitFiles(files);
      notify("Comparing commit vs working directory");
    });
  const createCommitPatch = (sha: string) =>
    run(async () => {
      const dest = await save({
        defaultPath: `${sha.slice(0, 7)}.patch`,
        filters: [{ name: "Patch", extensions: ["patch"] }],
      });
      if (!dest) return;
      await api.saveCommitPatch(path, sha, dest);
      notify("Patch saved");
    });

  // --- stash node actions ---
  const stashApply = (sha: string) =>
    run(async () => {
      const out = await api.stashApply(path, sha);
      await reload();
      notify(out.trim() || "Stash applied");
    });
  const stashPop = (sha: string) =>
    run(async () => {
      const out = await api.stashPop(path, sha);
      await reload();
      notify(out.trim() || "Stash popped");
    });
  const stashDrop = (sha: string) =>
    run(async () => {
      const ok = await confirm("Delete this stash? This cannot be undone.", {
        title: "Delete stash",
        kind: "warning",
      });
      if (!ok) return;
      await api.stashDrop(path, sha);
      await reload();
      notify("Stash deleted");
    });
  const stashEdit = (sha: string, message: string) =>
    run(async () => {
      await api.stashEditMessage(path, sha, message);
      await reload();
      notify("Stash message updated");
    });
  // Hide is view-only and session-scoped: a refresh brings the stash back.
  const hideStash = (sha: string) => {
    setHiddenStashes((prev) => (prev.includes(sha) ? prev : [...prev, sha]));
    notify("Stash hidden (reopen to show)");
  };

  const showStashMenu = async (node: CommitNode) => {
    const sha = node.id;
    const items = await Promise.all([
      MenuItem.new({ text: "Apply Stash", action: () => stashApply(sha) }),
      MenuItem.new({ text: "Pop Stash", action: () => stashPop(sha) }),
      MenuItem.new({ text: "Delete Stash", action: () => stashDrop(sha) }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({
        text: "Edit stash message…",
        action: () =>
          askName("Edit stash message", "stash message", (m) => stashEdit(sha, m), {
            initial: node.summary,
            cta: "Save",
          }),
      }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: "Hide", action: () => hideStash(sha) }),
    ]);
    await (await Menu.new({ items })).popup();
  };

  const showCommitMenu = async (node: CommitNode) => {
    if (node.refs.some((r) => r.kind === "stash")) return showStashMenu(node);
    const sha = node.id;
    const short = node.short_id;
    const items = await Promise.all([
      MenuItem.new({ text: "Checkout commit", action: () => checkoutCommit(sha) }),
      MenuItem.new({
        text: "Create branch here…",
        action: () => askName(`Branch at ${short}`, "branch-name", (n) => branchAt(n, sha)),
      }),
      MenuItem.new({
        text: "Create tag here…",
        action: () => askName(`Tag at ${short}`, "tag-name", (n) => tagAt(n, sha, false)),
      }),
      MenuItem.new({
        text: "Create annotated tag here…",
        action: () => askName(`Annotated tag at ${short}`, "tag-name", (n) => tagAt(n, sha, true)),
      }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: "Cherry-pick commit", action: () => cherryPick(sha) }),
      MenuItem.new({ text: "Revert commit", action: () => revertCommit(sha) }),
      Submenu.new({
        text: `Reset ${headBranch} to here`,
        items: await Promise.all([
          MenuItem.new({ text: "Soft (keep changes staged)", action: () => resetTo(sha, "soft") }),
          MenuItem.new({ text: "Mixed (keep changes unstaged)", action: () => resetTo(sha, "mixed") }),
          MenuItem.new({ text: "Hard (discard changes)", action: () => resetTo(sha, "hard") }),
        ]),
      }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: "Compare against working directory", action: () => compareWorkdir(sha) }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: "Copy commit SHA", action: () => run(async () => (await api.copyText(sha), notify("SHA copied"))) }),
      MenuItem.new({
        text: "Copy commit message",
        action: () => run(async () => (await api.copyText(node.summary), notify("Message copied"))),
      }),
      MenuItem.new({ text: "Create patch from commit…", action: () => createCommitPatch(sha) }),
    ]);
    await (await Menu.new({ items })).popup();
  };

  // While inspecting a commit's files: ↑/↓ move between files, Escape deselects.
  useEffect(() => {
    if (!isActive || rightTab !== "commit" || commitFiles.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") {
        if (selectedCommit) selectCommit(selectedCommit); // toggles selection off
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const idx = commitFiles.findIndex((f) => f.path === selectedPath);
      const next =
        idx === -1
          ? e.key === "ArrowDown"
            ? 0
            : commitFiles.length - 1
          : e.key === "ArrowDown"
          ? Math.min(idx + 1, commitFiles.length - 1)
          : Math.max(idx - 1, 0);
      selectCommitFile(commitFiles[next]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, rightTab, commitFiles, selectedPath, selectedCommit]);

  const repoActions = useMemo(
    () => ({ repoPath: path, busy, run, refresh, notify }),
    [path, busy, run, refresh, notify]
  );

  if (!repo) {
    return <div className="repo-loading empty-hint">Loading {path}…</div>;
  }

  return (
    <RepoContext.Provider value={repoActions}>
      <Toolbar
        repo={repo}
        busy={busy}
        branches={branches}
        onCheckout={onCheckout}
        onPullAction={onPullAction}
        onPush={onPush}
        onNewBranch={() => askName("New branch", "branch-name", onCreateBranch)}
      />

      <div className="main">
        <Sidebar
          branches={branches}
          tags={tags}
          selectedCommit={selectedCommit}
          onCheckout={onCheckout}
          onMerge={onMerge}
          onSelectTag={selectCommit}
          onCheckoutTag={onCheckoutTag}
        />

        <div className={`center${diff ? " has-diff" : ""}`}>
          {diff && (
            <div className="center-diff">
              <button
                className="mini-btn center-diff-close"
                onClick={closeDiff}
                title="Close diff"
              >
                ✕
              </button>
              <DiffViewer diff={diff} onLoadFull={workSel ? loadFullDiff : undefined} />
            </div>
          )}
          <div className="center-graph">
            <GraphView
              nodes={
                hiddenStashes.length
                  ? nodes.filter(
                      (n) =>
                        !(hiddenStashes.includes(n.id) && n.refs.some((r) => r.kind === "stash"))
                    )
                  : nodes
              }
              selectedId={selectedCommit}
              onSelect={selectCommit}
              onCommitMenu={showCommitMenu}
              workStats={workStats}
              workActive={rightTab === "changes" && !selectedCommit}
              onSelectWork={selectWork}
              searchOpen={searchOpen}
              onSearchClose={() => setSearchOpen(false)}
              canLoadMore={nodes.length >= graphLimit}
              onLoadMore={loadMore}
            />
          </div>
        </div>

        <div className="right">
          <div className="right-tabs">
            <button
              className={rightTab === "changes" ? "active" : ""}
              onClick={() => setRightTab("changes")}
            >
              Changes ({status.staged.length + status.unstaged.length})
            </button>
            <button
              className={rightTab === "commit" ? "active" : ""}
              disabled={!selectedCommit}
              onClick={() => setRightTab("commit")}
            >
              Commit
            </button>
          </div>

          <div className="right-body">
            {rightTab === "changes" ? (
              <StagingPanel
                status={status}
                onSelectFile={selectWorkingFile}
                onCommit={onCommit}
              />
            ) : (
              <div className="commit-files">
                {commitFiles.length === 0 && <div className="empty-hint">No file changes.</div>}
                {commitFiles.map((f) => (
                  <div
                    key={f.path}
                    ref={(el) => {
                      if (el && selectedPath === f.path) el.scrollIntoView({ block: "nearest" });
                    }}
                    className={`file-row${selectedPath === f.path ? " selected" : ""}`}
                    onClick={() => selectCommitFile(f)}
                  >
                    <span className="file-path">{f.path}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {toast && (
        <div className={`toast${toast.error ? " toast-error" : ""}`}>
          <span className="toast-msg">{toast.msg}</span>
          {toast.error && (
            <div className="toast-actions">
              <button onClick={() => run(async () => (await api.copyText(toast.msg), notify("Copied")))}>
                Copy
              </button>
              <button onClick={() => setToast(null)}>Close</button>
            </div>
          )}
        </div>
      )}

      {namePrompt && (
        <NamePromptModal
          title={namePrompt.title}
          placeholder={namePrompt.placeholder}
          onSubmit={namePrompt.onSubmit}
          onClose={() => setNamePrompt(null)}
          initial={namePrompt.initial}
          cta={namePrompt.cta}
        />
      )}
    </RepoContext.Provider>
  );
}

/// A single-text-field modal used for "new branch", "tag here", etc.
function NamePromptModal({
  title,
  placeholder,
  onSubmit,
  onClose,
  initial,
  cta,
}: {
  title: string;
  placeholder: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
  initial?: string;
  cta?: string;
}) {
  const [value, setValue] = useState(initial ?? "");
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onClose();
    onSubmit(v);
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <input
          autoFocus
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary-btn" disabled={!value.trim()} onClick={submit}>
            {cta ?? "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
