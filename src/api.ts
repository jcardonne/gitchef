import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  BranchInfo,
  BlameHunkInfo,
  CommitNode,
  ConflictFile,
  FileContent,
  FileDiff,
  FileHistoryEntry,
  PullRequest,
  ReflogNode,
  RepoInfo,
  SequencerState,
  StatusResult,
  SubmoduleInfo,
  TagInfo,
  TodoItem,
  WorkStats,
  StashInfo,
  WorktreeInfo,
} from "./types";

/// Native folder picker - the "connect to my repos" entry point.
export async function pickRepoFolder(title = "Open a Git repository"): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title,
  });
  return typeof selected === "string" ? selected : null;
}

// The backend is stateless: every command takes the `repo` path it acts on, so
// open tabs never share a "current repo" (no cross-tab races).

export const openRepo = (path: string) => invoke<RepoInfo>("open_repo", { path });
export const repoStatus = (repo: string) => invoke<StatusResult>("repo_status", { repo });
export const workStats = (repo: string) => invoke<WorkStats>("work_stats", { repo });
export const commitGraph = (repo: string, limit = 500) =>
  invoke<CommitNode[]>("commit_graph", { repo, limit });
export const commitAvatars = (repo: string, emails: string[]) =>
  invoke<Record<string, string>>("commit_avatars", { repo, emails });
export const listBranches = (repo: string) => invoke<BranchInfo[]>("list_branches", { repo });
export const listTags = (repo: string) => invoke<TagInfo[]>("list_tags", { repo });
export const listStashes = (repo: string) => invoke<StashInfo[]>("list_stashes", { repo });
export const listWorktrees = (repo: string) =>
  invoke<WorktreeInfo[]>("list_worktrees", { repo });
export const worktreeWips = (repo: string) =>
  invoke<Record<string, boolean>>("worktree_wips", { repo });
export const addWorktree = (repo: string, path: string, branch: string) =>
  invoke<string>("add_worktree", { repo, path, branch });
export const listSubmodules = (repo: string) =>
  invoke<SubmoduleInfo[]>("list_submodules", { repo });
/// Update submodules (init + checkout). `path` scopes to one (null = all);
/// `remote` checks out the tracked branch's latest instead of the recorded commit.
export const updateSubmodules = (repo: string, path: string | null, remote: boolean) =>
  invoke<string>("update_submodules", { repo, path, remote });
export const fileDiff = (repo: string, path: string, staged: boolean, full = false) =>
  invoke<FileDiff>("file_diff", { repo, path, staged, full });
export const fileContent = (
  repo: string,
  path: string,
  rev: string | null,
  staged: boolean,
  full = false
) => invoke<FileContent>("file_content", { repo, path, rev, staged, full });
export const commitDiff = (repo: string, id: string) =>
  invoke<FileDiff[]>("commit_diff", { repo, id });
export const commitStats = (repo: string, id: string) =>
  invoke<WorkStats>("commit_stats", { repo, id });
export const diffCommits = (repo: string, a: string, b: string) =>
  invoke<FileDiff[]>("diff_commits", { repo, a, b });
export const reflog = (repo: string, limit?: number) =>
  invoke<ReflogNode[]>("reflog", { repo, limit: limit ?? null });
export const fileHistory = (repo: string, path: string, limit?: number) =>
  invoke<FileHistoryEntry[]>("file_history", { repo, path, limit: limit ?? null });
export const fileBlame = (repo: string, path: string, rev: string | null) =>
  invoke<BlameHunkInfo[]>("file_blame", { repo, path, rev });
/// Create a PR (GitHub) / MR (GitLab) via the gh/glab CLI; resolves to its URL.
export const createPr = (repo: string, title: string, body: string, base: string) =>
  invoke<string>("create_pr", { repo, title, body, base });
/// Open pull/merge requests for the repo's remote (empty for non-forge remotes).
export const listPrs = (repo: string) => invoke<PullRequest[]>("list_prs", { repo });
/// Open a web URL in the default browser (backend validates it's http/https).
export const openUrl = (url: string) => invoke<void>("open_url", { url });

export const commit = (repo: string, message: string) =>
  invoke<string>("commit", { repo, message });
export const commitAmend = (repo: string, message: string) =>
  invoke<string>("commit_amend", { repo, message });
export const checkout = (repo: string, name: string) => invoke<void>("checkout", { repo, name });
export const createBranch = (repo: string, name: string, checkout: boolean) =>
  invoke<void>("create_branch", { repo, name, checkout });

export const push = (repo: string) => invoke<string>("push", { repo });
export const pushForce = (repo: string) => invoke<string>("push_force", { repo });
export type PullMode = "ff" | "ff-only" | "rebase";
export const pull = (repo: string, mode: PullMode) => invoke<string>("pull", { repo, mode });
export const fetchRemotes = (repo: string) => invoke<string>("fetch", { repo });
export const merge = (repo: string, branch: string) => invoke<string>("merge", { repo, branch });
export const fastForwardTo = (repo: string, branch: string) =>
  invoke<string>("fast_forward_to", { repo, branch });
export const rebaseOnto = (repo: string, branch: string) =>
  invoke<string>("rebase_onto", { repo, branch });

// --- sequencer (rebase/merge/cherry-pick/revert) + conflict resolution ---
export const sequencerState = (repo: string) =>
  invoke<SequencerState>("sequencer_state", { repo });
