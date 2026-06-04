import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  BranchInfo,
  CommitNode,
  FileDiff,
  RepoInfo,
  StatusResult,
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

export const openRepo = (path: string) => invoke<RepoInfo>("open_repo", { path });
export const repoStatus = () => invoke<StatusResult>("repo_status");
export const commitGraph = (limit = 500) =>
  invoke<CommitNode[]>("commit_graph", { limit });
export const listBranches = () => invoke<BranchInfo[]>("list_branches");
export const fileDiff = (path: string, staged: boolean) =>
  invoke<FileDiff>("file_diff", { path, staged });
export const commitDiff = (id: string) =>
  invoke<FileDiff[]>("commit_diff", { id });

export const stage = (path: string) => invoke<void>("stage", { path });
export const unstage = (path: string) => invoke<void>("unstage", { path });
export const stageAll = () => invoke<void>("stage_all");
export const unstageAll = () => invoke<void>("unstage_all");
export const discard = (path: string) => invoke<void>("discard", { path });
export const commit = (message: string) => invoke<string>("commit", { message });

export const checkout = (name: string) => invoke<void>("checkout", { name });
export const createBranch = (name: string, checkout: boolean) =>
  invoke<void>("create_branch", { name, checkout });

export const push = () => invoke<string>("push");
export const pull = () => invoke<string>("pull");
export const fetch = () => invoke<string>("fetch");
export const merge = (branch: string) => invoke<string>("merge", { branch });
