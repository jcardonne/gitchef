import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import * as api from "../api";
import { RepoContext, type RefreshOpts } from "../repoContext";
import { getRightPanelWidth, setRightPanelWidth, getPullDefault } from "../storage";
import type { PullAction } from "../storage";
import type {
  BranchInfo,
  CommitNode,
  FileContent,
  FileDiff,
  RepoInfo,
  SequencerState,
  StatusResult,
  TagInfo,
  WorkStats,
  WorktreeInfo,
  StashInfo,
} from "../types";
import { affectedPaths, avatarUrl, type AvatarContext, hasUncommittedChange, relativeTime } from "../util";
import Toolbar from "./Toolbar";
import Sidebar from "./Sidebar";
import GraphView from "./GraphView";
import StagingPanel from "./StagingPanel";
import DiffViewer from "./DiffViewer";
import ConflictViewer from "./ConflictViewer";
import SequencerBanner from "./SequencerBanner";
import UndoBar from "./UndoBar";
import RebasePlan from "./RebasePlan";
import FileView from "./FileView";
import RepoSkeleton from "./RepoSkeleton";
import CommitFiles from "./CommitFiles";
import CommandPalette, { type PaletteCommand } from "./CommandPalette";

const EMPTY_STATUS: StatusResult = { staged: [], unstaged: [] };

interface Props {
  path: string;
  isActive: boolean;
  onLoaded: (path: string, info: RepoInfo) => void;
  /// Open another repo path as a tab (App-level). Used to open a worktree.
  onOpenPath: (path: string) => void;
}