export type SequencerAction = "--continue" | "--skip" | "--abort";
export const sequencerAct = (repo: string, action: SequencerAction) =>
  invoke<string>("sequencer_act", { repo, action });
export const conflictBlocks = (repo: string, path: string) =>
  invoke<ConflictFile>("conflict_blocks", { repo, path });
export const resolveConflict = (repo: string, path: string, choices: string[]) =>
  invoke<void>("resolve_conflict", { repo, path, choices });
export const takeConflictSide = (repo: string, path: string, side: "ours" | "theirs") =>
  invoke<void>("take_conflict_side", { repo, path, side });
export const rebasePlan = (repo: string, base: string) =>
  invoke<TodoItem[]>("rebase_plan", { repo, base });
export const rebaseInteractive = (repo: string, base: string, plan: TodoItem[]) =>
  invoke<string>("rebase_interactive", { repo, base, plan });
export const renameBranch = (repo: string, oldName: string, newName: string) =>
  invoke<string>("rename_branch", { repo, oldName, newName });
export const deleteBranch = (repo: string, name: string, isRemote: boolean, force = false) =>
  invoke<string>("delete_branch", { repo, name, isRemote, force });
export const setUpstream = (repo: string, local: string, upstream: string) =>
  invoke<string>("set_upstream", { repo, local, upstream });
export const deleteTag = (repo: string, name: string) =>
  invoke<string>("delete_tag", { repo, name });

// commit context-menu actions
export const createBranchAt = (repo: string, name: string, sha: string, checkout: boolean) =>
  invoke<void>("create_branch_at", { repo, name, sha, checkout });
export const createTagAt = (
  repo: string,
  name: string,
  sha: string,
  annotated: boolean,
  message: string | null
) => invoke<void>("create_tag_at", { repo, name, sha, annotated, message });
export const cherryPick = (repo: string, sha: string) =>
  invoke<string>("cherry_pick", { repo, sha });
export const revertCommit = (repo: string, sha: string) =>
  invoke<string>("revert_commit", { repo, sha });
export const resetTo = (repo: string, sha: string, mode: "soft" | "mixed" | "hard") =>
  invoke<string>("reset_to", { repo, sha, mode });
export const saveCommitPatch = (repo: string, sha: string, dest: string) =>
  invoke<void>("save_commit_patch", { repo, sha, dest });
export const saveCommitFilePatch = (repo: string, sha: string, path: string, dest: string) =>
  invoke<void>("save_commit_file_patch", { repo, sha, path, dest });
export const compareWorkdir = (repo: string, sha: string) =>
  invoke<FileDiff[]>("compare_workdir", { repo, sha });

export const stagePaths = (repo: string, paths: string[]) =>
  invoke<void>("stage_paths", { repo, paths });
export const unstagePaths = (repo: string, paths: string[]) =>
  invoke<void>("unstage_paths", { repo, paths });
export const discardPaths = (repo: string, paths: string[]) =>
  invoke<void>("discard_paths", { repo, paths });
export const ignorePath = (repo: string, pattern: string) =>
  invoke<void>("ignore_path", { repo, pattern });
export const stashFile = (repo: string, path: string) =>
  invoke<string>("stash_file", { repo, path });
export const stashAll = (repo: string) => invoke<string>("stash_all", { repo });
export const applyHunk = (
  repo: string,
  path: string,
  action: "stage" | "unstage" | "discard",
  hunkHeader: string
) => invoke<void>("apply_hunk", { repo, path, action, hunkHeader });
export const applyLines = (
  repo: string,
  path: string,
  action: "stage" | "unstage" | "discard",
  hunkHeader: string,
  selected: string[]
) => invoke<void>("apply_lines", { repo, path, action, hunkHeader, selected });

// stash node actions (operate on the stash commit oid)
export const stashApply = (repo: string, sha: string) =>
  invoke<string>("stash_apply", { repo, sha });
export const stashPop = (repo: string, sha: string) =>
  invoke<string>("stash_pop", { repo, sha });
export const stashDrop = (repo: string, sha: string) =>
  invoke<string>("stash_drop", { repo, sha });
export const stashEditMessage = (repo: string, sha: string, message: string) =>
  invoke<string>("stash_edit_message", { repo, sha, message });
export const savePatch = (repo: string, path: string, dest: string) =>
  invoke<void>("save_patch", { repo, path, dest });
export const deleteFile = (repo: string, path: string) =>
  invoke<void>("delete_file", { repo, path });
export const copyText = (text: string) => invoke<void>("copy_text", { text });
export const revealInFinder = (repo: string, path: string) =>
  invoke<void>("reveal_in_finder", { repo, path });
export const revealPath = (path: string) => invoke<void>("reveal_path", { path });
export const openTerminal = (path: string) => invoke<void>("open_terminal", { path });
export const openDefault = (repo: string, path: string) =>
  invoke<void>("open_default", { repo, path });
export const openOnWeb = (
  repo: string,
  kind: "repo" | "commit" | "branch" | "file",
  reference?: string,
  path?: string
) => invoke<void>("open_on_web", { repo, kind, reference: reference ?? null, path: path ?? null });
export const openInEditor = (repo: string, path: string) =>
  invoke<void>("open_in_editor", { repo, path });
export const openCommitFileInEditor = (repo: string, sha: string, path: string) =>
  invoke<void>("open_commit_file_in_editor", { repo, sha, path });
export const openDifftool = (repo: string, path: string) =>
  invoke<void>("open_difftool", { repo, path });
