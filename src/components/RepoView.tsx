import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import * as api from "../api";
import { RepoContext, type RefreshOpts } from "../repoContext";
import { getRightPanelWidth, setRightPanelWidth, getPullDefault, getFetchIntervalMinutes } from "../storage";
import type { PullAction } from "../storage";
import type {
  BranchInfo,
  BlameHunkInfo,
  CommitNode,
  FileContent,
  FileDiff,
  PullRequest,
  RepoInfo,
  SequencerState,
  StatusResult,
  TagInfo,
  WorkStats,
  WorktreeInfo,
  SubmoduleInfo,
  StashInfo,
} from "../types";
import { affectedPaths, avatarUrl, type AvatarContext, hasUncommittedChange, isRateLimited, rateLimitBackoffMs, relativeTime } from "../util";
import { shouldBackgroundFetch, shouldHandleRepoChange, shouldRefreshPrs, extendBackoff } from "../refreshPolicy";
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
import ReflogModal from "./ReflogModal";
import BlameView from "./BlameView";
import FileHistoryModal from "./FileHistoryModal";
import CreatePrModal from "./CreatePrModal";

const EMPTY_STATUS: StatusResult = { staged: [], unstaged: [] };

// PR/MR listing spawns a gh/glab subprocess and hits the REST/GraphQL API bucket,
// unlike the cheap git-protocol fetch - so the background fetch loop refreshes it
// at this coarser cadence. Focus/return + user ops still refresh PRs immediately.
const PR_REFRESH_MS = 15 * 60_000;

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
  const [submodules, setSubmodules] = useState<SubmoduleInfo[]>([]);
  const [stashes, setStashes] = useState<StashInfo[]>([]);
  const [prs, setPrs] = useState<PullRequest[]>([]);
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
  // A request to scroll the graph to a commit (bumped `seq` re-fires even for the
  // same id). Set when picking a branch/tag/stash in the sidebar.
  const [reveal, setReveal] = useState<{ id: string; seq: number } | null>(null);
  const [commitFiles, setCommitFiles] = useState<FileDiff[]>([]);
  // Two-commit compare: `compareBase` is the commit picked "for compare" via the
  // context menu; `compareView` is the active a..b comparison shown in the panel.
  const [compareBase, setCompareBase] = useState<string | null>(null);
  const [compareView, setCompareView] = useState<{ a: string; b: string } | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const selectedCommitNode = useMemo(
    () => nodes.find((n) => n.id === selectedCommit) ?? null,
    [nodes, selectedCommit]
  );
  // A selected stash that has no visible graph node (hidden, or clicked from the
  // sidebar) still gets a header - its files already load via commit_diff.
  const selectedStash = useMemo(
    () => stashes.find((s) => s.sha === selectedCommit) ?? null,
    [stashes, selectedCommit]
  );
  // Tracks the working-file currently shown so "Load full file" can refetch it.
  const [workSel, setWorkSel] = useState<{ path: string; staged: boolean } | null>(null);

  // The preview pane shows either the unified diff or the whole file. The mode
  // is sticky across file selections; `fileContent` is loaded lazily in "file"
  // mode. `compareMode` records that the open commit-file list came from a
  // "compare with working directory" - so its File view reads the workdir (the
  // diff's right-hand side), not the commit's blob.
  const [previewMode, setPreviewMode] = useState<"diff" | "split" | "file" | "blame">("diff");
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [blame, setBlame] = useState<BlameHunkInfo[]>([]);
  const [compareMode, setCompareMode] = useState(false);

  const [busy, setBusy] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [graphLimit, setGraphLimit] = useState(500);
  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [reflogOpen, setReflogOpen] = useState(false);
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [prOpen, setPrOpen] = useState(false);
  // Bumped on a `gitchef:prefs` event so the auto-fetch interval re-reads live.
  const [autoFetchTick, setAutoFetchTick] = useState(0);
  const [rightWidth, setRightWidth] = useState(getRightPanelWidth);
  const [selectedCommitAvatar, setSelectedCommitAvatar] = useState<string | null>(null);
  const [selectedCommitStats, setSelectedCommitStats] = useState<WorkStats | null>(null);
  const [accountAvatars, setAccountAvatars] = useState<ReadonlyMap<string, string>>(new Map());
  const [toast, setToast] = useState<{ msg: string; error: boolean; duration: number; seq: number; closing?: boolean } | null>(null);
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
  const toastSeq = useRef(0);
  const revealSeq = useRef(0);
  // Monotonic request ids: a slower response for an earlier selection must never
  // clobber the state of a newer one (rapid commit/file clicks).
  const commitReq = useRef(0);
  const fileReq = useRef(0);
  const statsReq = useRef(0);
  const rightRef = useRef<HTMLDivElement>(null);
  // Live mirror of `busy` for the auto-fetch interval's stale closure.
  const busyRef = useRef(false);
  // Epoch ms of the last background fetch, shared by the interval + fetch-on-focus
  // so the two paths throttle against each other (no double-fetch on refocus).
  const lastFetchRef = useRef(0);
  // Epoch ms our last own git op settled - the watcher listener ignores its own
  // debounced echo within a short grace window after this (see run()).
  const lastOpAt = useRef(0);
  // Epoch ms of the last PR/MR listing, so the background loop can list at a
  // coarser cadence than the fetch (any listing - focus, load, user op - counts).
  const lastPrAt = useRef(0);
  // Epoch ms until which background network is paused after a provider rate-limit
  // (see noteBackoff). Foreground/user-initiated ops are never gated by this.
  const backoffUntil = useRef(0);

  // Play the exit animation, then unmount after it (kept in sync with the
  // .toast.closing CSS below).
  const TOAST_EXIT_MS = 160;
  const dismissToast = useCallback(() => {
    window.clearTimeout(toastTimer.current);
    setToast((t) => (t ? { ...t, closing: true } : null));
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_EXIT_MS);
  }, []);

  // Both auto-dismiss: info after 4s, errors after 12s (long git messages need
  // longer to read/copy). A countdown ring on the toast shows the time left; the
  // bumped `seq` re-keys the toast so it (and that ring) restart/animate in fresh.
  const notify = useCallback(
    (msg: string, error = false) => {
      const duration = error ? 12000 : 4000;
      toastSeq.current += 1;
      setToast({ msg, error, duration, seq: toastSeq.current });
      window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(dismissToast, duration);
    },
    [dismissToast]
  );
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // A background network error that looks like a provider rate-limit pauses the
  // auto-fetch loop until the window passes, instead of retrying on schedule
  // (which can prolong a secondary limit). Only extends the pause forward, and
  // toasts once - on entering backoff, not on every subsequent throttled hit.
  const enterBackoff = useCallback(
    (ms: number) => {
      const { until, enteredNow } = extendBackoff(backoffUntil.current, Date.now(), ms);
      backoffUntil.current = until;
      if (enteredNow) {
        notify(`Auto-fetch paused: rate limited. Resuming around ${new Date(until).toLocaleTimeString()}.`);
      }
    },
    [notify]
  );
  // Text-heuristic entry point: a CLI error (gh/glab/git) carries no headers, so
  // we recognise the rate-limit from its message and use the parsed/fallback delay.
  const noteBackoff = useCallback(
    (msg: string) => {
      if (isRateLimited(msg)) enterBackoff(rateLimitBackoffMs(msg)); // else: transient/offline
    },
    [enterBackoff]
  );

  // Provider account avatars (GitHub/GitLab profile pictures) for the committers
  // in view, resolved by the backend (cached on disk) and merged in as they
  // arrive - upgrading the no-reply/Gravatar fallbacks. Skipped for repos whose
  // remote isn't a known provider.
  useEffect(() => {
    if (repo?.provider !== "github" && repo?.provider !== "gitlab") return;
    // Don't add to a rate-limit we're already backing off from (avatars hit the
    // same API bucket). They fill in on the next graph change after it clears.
    if (Date.now() < backoffUntil.current) return;
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

  // Insertion/deletion totals for the selected commit's detail card (accurate
  // even when the file list truncates). Best-effort: a failure just hides them.
  useEffect(() => {
    let alive = true;
    setSelectedCommitStats(null);
    if (!selectedCommit) return;
    api.commitStats(path, selectedCommit).then(
      (s) => {
        if (alive) setSelectedCommitStats(s);
      },
      () => {}
    );
    return () => {
      alive = false;
    };
  }, [selectedCommit, path]);

  // Open PRs/MRs for the sidebar section + the badge fork-icon. A network CLI hit,
  // so it's OFF the hot refresh() path: fetched on load / provider change and via
  // the section's manual refresh, never after every git op. Non-forge repo -> [].
  const refreshPrs = useCallback(() => {
    if (repo?.provider !== "github" && repo?.provider !== "gitlab") {
      setPrs([]);
      return;
    }
    lastPrAt.current = Date.now();
    api.listPrs(path).then(setPrs).catch((e) => noteBackoff(String(e)));
  }, [path, repo?.provider, noteBackoff]);
  useEffect(() => refreshPrs(), [refreshPrs]);

  // Branch name -> its open PR, for the graph badge icon + "Open pull request" menu.
  const prByBranch = useMemo(() => {
    const m = new Map<string, PullRequest>();
    for (const pr of prs) if (!m.has(pr.branch)) m.set(pr.branch, pr);
    return m;
  }, [prs]);
  const prBranchSet = useMemo(() => new Set(prByBranch.keys()), [prByBranch]);

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
      // Re-entrancy guard: one op at a time. busyRef is set synchronously (not
      // via the `busy` state, which lags a render) so a rapid double-trigger -
      // e.g. hitting the pull/push keyboard shortcut twice - can't launch two
      // concurrent git ops racing on the same .git lock files.
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setActiveAction(action ?? null);
      try {
        await fn();
      } catch (e) {
        notify(String(e), true);
      } finally {
        busyRef.current = false;
        // Stamp when our own op settled. Its .git writes fire a debounced
        // `repo-changed` ~400ms later, AFTER busyRef has already flipped back for
        // a fast op - so the watcher listener also skips within this grace window,
        // else every local op would echo a redundant refresh of its own writes.
        lastOpAt.current = Date.now();
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
        api.listSubmodules(path).then(setSubmodules).catch(() => {});
        api.listStashes(path).then(setStashes).catch(() => {});
      }
      if (withStats) refreshStats();
      return s;
    },
    [path, graphLimit, refreshStats]
  );

  // One background (non-blocking) fetch: pull remote state + prune, repaint the
  // graph, and self-heal the PR list. Stamps lastFetchRef so the interval and
  // fetch-on-focus throttle against a shared clock. Silent on failure - a
  // background fetch offline shouldn't nag.
  const backgroundFetch = useCallback(() => {
    // Self-gating (see shouldBackgroundFetch) so every caller - the interval and a
    // focus refresh - honours ONE throttle, and neither hammers a rate-limited or
    // offline remote.
    const now = Date.now();
    if (
      !shouldBackgroundFetch({
        minutes: getFetchIntervalMinutes(),
        online: navigator.onLine,
        now,
        lastFetch: lastFetchRef.current,
        backoffUntil: backoffUntil.current,
      })
    ) {
      return;
    }
    lastFetchRef.current = now;
    api.fetchRemotes(path).then(() => refresh({ stats: false })).catch((e) => noteBackoff(String(e)));
    // Fetch runs every tick (cheap); PR-list only at its own coarser cadence.
    if (shouldRefreshPrs(now, lastPrAt.current, PR_REFRESH_MS)) refreshPrs();
  }, [path, refresh, refreshPrs, noteBackoff]);

  // Per-worktree dirty ("WIP") indicators are an opt-in scan: each worktree is
  // opened and status-walked, so this runs on demand (first load + the sidebar
  // "refresh WIPs" button + after adding a worktree), never on the hot path.
  const refreshWips = useCallback(() => api.worktreeWips(path).then(setWips), [path]);

  // Submodules: open one as a repo tab (its workdir is <repo>/<path>), or run
  // `git submodule update` (init/checkout) for one or all.
  const openSubmodule = (subPath: string) => onOpenPath(`${path}/${subPath}`);
  const submoduleUpdate = (subPath: string | null, remote: boolean) =>
    run(async () => {
      const out = await api.updateSubmodules(path, subPath, remote);
      await refresh();
      notify(out.trim() || (subPath ? "Submodule updated" : "Submodules updated"));
    });
  const showSubmoduleMenu = async (sub: SubmoduleInfo) => {
    const items = await Promise.all([
      ...(sub.initialized
        ? [MenuItem.new({ text: "Open in a tab", action: () => openSubmodule(sub.path) })]
        : []),
      MenuItem.new({
        text: sub.initialized ? "Update to recorded commit" : "Update (clone + init)",
        action: () => submoduleUpdate(sub.path, false),
      }),
      MenuItem.new({ text: "Update to latest (remote)", action: () => submoduleUpdate(sub.path, true) }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: "Copy path", action: () => run(async () => (await api.copyText(sub.path), notify("Path copied"))) }),
      ...(sub.url
        ? [MenuItem.new({ text: "Copy URL", action: () => run(async () => (await api.copyText(sub.url!), notify("URL copied"))) })]
        : []),
    ]);
    await (await Menu.new({ items })).popup();
  };

  const openPr = (url: string) => run(async () => void (await api.openUrl(url)));
  const showPrMenu = async (pr: PullRequest) => {
    const items = await Promise.all([
      MenuItem.new({ text: `Open #${pr.number} in browser`, action: () => openPr(pr.url) }),
      MenuItem.new({ text: "Copy URL", action: () => run(async () => (await api.copyText(pr.url), notify("URL copied"))) }),
    ]);
    await (await Menu.new({ items })).popup();
  };

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
          // The tab may have closed during that await; don't register a watcher
          // the unmount cleanup has already run past (it would leak, never freed).
          if (!alive) return;
          refreshWips().catch(() => {});
          // Watch this repo's .git so external changes refresh the tab live.
          api.watchRepo(path).catch(() => {});
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
        // When auto-fetch is on, regaining focus also pulls remote state.
        // backgroundFetch self-throttles, so alt-tabbing can't hammer the remote.
        backgroundFetch();
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
  }, [isActive, notify, refresh, backgroundFetch]);

  // Live refresh when this repo's .git changes on disk (external commit/checkout/
  // stash/rebase from a terminal or other tool). The backend debounces the write
  // burst into one event; we skip our own writes' echo (in flight via busyRef, or
  // just-settled via lastOpAt - the 400ms debounce lands after a fast op clears
  // busy) and while the window is hidden (the focus handler covers the return).
  // Local only - no network, so nothing to rate-limit.
  const OWN_OP_GRACE_MS = 700; // > the backend's 400ms debounce
  useEffect(() => {
    if (!isActive) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<string>("repo-changed", (e) => {
      const ok = shouldHandleRepoChange({
        matchesPath: e.payload === path,
        busy: busyRef.current,
        now: Date.now(),
        lastOpAt: lastOpAt.current,
        graceMs: OWN_OP_GRACE_MS,
        hidden: document.visibilityState === "hidden",
      });
      if (ok) refresh({ stats: false }).catch(() => {});
    }).then((fn) => (disposed ? fn() : (unlisten = fn)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isActive, path, refresh]);

  // Stop watching when the tab closes (this instance unmounts).
  useEffect(() => () => void api.unwatchRepo(path).catch(() => {}), [path]);

  // The backend emits `rate-limited` (backoff seconds, derived from the provider's
  // Retry-After / RateLimit-Reset headers on the avatar API path) - a header-exact
  // pause, more precise than the CLI-error string heuristic.
  useEffect(() => {
    if (!isActive) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<number>("rate-limited", (e) => enterBackoff(Math.max(0, e.payload) * 1000)).then((fn) =>
      disposed ? fn() : (unlisten = fn)
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isActive, enterBackoff]);

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

  // Show the diff between two arbitrary commits (tree(a) -> tree(b)) in the
  // commit panel. selectedCommit is set to b so the File preview reads b's blob;
  // the compareView header takes render priority over the commit detail.
  const runCompare = (a: string, b: string) => {
    const req = ++commitReq.current;
    run(async () => {
      setSelectedCommit(b);
      setCompareMode(false); // this is a two-commit compare, not vs working dir
      setCompareView({ a, b });
      setRightTab("commit");
      setSelectedPath(null);
      setDiff(null);
      const files = await api.diffCommits(path, a, b);
      if (commitReq.current === req) setCommitFiles(files);
    });
  };

  const selectCommit = (id: string) => {
    setCompareMode(false);
    setCompareView(null);
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

  // Sidebar navigation: select a commit AND scroll the graph to its row (no
  // checkout). Skips the re-select when it's already selected so it doesn't toggle
  // the selection off. If the target isn't in the loaded window yet, pull deeper
  // pages (up to a cap) until it appears, then reveal - so the user never has to
  // hit "Load more" by hand.
  const goToCommit = (id: string) => {
    if (selectedCommit !== id) selectCommit(id);
    if (nodes.some((n) => n.id === id)) {
      setReveal({ id, seq: ++revealSeq.current });
      return;
    }
    run(async () => {
      let limit = graphLimit;
      let found = false;
      for (let round = 0; round < 40; round++) {
        limit += 500;
        const g = await api.commitGraph(path, limit);
        setGraphLimit(limit);
        setNodes(g);
        if (g.some((n) => n.id === id)) {
          found = true;
          break;
        }
        if (g.length < limit) break; // loaded all history; it isn't there
      }
      if (found) setReveal({ id, seq: ++revealSeq.current });
      else notify("That commit isn't in this repository's loaded history.", true);
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

  // Blame shows a committed file version, so its content AND hunks use the same
  // rev: the shown commit, or HEAD for a working file (never the dirty workdir,
  // which would misalign the gutter).
  const blameRev = useCallback((): string | null => {
    if (!workSel) return selectedCommit;
    // The current HEAD commit - resolved from the graph's HEAD ref label so it
    // works whether HEAD is on a branch or detached; falls back to the branch
    // target. Keeps blame content + hunks on the same committed rev.
    return (
      nodes.find((n) => n.refs.some((r) => r.kind === "head"))?.id ??
      branches.find((b) => b.is_head)?.target ??
      null
    );
  }, [workSel, selectedCommit, nodes, branches]);

  // Load whole-file content lazily for the File and Blame views. Cancellation
  // guards against a slow load landing after the user has moved on.
  useEffect(() => {
    if ((previewMode !== "file" && previewMode !== "blame") || !selectedPath) return;
    const { rev, staged } =
      previewMode === "blame" ? { rev: blameRev(), staged: false } : fileContentSource();
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

  // Load blame hunks when the Blame view is active (same rev as its content).
  useEffect(() => {
    if (previewMode !== "blame" || !selectedPath) return;
    const rev = blameRev();
    setBlame([]); // drop stale hunks so they can't pair with the new file's content
    let cancelled = false;
    run(async () => {
      const h = await api.fileBlame(path, selectedPath, rev);
      if (!cancelled) setBlame(h);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode, selectedPath, workSel, selectedCommit]);

  const loadFullFile = () =>
    run(async () => {
      if (!selectedPath) return;
      const { rev, staged } =
        previewMode === "blame" ? { rev: blameRev(), staged: false } : fileContentSource();
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
    // Re-list PRs: a merge/pull/push may have merged or closed one server-side,
    // and a stale open-PR entry must not linger in the sidebar.
    refreshPrs();
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

  // Auto-fetch: re-read the setting on a prefs change, and run a background
  // fetch on the active tab at the chosen interval. Skips a tick while an op is
  // in flight (busyRef, owned by run()) or the window is hidden, and never
  // toasts on failure (a background fetch offline shouldn't nag).
  useEffect(() => {
    const onPrefs = () => setAutoFetchTick((t) => t + 1);
    window.addEventListener("gitchef:prefs", onPrefs);
    return () => window.removeEventListener("gitchef:prefs", onPrefs);
  }, []);
  useEffect(() => {
    const minutes = getFetchIntervalMinutes();
    if (!isActive || minutes <= 0) return;
    const id = window.setInterval(() => {
      if (busyRef.current || document.visibilityState === "hidden") return;
      backgroundFetch();
    }, minutes * 60_000);
    return () => window.clearInterval(id);
  }, [isActive, backgroundFetch, autoFetchTick]);

  // Re-list PRs when the app regains focus - a PR merged/closed on the provider's
  // web UI while you were away must not linger as "open" in the sidebar.
  useEffect(() => {
    if (!isActive) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshPrs();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [isActive, refreshPrs]);

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
      setCompareView(null); // leaving any two-commit compare
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

  const submitPr = (title: string, body: string, base: string) =>
    run(async () => {
      const url = await api.createPr(path, title, body, base);
      await refresh(); // the create auto-pushed the branch; refresh upstream/ahead-behind
      notify(`Created ${url}`);
    });

  const showCommitFileMenu = async (file: FileDiff) => {
    if (!selectedCommit) return;
    const sha = selectedCommit;
    const pl = providerLabel();
    const items = await Promise.all([
      MenuItem.new({ text: "Open in editor", action: () => run(async () => void (await api.openCommitFileInEditor(path, sha, file.path))) }),
      MenuItem.new({ text: "Show in Finder", action: () => run(async () => void (await api.revealInFinder(path, file.path))) }),
      MenuItem.new({ text: "View file history", action: () => setHistoryPath(file.path) }),
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
    const prForBranch = prByBranch.get(webRef);

    const topItems = await Promise.all([
      ...(prForBranch
        ? [
            MenuItem.new({ text: `Open pull request #${prForBranch.number}`, action: () => openPr(prForBranch.url) }),
            PredefinedMenuItem.new({ item: "Separator" }),
          ]
        : []),
      ...(isCurrent
        ? [
            MenuItem.new({ text: "Pull (fast-forward if possible)", action: () => onPullAction("ff") }),
            MenuItem.new({ text: "Push", action: onPush }),
            MenuItem.new({ text: "Force push (with lease)…", action: onForcePush }),
            ...(pl
              ? [MenuItem.new({ text: `Create ${pl === "GitLab" ? "merge" : "pull"} request…`, action: () => setPrOpen(true) })]
              : []),
            MenuItem.new({ text: "View HEAD reflog…", action: () => setReflogOpen(true) }),
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
      MenuItem.new({ text: "Select for compare", action: () => setCompareBase(sha) }),
      ...(compareBase && compareBase !== sha
        ? [MenuItem.new({ text: `Compare ${compareBase.slice(0, 7)} .. ${short}`, action: () => runCompare(compareBase, sha) })]
        : []),
      ...(compareBase
        ? [MenuItem.new({ text: "Clear compare selection", action: () => setCompareBase(null) })]
        : []),
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

  // Escape closes an open file preview, whatever opened it. Runs in the capture
  // phase and stops propagation so it beats the commit-files handler above (which
  // would otherwise deselect the whole commit); typing in an input is left alone.
  // Bails while any modal/overlay is open so it doesn't swallow the Escape that
  // should close the modal on top (it, not the diff behind it, must win).
  const modalOpen =
    paletteOpen || reflogOpen || prOpen || !!historyPath || !!rebasePlanBase || !!namePrompt;
  useEffect(() => {
    if (!isActive || !diff || modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      e.stopPropagation();
      closeDiff();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, diff, modalOpen]);

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
  // Base-branch candidates for the PR/MR form: unique branch names, defaulting
  // to main/master when present.
  const baseCandidates = Array.from(
    new Set(branches.map((b) => (b.is_remote ? shortRemoteBranchName(b.name) : b.name)))
  ).sort();
  const prBaseDefault = ["main", "master"].find((n) => baseCandidates.includes(n)) ?? baseCandidates[0] ?? "main";
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
    { title: "Show reflog", run: () => setReflogOpen(true) },
    ...(pl ? [{ title: `Create ${pl === "GitLab" ? "merge" : "pull"} request…`, run: () => setPrOpen(true) }] : []),
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
          submodules={submodules}
          stashes={stashes}
          prs={prs}
          wips={wips}
          selectedCommit={selectedCommit}
          onSelectBranch={goToCommit}
          onOpenPr={openPr}
          onPrMenu={showPrMenu}
          onRefreshPrs={refreshPrs}
          onCheckout={onCheckout}
          onMerge={onMerge}
          onBranchMenu={showBranchMenu}
          onSelectTag={goToCommit}
          onCheckoutTag={onCheckoutTag}
          onTagMenu={showTagMenu}
          onSectionMenu={showSectionMenu}
          onOpenWorktree={onOpenPath}
          onRefreshWips={refreshWipsManually}
          onAddWorktree={() => void addWorktreeFlow()}
          onOpenSubmodule={openSubmodule}
          onSubmoduleMenu={showSubmoduleMenu}
          onUpdateAllSubmodules={() => submoduleUpdate(null, false)}
          onSelectStash={goToCommit}
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
                    className={previewMode === "split" ? "active" : ""}
                    onClick={() => setPreviewMode("split")}
                  >
                    Split
                  </button>
                  <button
                    className={previewMode === "file" ? "active" : ""}
                    onClick={() => setPreviewMode("file")}
                  >
                    File
                  </button>
                  <button
                    className={previewMode === "blame" ? "active" : ""}
                    onClick={() => setPreviewMode("blame")}
                  >
                    Blame
                  </button>
                </div>
                {selectedPath && (
                  <button
                    className="mini-btn"
                    onClick={() => setHistoryPath(selectedPath)}
                    title="Commits that changed this file"
                  >
                    History
                  </button>
                )}
                {(((previewMode === "diff" || previewMode === "split") && diff?.truncated && workSel) ||
                  ((previewMode === "file" || previewMode === "blame") && fileContent?.truncated)) && (
                  <button
                    className="mini-btn"
                    onClick={previewMode === "file" || previewMode === "blame" ? loadFullFile : loadFullDiff}
                    title="Load the entire file"
                  >
                    Load full file
                  </button>
                )}
              </div>
              {previewMode === "file" ? (
                <FileView content={fileContent} />
              ) : previewMode === "blame" ? (
                <BlameView content={fileContent} hunks={blame} onPickCommit={selectCommit} />
              ) : previewMode === "diff" && workSel && workFileStatus === "conflicted" ? (
                <ConflictViewer
                  path={workSel.path}
                  onResolved={() => {
                    closeDiff();
                    void refresh({ history: false });
                  }}
                />
              ) : (
                <DiffViewer
                  diff={diff}
                  mode={previewMode === "split" ? "split" : "unified"}
                  onHunkMenu={hunkMenuEnabled ? showHunkMenu : undefined}
                />
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
              headBranch={branches.find((b) => b.is_head)?.name ?? null}
              selectedId={selectedCommit}
              reveal={reveal}
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
              prBranches={prBranchSet}
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
                {compareView ? (
                  <div className="commit-detail-card">
                    <div className="commit-detail-main">
                      <div className="commit-detail-text">
                        <div className="commit-detail-title">Comparing commits</div>
                        <div className="commit-detail-author">
                          {compareView.a.slice(0, 7)} .. {compareView.b.slice(0, 7)}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : selectedCommitNode ? (
                  <CommitDetails commit={selectedCommitNode} avatarUrl={selectedCommitAvatar} stats={selectedCommitStats} />
                ) : selectedStash ? (
                  <div className="commit-detail-card">
                    <div className="commit-detail-main">
                      <div className="commit-detail-text">
                        <div className="commit-detail-title" title={selectedStash.message}>
                          {selectedStash.message}
                        </div>
                        <div className="commit-detail-author">Stash</div>
                      </div>
                    </div>
                    <div className="commit-detail-meta">
                      <span title={selectedStash.sha}>{`stash@{${selectedStash.index}}`}</span>
                      <span>{relativeTime(selectedStash.time)}</span>
                    </div>
                  </div>
                ) : null}
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
        <div
          key={toast.seq}
          className={`toast${toast.error ? " toast-error" : ""}${toast.closing ? " closing" : ""}`}
        >
          {toast.error && (
            <div className="toast-error-head">
              <span className="toast-error-title">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 1.8 15 14H1z" />
                  <path d="M8 6.3v3.4M8 11.7h.01" />
                </svg>
                Error
              </span>
              <span className="toast-countdown-wrap">
                <span className="toast-countdown-label">This error will disappear</span>
                <CountdownRing ms={toast.duration} />
              </span>
            </div>
          )}
          <span className="toast-msg">{toast.msg}</span>
          {toast.error ? (
            <div className="toast-actions">
              <button onClick={() => run(async () => (await api.copyText(toast.msg), notify("Copied")))}>
                Copy
              </button>
              <button onClick={dismissToast}>Close</button>
            </div>
          ) : (
            <CountdownRing ms={toast.duration} />
          )}
        </div>
      )}

      {paletteOpen && (
        <CommandPalette commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
      )}

      {reflogOpen && (
        <ReflogModal
          repoPath={path}
          onCheckout={checkoutCommit}
          onReset={(sha) => resetTo(sha, "hard")}
          onClose={() => setReflogOpen(false)}
        />
      )}

      {historyPath && (
        <FileHistoryModal
          repoPath={path}
          filePath={historyPath}
          onPick={(sha) => sha !== selectedCommit && selectCommit(sha)}
          onClose={() => setHistoryPath(null)}
        />
      )}

      {prOpen && (repo.provider === "github" || repo.provider === "gitlab") && (
        <CreatePrModal
          provider={repo.provider}
          baseDefault={prBaseDefault}
          bases={baseCandidates}
          onSubmit={submitPr}
          onClose={() => setPrOpen(false)}
        />
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
  stats,
}: {
  commit: CommitNode;
  avatarUrl: string | null;
  stats: WorkStats | null;
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
            {commit.email && <span className="commit-detail-email">{commit.email}</span>}
          </div>
        </div>
      </div>
      <div className="commit-detail-meta">
        <span title={commit.id}>{commit.short_id}</span>
        <span title={absoluteTime}>{relativeTime(commit.time)}</span>
        {stats && (stats.insertions > 0 || stats.deletions > 0) && (
          <span className="commit-detail-diffstat">
            <span className="wip-add">+{stats.insertions}</span>
            <span className="wip-del">-{stats.deletions}</span>
          </span>
        )}
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

/// Shrinking ring that visualizes a toast's time left before it auto-dismisses.
/// Pure CSS: the arc's dash-offset animates to the full circumference over `ms`,
/// emptying the ring. Remounted per toast (keyed by seq) so it replays.
function CountdownRing({ ms }: { ms: number }) {
  return (
    <svg className="toast-countdown" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="toast-countdown-track" cx="8" cy="8" r="6" />
      <circle className="toast-countdown-arc" cx="8" cy="8" r="6" style={{ animationDuration: `${ms}ms` }} />
    </svg>
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
