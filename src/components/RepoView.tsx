import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import * as api from "../api";
import { RepoContext } from "../repoContext";
import { getRightPanelWidth, setRightPanelWidth } from "../storage";
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
import { gravatarUrl, relativeTime } from "../util";
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
  const selectedCommitNode = useMemo(
    () => nodes.find((n) => n.id === selectedCommit) ?? null,
    [nodes, selectedCommit]
  );
  // Tracks the working-file currently shown so "Load full file" can refetch it.
  const [workSel, setWorkSel] = useState<{ path: string; staged: boolean } | null>(null);

  const [busy, setBusy] = useState(false);
  const [graphLimit, setGraphLimit] = useState(500);
  const [searchOpen, setSearchOpen] = useState(false);
  const [rightWidth, setRightWidth] = useState(getRightPanelWidth);
  const [selectedCommitAvatar, setSelectedCommitAvatar] = useState<string | null>(null);
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

  useEffect(() => {
    let alive = true;
    setSelectedCommitAvatar(null);
    if (!selectedCommitNode?.email) return;
    gravatarUrl(selectedCommitNode.email).then((url) => {
      if (alive) setSelectedCommitAvatar(url);
    });
    return () => {
      alive = false;
    };
  }, [selectedCommitNode?.email]);

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

  useEffect(() => setRightPanelWidth(rightWidth), [rightWidth]);

  const startRightResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rightWidth;
    const maxW = Math.max(340, window.innerWidth - 560);
    const move = (ev: MouseEvent) =>
      setRightWidth(Math.min(maxW, Math.max(320, startW - (ev.clientX - startX))));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
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
      notify(out.trim() || `Fast-forwarded ${headBranch} to ${branchName}`);
    });
  const rebaseOntoBranch = (branchName: string) =>
    run(async () => {
      const out = await api.rebaseOnto(path, branchName);
      await reload();
      notify(out.trim() || `Rebased ${headBranch} onto ${branchName}`);
    });
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
  const showCommitFileMenu = async (file: FileDiff) => {
    if (!selectedCommit) return;
    const sha = selectedCommit;
    const items = await Promise.all([
      MenuItem.new({ text: "Open in editor", action: () => run(async () => void (await api.openInEditor(path, file.path))) }),
      MenuItem.new({ text: "Show in Finder", action: () => run(async () => void (await api.revealInFinder(path, file.path))) }),
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

    const topItems = await Promise.all([
      ...(isCurrent
        ? [
            MenuItem.new({ text: "Pull (fast-forward if possible)", action: () => onPullAction("ff") }),
            MenuItem.new({ text: "Push", action: onPush }),
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
      await api.stagePaths(path, status.unstaged.map((f) => f.path));
      await refresh();
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
      if (status.staged.length) await api.unstagePaths(path, status.staged.map((f) => f.path));
      const all = [...new Set([...status.unstaged, ...status.staged].map((f) => f.path))];
      await api.discardPaths(path, all);
      await refresh();
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
      await refresh();
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
      await refresh();
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

  // Hunk staging needs a tracked index diff to carve from: gate out untracked
  // (unstaged "new") files and conflicted files, where it can't work.
  const workFileStatus = workSel
    ? (workSel.staged ? status.staged : status.unstaged).find((f) => f.path === workSel.path)?.status
    : undefined;
  const hunkMenuEnabled =
    !!workSel && workFileStatus !== "conflicted" && !(!workSel.staged && workFileStatus === "new");

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
          onBranchMenu={showBranchMenu}
          onSelectTag={selectCommit}
          onCheckoutTag={onCheckoutTag}
          onTagMenu={showTagMenu}
          onSectionMenu={showSectionMenu}
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
              <DiffViewer
                diff={diff}
                onLoadFull={workSel ? loadFullDiff : undefined}
                onHunkMenu={hunkMenuEnabled ? showHunkMenu : undefined}
              />
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
              onWorkMenu={showWorkMenu}
              onBranchMenu={showGraphBranchMenu}
              onTagMenu={showTagMenu}
              searchOpen={searchOpen}
              onSearchClose={() => setSearchOpen(false)}
              canLoadMore={nodes.length >= graphLimit}
              onLoadMore={loadMore}
            />
          </div>
        </div>

        <div
          className="panel-resize"
          onMouseDown={startRightResize}
          title="Resize right panel"
          aria-label="Resize right panel"
        />

        <div className="right" style={{ width: rightWidth }}>
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
              <div className="commit-detail-panel">
                {selectedCommitNode && (
                  <CommitDetails commit={selectedCommitNode} avatarUrl={selectedCommitAvatar} />
                )}
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
                      onContextMenu={(e) => {
                        e.preventDefault();
                        void showCommitFileMenu(f);
                      }}
                    >
                      <span className="file-path">{f.path}</span>
                    </div>
                  ))}
                </div>
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

function CommitDetails({
  commit,
  avatarUrl,
}: {
  commit: CommitNode;
  avatarUrl: string | null;
}) {
  const description = commitDescription(commit);
  const absoluteTime = new Date(commit.time * 1000).toLocaleString();
  return (
    <div className="commit-detail-card">
      <div className="commit-detail-main">
        {avatarUrl ? (
          <img className="commit-detail-avatar" src={avatarUrl} alt="" />
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
