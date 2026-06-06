import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  BranchInfo,
  CommitNode,
  FileDiff,
  RepoInfo,
  StatusResult,
  TagInfo,
  WorkStats,
} from "./types";

/// Native folder picker - the "connect to my repos" entry point.
export async function pickRepoFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open a Git repository",
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
export const listBranches = (repo: string) => invoke<BranchInfo[]>("list_branches", { repo });
export const listTags = (repo: string) => invoke<TagInfo[]>("list_tags", { repo });
export const fileDiff = (repo: string, path: string, staged: boolean, full = false) =>
  invoke<FileDiff>("file_diff", { repo, path, staged, full });
export const commitDiff = (repo: string, id: string) =>
  invoke<FileDiff[]>("commit_diff", { repo, id });

export const commit = (repo: string, message: string) =>
  invoke<string>("commit", { repo, message });
export const checkout = (repo: string, name: string) => invoke<void>("checkout", { repo, name });
export const createBranch = (repo: string, name: string, checkout: boolean) =>
  invoke<void>("create_branch", { repo, name, checkout });

export const push = (repo: string) => invoke<string>("push", { repo });
export type PullMode = "ff" | "ff-only" | "rebase";
export const pull = (repo: string, mode: PullMode) => invoke<string>("pull", { repo, mode });
export const fetchRemotes = (repo: string) => invoke<string>("fetch", { repo });
export const merge = (repo: string, branch: string) => invoke<string>("merge", { repo, branch });

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
export const savePatch = (repo: string, path: string, dest: string) =>
  invoke<void>("save_patch", { repo, path, dest });
export const deleteFile = (repo: string, path: string) =>
  invoke<void>("delete_file", { repo, path });
export const copyText = (text: string) => invoke<void>("copy_text", { text });
export const revealInFinder = (repo: string, path: string) =>
  invoke<void>("reveal_in_finder", { repo, path });
export const openDefault = (repo: string, path: string) =>
  invoke<void>("open_default", { repo, path });
export const openInEditor = (repo: string, path: string) =>
  invoke<void>("open_in_editor", { repo, path });
export const openDifftool = (repo: string, path: string) =>
  invoke<void>("open_difftool", { repo, path });