/// All the per-repository state and UI for one tab. Instances stay mounted while
/// their tab exists, so switching tabs preserves scroll + selection. Each
/// instance only talks to the backend while it is the active tab; on activation
/// it re-points the shared backend at its own path before issuing commands.
export default function RepoView({ path, isActive, onLoaded, onOpenPath }: Props) {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [nodes, setNodes] = useState<CommitNode[]>([]);
  const [hiddenStashes, setHiddenStashes] = useState<string[]>([]);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [stashes, setStashes] = useState<StashInfo[]>([]);
  const [wips, setWips] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<StatusResult>(EMPTY_STATUS);
  const [workStats, setWorkStats] = useState<WorkStats | null>(null);
  // A paused rebase/merge/cherry-pick/revert (null = clean tree), driving the
  // banner. `rebasePlanBase` opens the interactive-rebase plan modal.
  const [seq, setSeq] = useState<SequencerState | null>(null);
  const [rebasePlanBase, setRebasePlanBase] = useState<{
    base: string;
    label: string;
    undo?: { sha: string; branch: string };
  } | null>(null);
  // The last HEAD-moving op, for one-level Undo (reset --hard back to `sha`, the
  // HEAD captured before the op). `branch` scopes it: the bar only shows while
  // still on that branch, so Undo can't hard-reset a DIFFERENT branch you've
  // since switched to. Persists until replaced, undone, or dismissed.
  const [undoState, setUndoState] = useState<{ label: string; sha: string; branch: string } | null>(
    null
  );

  const [rightTab, setRightTab] = useState<"changes" | "commit">("changes");
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<FileDiff[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const selectedCommitNode = useMemo(
    () => nodes.find((n) => n.id === selectedCommit) ?? null,
    [nodes, selectedCommit]
  );
  // Tracks the working-file currently shown so "Load full file" can refetch it.
  const [workSel, setWorkSel] = useState<{ path: string; staged: boolean } | null>(null);

  // The preview pane shows either the unified diff or the whole file. The mode
  // is sticky across file selections; `fileContent` is loaded lazily in "file"
  // mode. `compareMode` records that the open commit-file list came from a
  // "compare with working directory" - so its File view reads the workdir (the
  // diff's right-hand side), not the commit's blob.
  const [previewMode, setPreviewMode] = useState<"diff" | "file">("diff");
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [compareMode, setCompareMode] = useState(false);

  const [busy, setBusy] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [graphLimit, setGraphLimit] = useState(500);
  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [rightWidth, setRightWidth] = useState(getRightPanelWidth);
  const [selectedCommitAvatar, setSelectedCommitAvatar] = useState<string | null>(null);
  const [accountAvatars, setAccountAvatars] = useState<ReadonlyMap<string, string>>(new Map());
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
  // Monotonic request ids: a slower response for an earlier selection must never
  // clobber the state of a newer one (rapid commit/file clicks).
  const commitReq = useRef(0);
  const fileReq = useRef(0);
  const statsReq = useRef(0);
  const rightRef = useRef<HTMLDivElement>(null);

  // Info toasts auto-dismiss after 4s; error toasts persist (long git messages
  // need reading + copying) until the user closes them.
  const notify = useCallback((msg: string, error = false) => {
    setToast({ msg, error });
    window.clearTimeout(toastTimer.current);
    if (!error) toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // Provider account avatars (GitHub/GitLab profile pictures) for the committers
  // in view, resolved by the backend (cached on disk) and merged in as they
  // arrive - upgrading the no-reply/Gravatar fallbacks. Skipped for repos whose
  // remote isn't a known provider.
  useEffect(() => {
    if (repo?.provider !== "github" && repo?.provider !== "gitlab") return;
    const emails = [...new Set(nodes.map((n) => n.email).filter(Boolean))];
    if (emails.length === 0) return;
    let alive = true;
    api.commitAvatars(path, emails).then(
      (map) => {
        if (alive && Object.keys(map).length) {
          setAccountAvatars((prev) => new Map([...prev, ...Object.entries(map)]));
        }
      },
      () => {} // avatars are best-effort; a failed lookup just leaves the fallback
    );
    return () => {
      alive = false;
    };
  }, [path, repo?.provider, nodes]);

  // Stable ctx identity so the avatar effects only re-run when the resolved
  // account map actually changes.
  const avatarCtx = useMemo<AvatarContext>(() => ({ accounts: accountAvatars }), [accountAvatars]);

  useEffect(() => {
    let alive = true;
    setSelectedCommitAvatar(null);
    if (!selectedCommitNode?.email) return;
    avatarUrl(selectedCommitNode.email, avatarCtx).then((url) => {
      if (alive) setSelectedCommitAvatar(url);
    });
    return () => {
      alive = false;
    };
  }, [selectedCommitNode?.email, avatarCtx]);

  // Cmd/Ctrl+F opens commit search; Cmd/Ctrl+K opens the command palette (active
  // tab only).
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === "f") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (k === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive]);

  const run = useCallback(
    async (fn: () => Promise<void>, action?: string) => {
      setBusy(true);
      setActiveAction(action ?? null);
      try {
        await fn();
      } catch (e) {
        notify(String(e), true);
      } finally {
        setBusy(false);
        setActiveAction(null);
      }
    },
    [notify]
  );

  // Background, stale-guarded work-tree stats. The +ins/-del/files counts require
  // diffing every changed file's content (inherently O(changed lines)), so they
  // are fetched OFF the awaited refresh: the file list paints immediately and the
  // counts fill in when ready. The backend command is async (runs off the main
  // thread); the id guard drops a slow earlier result.
  const refreshStats = useCallback(() => {
    const id = ++statsReq.current;
    api
      .workStats(path)
      .then((w) => {
        if (statsReq.current === id) setWorkStats(w);
      })
      .catch(() => {});
  }, [path]);

  // One refresh for all mutations. Status always reloads (it's what staging
  // changes). `history` (commit graph + branches + tags) and `stats` default on
  // but are skipped for working-tree-only changes that can't alter them - e.g.
  // stage/unstage move nothing in HEAD and leave the uncommitted line totals
  // unchanged - so the graph isn't re-walked + re-rendered on every stage.
  // Status + history fetch concurrently; status resolves first so the file list
  // paints without waiting on the walk.
  const refresh = useCallback(
    async (opts?: RefreshOpts) => {
      const withHistory = opts?.history ?? true;
      const withStats = opts?.stats ?? true;
      const statusP = api.repoStatus(path);
      const historyP = withHistory
        ? Promise.all([
            api.commitGraph(path, graphLimit),
            api.listBranches(path),
            api.listTags(path),
          ])
        : null;
      const s = await statusP;
      setStatus(s);
      // Cheap (a few .git file checks); always refreshed so the banner appears
      // after an op and clears the moment the last conflict is staged.
      api.sequencerState(path).then(setSeq).catch(() => {});
      if (historyP) {
        const [g, b, t] = await historyP;
        setNodes(g);
        setBranches(b);
        setTags(t);
        // Worktrees/stashes load off the awaited path: list_worktrees shells out
        // to the git CLI, so a CLI failure must degrade only those two sections,
        // never blank the graph/branches/tags (which would also block retry).
        api.listWorktrees(path).then(setWorktrees).catch(() => {});
        api.listStashes(path).then(setStashes).catch(() => {});
      }
      if (withStats) refreshStats();
      return s;
    },
    [path, graphLimit, refreshStats]
  );

  // Per-worktree dirty ("WIP") indicators are an opt-in scan: each worktree is
  // opened and status-walked, so this runs on demand (first load + the sidebar
  // "refresh WIPs" button + after adding a worktree), never on the hot path.
  const refreshWips = useCallback(() => api.worktreeWips(path).then(setWips), [path]);

  // Load another page of commits into the graph (search beyond the window).
  const loadMore = () =>
    run(async () => {
      const next = graphLimit + 500;
      setGraphLimit(next);
      setNodes(await api.commitGraph(path, next));
    });

  useEffect(() => setRightPanelWidth(rightWidth), [rightWidth]);

  const startRightResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightWidth;
    const maxW = Math.max(340, window.innerWidth - 560);
    let w = startW;
    // Write the width straight to the DOM during the drag so we don't re-render
    // the whole tab (and the change list) on every mousemove; commit to React
    // state once on release (the effect above then persists it).
    const move = (ev: MouseEvent) => {
      w = Math.min(maxW, Math.max(320, startW - (ev.clientX - startX)));
      if (rightRef.current) rightRef.current.style.width = `${w}px`;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setRightWidth(w);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

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
          refreshWips().catch(() => {});
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
    let timer: number | undefined;
    // Coalesce focus + visibilitychange bursts into a single trailing refresh.
    // Status-only (no work_stats) on this auto path: external edits update the
    // file list promptly; the +/- counts catch up on the next explicit action.
    const schedule = () => {
      if (!loadedRef.current || document.visibilityState === "hidden") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        refresh({ stats: false }).catch((e) => notify(String(e), true));
      }, 200);
    };
    schedule();
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [isActive, notify, refresh]);

  const closeDiff = () => {
    setDiff(null);
    setSelectedPath(null);
    setWorkSel(null);
    setFileContent(null);
  };

  // Focus the uncommitted-changes view (clicking the WIP node atop the graph).
  const selectWork = () => {
    setSelectedCommit(null);
    setCommitFiles([]);
    setRightTab("changes");
    setCompareMode(false);
  };

  const selectCommit = (id: string) => {
    setCompareMode(false);
    // Re-clicking the selected commit deselects it and closes its file list.
    if (selectedCommit === id) {
      setSelectedCommit(null);
      setCommitFiles([]);
      setSelectedPath(null);
      setDiff(null);
      setRightTab("changes");
      return;
    }
    const req = ++commitReq.current;
    run(async () => {
      setSelectedCommit(id);
      setRightTab("commit");
      setSelectedPath(null);
      setDiff(null);
      const files = await api.commitDiff(path, id);
      if (commitReq.current === req) setCommitFiles(files);
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
    const req = ++fileReq.current;
    run(async () => {
      const d = await api.fileDiff(path, p, staged);
      if (fileReq.current === req) setDiff(d);
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

  // The "after" side the File view shows, mirroring the diff: a working file ->
  // its staged blob or the working tree; a commit file -> that commit's blob,
  // unless we're comparing against the working directory (then the workdir).
  const fileContentSource = useCallback((): { rev: string | null; staged: boolean } => {
    if (workSel) return { rev: null, staged: workSel.staged };
    return { rev: compareMode ? null : selectedCommit, staged: false };
  }, [workSel, compareMode, selectedCommit]);

  // Load whole-file content lazily whenever the File view is active and the
  // selection changes. Cancellation guards against a slow load landing after
  // the user has already moved on to another file.
  useEffect(() => {
    if (previewMode !== "file" || !selectedPath) return;
    const { rev, staged } = fileContentSource();
    let cancelled = false;
    run(async () => {
      const c = await api.fileContent(path, selectedPath, rev, staged);
      if (!cancelled) setFileContent(c);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, selectedPath, workSel, selectedCommit, compareMode]);

  const loadFullFile = () =>
    run(async () => {
      if (!selectedPath) return;
      const { rev, staged } = fileContentSource();
      setFileContent(await api.fileContent(path, selectedPath, rev, staged, true));
    });

  const onCommit = (message: string, amend: boolean) =>
    run(async () => {
      // Remember which working file (if any) the diff preview is showing, so we
      // can drop it when this commit absorbs that file.
      const previewedPath = workSel?.path ?? null;
      const sha = amend ? await api.commitAmend(path, message) : await api.commit(path, message);
      // A commit/amend moves HEAD, so the previous op's Undo (a reset back to
      // before it) would now silently discard this commit - retire it.
      setUndoState(null);
      notify(`${amend ? "Amended" : "Committed"} ${sha.slice(0, 7)}`);
      setRightTab("changes");
      const next = await refresh();
      // A committed file no longer has uncommitted changes, so its working-tree
      // diff is stale: close the preview if the file dropped out of the changes.
      if (previewedPath && !hasUncommittedChange(next, previewedPath)) {
        closeDiff();
      }
    }, "commit");

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

  // Pre-op HEAD snapshot (sha + branch) for Undo, read from the loaded branch
  // list. Captured synchronously by the HEAD-moving handlers below; undefined
  // when detached (no is_head branch) - those ops just don't get an Undo.
  const headSnapshot = () => {
    const b = branches.find((x) => x.is_head);
    return b?.target ? { sha: b.target, branch: b.name } : undefined;
  };

  const onMerge = (name: string) => {
    const snap = headSnapshot();
    run(async () => {
      const out = await api.merge(path, name);
      await reload();
      notify(out.trim() || `Merged ${name}`);
      if (snap) setUndoState({ label: `merge ${name}`, ...snap });
    });
  };

  const onPullAction = (action: PullAction) =>
    run(async () => {
      if (action === "fetch") {
        await api.fetchRemotes(path);
        await refresh();
        notify("Fetched from remotes");
      } else {
        const out = await api.pull(path, action);
        await reload();
        setUndoState(null); // pull advanced HEAD; a stale Undo would discard it
        notify(out.trim() || "Pulled");
      }
    }, "pull");
  const onPush = () =>
    run(async () => {
      await api.push(path);
      await refresh();
      notify("Pushed");
    }, "push");
  const onForcePush = () =>
    run(async () => {
      // Force-push needs a branch to lease against; on a detached HEAD git would
      // just error after the confirm, so bail with a readable message up front.
      if (!branches.some((b) => b.is_head)) {
        notify("Cannot force-push a detached HEAD; check out a branch first.", true);
        return;
      }
      const ok = await confirm(`Force-push ${headBranch} to origin? This rewrites remote history.`, {
        title: "Force push",
        kind: "warning",
      });
      if (!ok) return;
      const out = await api.pushForce(path);
      await refresh();
      notify(out.trim() || "Force-pushed (with lease)");
    }, "push");

  // Keyboard: push / pull on the active tab.
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === "p") {
        e.preventDefault();
        onPush();
      } else if (k === "l") {
        e.preventDefault();
        onPullAction(getPullDefault());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, onPush, onPullAction]);

  // --- commit context-menu actions ---
  const headBranch = branches.find((b) => b.is_head)?.name ?? "HEAD";

  const shortRemoteBranchName = (name: string) => {
    const slash = name.indexOf("/");
    return slash >= 0 ? name.slice(slash + 1) : name;
  };
  const remoteForLocal = (localName: string) =>
    branches
      .filter((b) => b.is_remote && shortRemoteBranchName(b.name) === localName)
      .sort((a, b) => (a.name.startsWith("origin/") ? -1 : b.name.startsWith("origin/") ? 1 : 0))[0];

  const fastForwardToBranch = (branchName: string) =>
    run(async () => {
      const out = await api.fastForwardTo(path, branchName);
      await reload();
      setUndoState(null); // fast-forward advanced HEAD; a stale Undo would discard it
      notify(out.trim() || `Fast-forwarded ${headBranch} to ${branchName}`);
    });
  const rebaseOntoBranch = (branchName: string) => {
    const snap = headSnapshot();
    run(async () => {
      const out = await api.rebaseOnto(path, branchName);
      await reload();
      notify(out.trim() || `Rebased ${headBranch} onto ${branchName}`);
      if (snap) setUndoState({ label: `rebase onto ${branchName}`, ...snap });
    });
  };
  // Drive the in-progress operation (continue / skip / abort). reload() refetches
  // status + sequencer state, so the banner updates or disappears on its own.
  // Abort returns HEAD to before the whole sequence, so the pending Undo (which
  // pointed at that same pre-op sha) is now moot - clear it.
  const seqAct = (action: api.SequencerAction, label: string) =>
    run(async () => {
      const out = await api.sequencerAct(path, action);
      await reload();
      notify(out.trim() || label);
      if (action === "--abort") setUndoState(null);
    }, label);
  // Undo the last HEAD-moving op: hard-reset to the snapshot sha. Confirms first
  // if there are uncommitted changes (reset --hard would discard them).
  const doUndo = () =>
    run(async () => {
      // Guard: only undo while still on the branch the snapshot was taken on, so
      // we never hard-reset a branch switched to since (the bar is also gated on
      // this, but re-check in case state changed between render and click).
      if (!undoState || undoState.branch !== headBranch) return;
      const dirty = status.staged.length + status.unstaged.length > 0;
      if (dirty) {
        const ok = await confirm(
          "Undo resets to before the operation and discards uncommitted changes. Continue?",
          { title: "Undo", kind: "warning" }
        );
        if (!ok) return;
      }
      await api.resetTo(path, undoState.sha, "hard");
      await reload();
      notify(`Undid ${undoState.label}`);
      setUndoState(null);
    });
  // Stable identity so RebasePlan's fetch effect doesn't re-run (refetching the
  // plan) on every RepoView re-render while the modal is open.
  const closeRebasePlan = useCallback(() => setRebasePlanBase(null), []);
  const setBranchUpstream = (localName: string, upstreamName: string) =>
    run(async () => {
      const out = await api.setUpstream(path, localName, upstreamName);
      await reload();
      notify(out.trim() || `Set upstream to ${upstreamName}`);
    });
  const renameBranch = (oldName: string, newName: string) =>
    run(async () => {
      const out = await api.renameBranch(path, oldName, newName);
      await reload();
      notify(out.trim() || `Renamed ${oldName} to ${newName}`);
    });
  const deleteBranch = (branch: BranchInfo) =>
    run(async () => {
      const ok = await confirm(
        branch.is_remote
          ? `Delete local remote-tracking branch ${branch.name}? This does not delete it from the remote server.`
          : `Delete branch ${branch.name}?`,
        {
          title: branch.is_remote ? "Delete remote-tracking branch" : "Delete branch",
          kind: "warning",
        }
      );
      if (!ok) return;
      try {
        const out = await api.deleteBranch(path, branch.name, branch.is_remote);
        await reload();
        notify(out.trim() || `Deleted ${branch.name}`);
      } catch (e) {
        // `git branch -d` refuses an unmerged local branch; offer to force it.
        if (branch.is_remote || !/not fully merged|not deleted/i.test(String(e))) throw e;
        const force = await confirm(
          `${branch.name} isn't fully merged. Force delete? Unmerged commits will be lost.`,
          { title: "Force delete branch", kind: "warning" }
        );
        if (!force) return;
        const forced = await api.deleteBranch(path, branch.name, branch.is_remote, true);
        await reload();
        notify(forced.trim() || `Force-deleted ${branch.name}`);
      }
    });

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
  const cherryPick = (sha: string) => {
    const snap = headSnapshot();
    run(async () => {
      const out = await api.cherryPick(path, sha);
      await reload();
      notify(out.trim() || "Cherry-picked");
      if (snap) setUndoState({ label: `cherry-pick ${sha.slice(0, 7)}`, ...snap });
    });
  };
  const revertCommit = (sha: string) => {
    const snap = headSnapshot();
    run(async () => {
      const ok = await confirm("Revert this commit? Creates a new commit undoing its changes.", {
        title: "Revert commit",
        kind: "warning",
      });
      if (!ok) return;
      const out = await api.revertCommit(path, sha);
      await reload();
      notify(out.trim() || "Reverted");
      if (snap) setUndoState({ label: `revert ${sha.slice(0, 7)}`, ...snap });
    });
  };
  const resetTo = (sha: string, mode: "soft" | "mixed" | "hard") => {
    const snap = headSnapshot();
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
      if (snap) setUndoState({ label: `reset (${mode}) to ${sha.slice(0, 7)}`, ...snap });
    });
  };
  const compareWorkdir = (sha: string) =>
    run(async () => {
      const files = await api.compareWorkdir(path, sha);
      setSelectedCommit(sha);
      setCompareMode(true);
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

  const createCommitFilePatch = (sha: string, filePath: string) =>
    run(async () => {
      const base = filePath.split("/").pop() ?? "file";
      const dest = await save({
        defaultPath: `${sha.slice(0, 7)}-${base}.patch`,
        filters: [{ name: "Patch", extensions: ["patch"] }],
      });
      if (!dest) return;
      await api.saveCommitFilePatch(path, sha, filePath, dest);
      notify("Patch saved");
    });

  // Right-click a file in a selected commit's change list.
  // "GitHub" / "GitLab" for the "Open on <provider>" items, or null to hide them
  // (unknown host -> remote_target returns None, so there's no web URL to build).
  const providerLabel = () =>
    repo?.provider === "github" ? "GitHub" : repo?.provider === "gitlab" ? "GitLab" : null;
  const openWeb = (kind: "repo" | "commit" | "branch" | "file", reference?: string, filePath?: string) =>
    run(async () => {
      await api.openOnWeb(path, kind, reference, filePath);
    });

  const showCommitFileMenu = async (file: FileDiff) => {
    if (!selectedCommit) return;
    const sha = selectedCommit;
    const pl = providerLabel();
    const items = await Promise.all([
      MenuItem.new({ text: "Open in editor", action: () => run(async () => void (await api.openCommitFileInEditor(path, sha, file.path))) }),
      MenuItem.new({ text: "Show in Finder", action: () => run(async () => void (await api.revealInFinder(path, file.path))) }),
      ...(pl ? [MenuItem.new({ text: `Open file on ${pl}`, action: () => openWeb("file", sha, file.path) })] : []),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({
        text: "Copy path",
        action: () => run(async () => (await api.copyText(file.path), notify("Path copied"))),
      }),
      MenuItem.new({ text: "Create patch for this file…", action: () => createCommitFilePatch(sha, file.path) }),
    ]);
    await (await Menu.new({ items })).popup();
  };

  const showBranchMenu = async (
    branch: BranchInfo,
    opts: { includeCommitActions?: boolean } = {}
  ) => {
    const target = opts.includeCommitActions ? branch.target : null;
    const isCurrent = !branch.is_remote && branch.is_head;
    const targetShort = target?.slice(0, 7) ?? "";
    const upstream = !branch.is_remote ? branch.upstream ?? remoteForLocal(branch.name)?.name : null;
    const pl = providerLabel();
    // Remote branches carry the "origin/" prefix; the web tree URL wants the bare name.
    const webRef = branch.is_remote ? shortRemoteBranchName(branch.name) : branch.name;

    const topItems = await Promise.all([
      ...(isCurrent
        ? [
            MenuItem.new({ text: "Pull (fast-forward if possible)", action: () => onPullAction("ff") }),
            MenuItem.new({ text: "Push", action: onPush }),
            MenuItem.new({ text: "Force push (with lease)…", action: onForcePush }),
            ...(upstream && !branch.upstream
              ? [MenuItem.new({ text: "Set Upstream", action: () => setBranchUpstream(branch.name, upstream) })]
              : []),
            PredefinedMenuItem.new({ item: "Separator" }),
          ]
        : []),
      ...(!isCurrent
        ? [
            MenuItem.new({
              text: `Fast-forward ${headBranch} to ${branch.name}`,
              action: () => fastForwardToBranch(branch.name),
            }),
            MenuItem.new({
              text: `Merge ${branch.name} into ${headBranch}`,
              action: () => onMerge(branch.name),
            }),
            MenuItem.new({
              text: `Rebase ${headBranch} onto ${branch.name}`,
              action: () => rebaseOntoBranch(branch.name),
            }),
            MenuItem.new({
              text: `Rebase ${headBranch} onto ${branch.name} (interactive)...`,
              action: () => setRebasePlanBase({ base: branch.name, label: branch.name, undo: headSnapshot() }),
            }),
            PredefinedMenuItem.new({ item: "Separator" }),
          ]
        : []),
      ...(!isCurrent
        ? [
            MenuItem.new({
              text: `Checkout ${branch.name}`,
              action: () =>
                onCheckout(
                  branch.is_remote ? branch.name.split("/").slice(1).join("/") : branch.name
                ),
            }),
            PredefinedMenuItem.new({ item: "Separator" }),
          ]
        : []),
      ...(target
        ? [
            MenuItem.new({
              text: "Create branch here…",
              action: () => askName(`Branch at ${targetShort}`, "branch-name", (n) => branchAt(n, target)),
            }),
            MenuItem.new({ text: "Cherry-pick commit", action: () => cherryPick(target) }),
            Submenu.new({
              text: `Reset ${headBranch} to this commit`,
              items: await Promise.all([
                MenuItem.new({ text: "Soft (keep changes staged)", action: () => resetTo(target, "soft") }),
                MenuItem.new({ text: "Mixed (keep changes unstaged)", action: () => resetTo(target, "mixed") }),
                MenuItem.new({ text: "Hard (discard changes)", action: () => resetTo(target, "hard") }),
              ]),
            }),
            MenuItem.new({ text: "Revert commit", action: () => revertCommit(target) }),
            PredefinedMenuItem.new({ item: "Separator" }),
          ]
        : []),
      ...(!branch.is_remote
        ? [
            MenuItem.new({
              text: `Rename ${branch.name}…`,
              action: () =>
                askName("Rename branch", "branch-name", (name) => renameBranch(branch.name, name), {
                  initial: branch.name,
                  cta: "Rename",
                }),
            }),
          ]
        : []),
      ...(!branch.is_head
        ? [
            MenuItem.new({
              text: branch.is_remote
                ? `Delete remote-tracking branch ${branch.name}`
                : `Delete ${branch.name}`,
              action: () => deleteBranch(branch),
            }),
            PredefinedMenuItem.new({ item: "Separator" }),
          ]
        : []),
      MenuItem.new({
        text: "Copy branch name",
        action: () => run(async () => (await api.copyText(branch.name), notify("Branch name copied"))),
      }),
      // Only offer the branch link when it exists on the remote (remote branch or
      // has an upstream); an unpushed local branch would just 404. Repo link always.
      ...(pl && (branch.is_remote || upstream)
        ? [MenuItem.new({ text: `Open branch on ${pl}`, action: () => openWeb("branch", webRef) })]
        : []),
      ...(pl ? [MenuItem.new({ text: `Open repository on ${pl}`, action: () => openWeb("repo") })] : []),
      ...(target
        ? [
            MenuItem.new({
              text: "Copy commit SHA",
              action: () => run(async () => (await api.copyText(target), notify("SHA copied"))),
            }),
            MenuItem.new({
              text: "Compare commit against working directory",
              action: () => compareWorkdir(target),
            }),
            PredefinedMenuItem.new({ item: "Separator" }),
            MenuItem.new({
              text: "Create patch from commit…",
              action: () => createCommitPatch(target),
            }),
            MenuItem.new({
              text: "Create tag here…",
              action: () => askName(`Tag at ${targetShort}`, "tag-name", (n) => tagAt(n, target, false)),
            }),
            MenuItem.new({
              text: "Create annotated tag here…",
              action: () => askName(`Annotated tag at ${targetShort}`, "tag-name", (n) => tagAt(n, target, true)),
            }),
          ]
        : []),
    ]);

    await (await Menu.new({ items: topItems })).popup();
  };

  const showGraphBranchMenu = (branchName: string, isRemote: boolean, targetSha: string) => {
    const branch =
      branches.find((b) => b.name === branchName && b.is_remote === isRemote) ??
      ({
        name: branchName,
        is_remote: isRemote,
        is_head: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        target: targetSha,
      } satisfies BranchInfo);
    void showBranchMenu(branch, { includeCommitActions: true });
  };

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

  // Shared stash context-menu items. The graph variant appends a Separator +
  // "Hide"; the sidebar variant uses them as-is.
  const stashMenuItems = (sha: string, message: string) =>
    Promise.all([
      MenuItem.new({ text: "Apply Stash", action: () => stashApply(sha) }),
      MenuItem.new({ text: "Pop Stash", action: () => stashPop(sha) }),
      MenuItem.new({ text: "Delete Stash", action: () => stashDrop(sha) }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({
        text: "Edit stash message…",
        action: () =>
          askName("Edit stash message", "stash message", (m) => stashEdit(sha, m), {
            initial: message,
            cta: "Save",
          }),
      }),
    ]);

  const showStashMenu = async (node: CommitNode) => {
    const sha = node.id;
    const items = [
      ...(await stashMenuItems(sha, node.summary)),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ text: "Hide", action: () => hideStash(sha) }),
    ];
    await (await Menu.new({ items })).popup();
  };

  const showSidebarStashMenu = async (stash: StashInfo) => {
    const items = await stashMenuItems(stash.sha, stash.message);
    await (await Menu.new({ items })).popup();
  };

  // --- worktree (sidebar) actions ---
  const refreshWipsManually = () =>
    refreshWips()
      .then(() => notify("Refreshed worktree changes"))
      .catch((e) => notify(String(e), true));

  const addWorktreeFlow = async () => {
    const dir = await api.pickRepoFolder("Choose the new worktree folder");
    if (!dir) return;
    askName(
      "New worktree branch",
      "branch (new or existing)",
      (branch) =>
        run(async () => {
          const out = await api.addWorktree(path, dir, branch);
          await refresh();
          await refreshWips();
          notify(out.trim() || `Added worktree at ${dir}`);
        }),
      { cta: "Add" }
    );
  };

  const showCommitMenu = async (node: CommitNode) => {
    if (node.refs.some((r) => r.kind === "stash")) return showStashMenu(node);
    const sha = node.id;
    const short = node.short_id;
    const pl = providerLabel();
    const items = await Promise.all([
      MenuItem.new({ text: "Checkout commit", action: () => checkoutCommit(sha) }),
      ...(pl ? [MenuItem.new({ text: `Open commit on ${pl}`, action: () => openWeb("commit", sha) })] : []),
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
      MenuItem.new({
        text: "Rebase commits after this, interactively…",
        action: () => setRebasePlanBase({ base: sha, label: short, undo: headSnapshot() }),
      }),
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
        action: () => run(async () => (await api.copyText(node.message), notify("Message copied"))),
      }),
      MenuItem.new({ text: "Create patch from commit…", action: () => createCommitPatch(sha) }),
    ]);
    await (await Menu.new({ items })).popup();
  };

  // --- tag context-menu actions ---
  const deleteTag = (name: string) =>
    run(async () => {
      const ok = await confirm(`Delete tag ${name}? This only removes it locally.`, {
        title: "Delete tag",
        kind: "warning",
      });
      if (!ok) return;
      const out = await api.deleteTag(path, name);
      await refresh();
      notify(out.trim() || `Deleted tag ${name}`);
    });

  const showTagMenu = async (name: string, target: string) => {
    const items = await Promise.all([
      MenuItem.new({ text: `Checkout ${name} (detached)`, action: () => onCheckoutTag(name) }),
      MenuItem.new({
        text: "Create branch here…",
        action: () => askName(`Branch at ${name}`, "branch-name", (n) => branchAt(n, target)),
      }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: "Compare against working directory", action: () => compareWorkdir(target) }),
      MenuItem.new({
        text: "Copy tag name",
        action: () => run(async () => (await api.copyText(name), notify("Tag name copied"))),
      }),
      MenuItem.new({
        text: "Copy commit SHA",
        action: () => run(async () => (await api.copyText(target), notify("SHA copied"))),
      }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: `Delete tag ${name}`, action: () => deleteTag(name) }),
    ]);
    await (await Menu.new({ items })).popup();
  };

  // Right-click a sidebar section header.
  const showSectionMenu = async (section: "local" | "remote" | "tags") => {
    const items = await Promise.all(
      section === "local"
        ? [MenuItem.new({ text: "New branch…", action: () => askName("New branch", "branch-name", onCreateBranch) })]
        : section === "remote"
          ? [MenuItem.new({ text: "Fetch all", action: () => onPullAction("fetch") })]
          : [
              MenuItem.new({
                text: "New tag on current commit…",
                action: () => askName("New tag at HEAD", "tag-name", (n) => tagAt(n, "HEAD", false)),
              }),
            ]
    );
    await (await Menu.new({ items })).popup();
  };

  // --- uncommitted-changes (WIP) row actions ---
  const stageAllChanges = () =>
    run(async () => {
      await api.stagePaths(path, affectedPaths(status.unstaged));
      await refresh({ history: false, stats: false });
      notify("Staged all changes");
    });
  const stashAllChanges = () =>
    run(async () => {
      const out = await api.stashAll(path);
      await reload();
      notify(out.trim() || "Stashed all changes");
    });
  const discardAllChanges = () =>
    run(async () => {
      const ok = await confirm(
        "Discard ALL uncommitted changes? This also deletes untracked files and cannot be undone.",
        { title: "Discard all changes", kind: "warning" }
      );
      if (!ok) return;
      if (status.staged.length) await api.unstagePaths(path, affectedPaths(status.staged));
      const all = affectedPaths([...status.unstaged, ...status.staged]);
      await api.discardPaths(path, all);
      await refresh({ history: false });
      notify("Discarded all changes");
    });

  const showWorkMenu = async () => {
    const items = await Promise.all([
      MenuItem.new({ text: "Stage all changes", action: stageAllChanges }),
      MenuItem.new({ text: "Stash all changes", action: stashAllChanges }),
      MenuItem.new({ text: "Discard all changes", action: discardAllChanges }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: "View changes", action: selectWork }),
    ]);
    await (await Menu.new({ items })).popup();
  };

  // --- hunk-level staging (working-file diffs only) ---
  const applyHunkAction = (header: string, action: "stage" | "unstage" | "discard") =>
    run(async () => {
      if (!workSel) return;
      if (action === "discard") {
        const ok = await confirm("Discard this hunk? This cannot be undone.", {
          title: "Discard hunk",
          kind: "warning",
        });
        if (!ok) return;
      }
      await api.applyHunk(path, workSel.path, action, header);
      // Re-fetch the same diff so remaining hunks (and their keys) stay current;
      // if the file has no changes left in this view, close the diff.
      const fresh = await api.fileDiff(path, workSel.path, workSel.staged);
      if (fresh.hunks.length === 0) closeDiff();
      else setDiff(fresh);
      await refresh({ history: false });
      notify(action === "stage" ? "Hunk staged" : action === "unstage" ? "Hunk unstaged" : "Hunk discarded");
    });

  const applyLinesAction = (
    header: string,
    action: "stage" | "unstage" | "discard",
    selected: string[]
  ) =>
    run(async () => {
      if (!workSel || selected.length === 0) return;
      const n = selected.length;
      if (action === "discard") {
        const ok = await confirm(`Discard ${n} selected line${n === 1 ? "" : "s"}? This cannot be undone.`, {
          title: "Discard lines",
          kind: "warning",
        });
        if (!ok) return;
      }
      await api.applyLines(path, workSel.path, action, header, selected);
      const fresh = await api.fileDiff(path, workSel.path, workSel.staged);
      if (fresh.hunks.length === 0) closeDiff();
      else setDiff(fresh);
      await refresh({ history: false });
      notify(action === "stage" ? "Lines staged" : action === "unstage" ? "Lines unstaged" : "Lines discarded");
    });

  const showHunkMenu = async (header: string, text: string, selected: string[]) => {
    if (!workSel) return;
    const n = selected.length;
    const plural = n === 1 ? "" : "s";
    const items = await Promise.all([
      ...(workSel.staged
        ? [MenuItem.new({ text: "Unstage hunk", action: () => applyHunkAction(header, "unstage") })]
        : [
            MenuItem.new({ text: "Stage hunk", action: () => applyHunkAction(header, "stage") }),
            MenuItem.new({ text: "Discard hunk", action: () => applyHunkAction(header, "discard") }),
          ]),
      ...(n > 0
        ? [
            PredefinedMenuItem.new({ item: "Separator" }),
            ...(workSel.staged
              ? [
                  MenuItem.new({
                    text: `Unstage ${n} line${plural}`,
                    action: () => applyLinesAction(header, "unstage", selected),
                  }),
                ]
              : [
                  MenuItem.new({
                    text: `Stage ${n} line${plural}`,
                    action: () => applyLinesAction(header, "stage", selected),
                  }),
                  MenuItem.new({
                    text: `Discard ${n} line${plural}`,
                    action: () => applyLinesAction(header, "discard", selected),
                  }),
                ]),
          ]
        : []),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({
        text: "Copy hunk",
        action: () => run(async () => (await api.copyText(text), notify("Hunk copied"))),
      }),
    ]);
    await (await Menu.new({ items })).popup();
  };

  // Files still carrying conflict markers gate the sequencer banner's Continue.
  const conflictCount = status.unstaged.filter((f) => f.status === "conflicted").length;

  // HEAD commit's message, to prefill the "Amend" composer. null when detached /
  // unborn (no is_head branch), which hides the amend toggle.
  const headTarget = branches.find((b) => b.is_head)?.target;
  const lastCommitMessage = headTarget
    ? nodes.find((n) => n.id === headTarget)?.message ?? null
    : null;

  // Hunk staging needs a tracked index diff to carve from: gate out untracked
  // (unstaged "new") files and conflicted files, where it can't work.
  const workFileStatus = workSel
    ? (workSel.staged ? status.staged : status.unstaged).find((f) => f.path === workSel.path)?.status
    : undefined;
  const hunkMenuEnabled =
    !!workSel && workFileStatus !== "conflicted" && !(!workSel.staged && workFileStatus === "new");
  // A selected conflicted file shows the resolver instead of the diff. Gated
  // independently of `diff` so it opens even before/without a fileDiff result.
  const showConflict = !!workSel && workFileStatus === "conflicted";

  // While inspecting a commit's files: ↑/↓ move between files, Escape deselects.
  // Nav walks the flat commitFiles order; the diff preview always updates. In
  // tree view, stepping into a manually-collapsed folder still previews the file
  // but shows no row highlight (the row is unmounted) - acceptable edge case.
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
    () => ({ repoPath: path, busy, activeAction, run, refresh, notify }),
    [path, busy, activeAction, run, refresh, notify]
  );

  if (!repo) {
    return <RepoSkeleton />;
  }

  // Actions surfaced in the Cmd+K palette. Built fresh each render so every
  // handler closes over current state; the list is small so the cost is nil.
  const pl = providerLabel();
  const paletteCommands: PaletteCommand[] = [
    { title: "Push", run: onPush },
    { title: "Force push (with lease)", run: onForcePush },
    { title: "Pull (fast-forward)", run: () => onPullAction("ff") },
    { title: "Pull (rebase)", run: () => onPullAction("rebase") },
    { title: "Fetch", run: () => onPullAction("fetch") },
    { title: "Stage all changes", run: stageAllChanges },
    { title: "Stash all changes", run: stashAllChanges },
    { title: "Discard all changes", run: discardAllChanges },
    { title: "New branch…", run: () => askName("New branch", "branch-name", onCreateBranch) },
    ...(pl ? [{ title: `Open repository on ${pl}`, run: () => openWeb("repo") }] : []),
    ...branches
      .filter((b) => !b.is_remote && !b.is_head)
      .map((b) => ({ title: `Checkout ${b.name}`, run: () => onCheckout(b.name) })),
  ];

  return (
    <RepoContext.Provider value={repoActions}>
      <Toolbar
        repo={repo}
        busy={busy}
        activeAction={activeAction}
        branches={branches}
        onCheckout={onCheckout}
        onPullAction={onPullAction}
        onPush={onPush}
        onForcePush={onForcePush}
        onNewBranch={() => askName("New branch", "branch-name", onCreateBranch)}
      />

      {seq?.kind ? (
        <SequencerBanner
          state={seq}
          conflictCount={conflictCount}
          busy={busy}
          onContinue={() => seqAct("--continue", "Continued")}
          onSkip={() => seqAct("--skip", "Skipped")}
          onAbort={() => seqAct("--abort", "Aborted")}
        />
      ) : (
        undoState &&
        undoState.branch === headBranch && (
          <UndoBar
            label={undoState.label}
            busy={busy}
            onUndo={doUndo}
            onDismiss={() => setUndoState(null)}
          />
        )
      )}

      <div className="main">
        <Sidebar
          branches={branches}
          tags={tags}
          worktrees={worktrees}
          stashes={stashes}
          wips={wips}
          selectedCommit={selectedCommit}
          onCheckout={onCheckout}
          onMerge={onMerge}
          onBranchMenu={showBranchMenu}
          onSelectTag={selectCommit}
          onCheckoutTag={onCheckoutTag}
          onTagMenu={showTagMenu}
          onSectionMenu={showSectionMenu}
          onOpenWorktree={onOpenPath}
          onRefreshWips={refreshWipsManually}
          onAddWorktree={() => void addWorktreeFlow()}
          onSelectStash={selectCommit}
          onStashMenu={showSidebarStashMenu}
        />

        <div className={`center${diff || showConflict ? " has-diff" : ""}`}>
          {(diff || showConflict) && (
            <div className="center-diff">
              <button
                className="center-diff-close"
                onClick={closeDiff}
                title="Close preview"
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
              </button>
              <div className="preview-header">
                <span className="preview-path">{selectedPath}</span>
                <div className="seg" role="tablist">
                  <button
                    className={previewMode === "diff" ? "active" : ""}
                    onClick={() => setPreviewMode("diff")}
                  >
                    Diff
                  </button>
                  <button
                    className={previewMode === "file" ? "active" : ""}
                    onClick={() => setPreviewMode("file")}
                  >
                    File
                  </button>
                </div>
                {((previewMode === "diff" && diff?.truncated && workSel) ||
                  (previewMode === "file" && fileContent?.truncated)) && (
                  <button
                    className="mini-btn"
                    onClick={previewMode === "diff" ? loadFullDiff : loadFullFile}
                    title="Load the entire file"
                  >
                    Load full file
                  </button>
                )}
              </div>
              {previewMode === "diff" ? (
                workSel && workFileStatus === "conflicted" ? (
                  <ConflictViewer
                    path={workSel.path}
                    onResolved={() => {
                      closeDiff();
                      void refresh({ history: false });
                    }}
                  />
                ) : (
                  <DiffViewer diff={diff} onHunkMenu={hunkMenuEnabled ? showHunkMenu : undefined} />
                )
              ) : (
                <FileView content={fileContent} />
              )}
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
              dirtyFiles={new Set([...status.staged, ...status.unstaged].map((f) => f.path)).size}
              workActive={rightTab === "changes" && !selectedCommit}
              onSelectWork={selectWork}
              onWorkMenu={showWorkMenu}
              onBranchMenu={showGraphBranchMenu}
              onTagMenu={showTagMenu}
              searchOpen={searchOpen}
              onSearchClose={() => setSearchOpen(false)}
              canLoadMore={nodes.length >= graphLimit}
              onLoadMore={loadMore}
              avatarCtx={avatarCtx}
            />
          </div>
        </div>

        <div
          className="panel-resize"
          onMouseDown={startRightResize}
          title="Resize right panel"
          aria-label="Resize right panel"
        />

        <div className="right" ref={rightRef} style={{ width: rightWidth }}>
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
                lastCommitMessage={lastCommitMessage}
                isActive={isActive}
              />
            ) : (
              <div className="commit-detail-panel">
                {selectedCommitNode && (
                  <CommitDetails commit={selectedCommitNode} avatarUrl={selectedCommitAvatar} />
                )}
                <CommitFiles
                  files={commitFiles}
                  selectedPath={selectedPath}
                  onSelect={selectCommitFile}
                  onContext={(f) => void showCommitFileMenu(f)}
                />
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

      {paletteOpen && (
        <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
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

      {rebasePlanBase && (
        <RebasePlan
          base={rebasePlanBase.base}
          baseLabel={rebasePlanBase.label}
          onClose={closeRebasePlan}
          onStarted={() => {
            const label = rebasePlanBase?.label;
            const undo = rebasePlanBase?.undo;
            void reload();
            if (undo) setUndoState({ label: `interactive rebase onto ${label}`, ...undo });
          }}
        />
      )}
    </RepoContext.Provider>
  );
}

function CommitDetails({
  commit,
  avatarUrl,
}: {
  commit: CommitNode;
  avatarUrl: string | null;
}) {
  const description = commitDescription(commit);
  const absoluteTime = new Date(commit.time * 1000).toLocaleString();
  // Fall back to the placeholder if the resolved avatar 404s (e.g. a renamed
  // account behind the legacy no-reply .png redirect). Reset when the commit
  // (and thus the avatar) changes.
  const [avatarFailed, setAvatarFailed] = useState(false);
  useEffect(() => setAvatarFailed(false), [avatarUrl]);
  return (
    <div className="commit-detail-card">
      <div className="commit-detail-main">
        {avatarUrl && !avatarFailed ? (
          <img
            className="commit-detail-avatar"
            src={avatarUrl}
            alt=""
            onError={() => setAvatarFailed(true)}
          />
        ) : (
          <div className="commit-detail-avatar placeholder" />
        )}
        <div className="commit-detail-text">
          <div className="commit-detail-title" title={commit.summary}>
            {commit.summary || "(no message)"}
          </div>
          {description && <div className="commit-detail-description">{description}</div>}
          <div className="commit-detail-author" title={commit.email}>
            {commit.author}
          </div>
        </div>
      </div>
      <div className="commit-detail-meta">
        <span title={commit.id}>{commit.short_id}</span>
        <span title={absoluteTime}>{relativeTime(commit.time)}</span>
      </div>
    </div>
  );
}

function commitDescription(commit: CommitNode): string {
  const message = commit.message.trim();
  if (!message || message === commit.summary.trim()) return "";
  const lines = message.split(/\r?\n/);
  if (lines[0]?.trim() === commit.summary.trim()) lines.shift();
  return lines.join("\n").trim();
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
