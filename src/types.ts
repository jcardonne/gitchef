// Mirrors the serde structs returned by the Rust backend.

export type RemoteProvider = "github" | "gitlab";

export interface RepoInfo {
  path: string;
  name: string;
  head: string | null;
  // True when the current branch tracks a same-name remote branch; false means
  // push must publish (-u origin HEAD) first.
  has_upstream: boolean;
  // Provider inferred from the primary remote's host, or null for self-hosted /
  // unknown hosts (avatars then fall back to Gravatar).
  provider: RemoteProvider | null;
}

/// A user-assignable tab color. Each id maps to a `--tab-<id>` CSS variable
/// defined for both themes in styles.css.
export type TabColor = "red" | "amber" | "green" | "blue" | "purple";

/// Ordered palette shown in the tab context menu. Single source of truth: the
/// menu is generated from this list and each id has a matching `--tab-<id>` var.
export const TAB_COLORS: { id: TabColor; label: string }[] = [
  { id: "red", label: "Red" },
  { id: "amber", label: "Amber" },
  { id: "green", label: "Green" },
  { id: "blue", label: "Blue" },
  { id: "purple", label: "Purple" },
];

/// An open repository tab (path doubles as its stable id).
export interface Tab {
  path: string;
  name: string;
  /// Optional user-assigned color for visual differentiation; undefined = none.
  color?: TabColor;
}

export type FileStatusKind =
  | "new"
  | "modified"
  | "deleted"
  | "renamed"
  | "typechange"
  | "conflicted";

export interface FileStatus {
  path: string;
  old_path: string | null;
  status: FileStatusKind;
  staged: boolean;
}

export interface StatusResult {
  staged: FileStatus[];
  unstaged: FileStatus[];
}

export interface WorkStats {
  files: number;
  insertions: number;
  deletions: number;
}

export type RefKind = "head" | "branch" | "remote" | "tag" | "stash";

export interface RefLabel {
  name: string;
  kind: RefKind;
}

export interface CommitNode {
  id: string;
  short_id: string;
  summary: string;
  message: string;
  author: string;
  email: string;
  time: number;
  parents: string[];
  refs: RefLabel[];
  lane: number;
  color: number;
}

export interface BranchInfo {
  name: string;
  is_head: boolean;
  is_remote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  target: string | null;
}

/// A pull request (GitHub) / merge request (GitLab), normalized across providers.
/// GitLab rows are degraded: checks/review are "none" and author_avatar is null.
export interface PullRequest {
  number: number;
  title: string;
  url: string;
  branch: string; // source branch - links a PR to a branch row/badge
  draft: boolean;
  author: string;
  author_avatar: string | null;
  checks: "success" | "failure" | "pending" | "none";
  review: "approved" | "changes_requested" | "review_required" | "none";
}

export interface TagInfo {
  name: string;
  target: string; // commit SHA the tag points at
}

export interface RemoteInfo {
  name: string;
  url: string;
}

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string | null; // null when the worktree's HEAD is detached
  is_main: boolean;
  is_current: boolean; // the worktree this tab is opened on
  locked: boolean;
}

export interface StashInfo {
  sha: string; // the stash commit oid - what the stash actions address
  index: number; // position in the stash stack (0 = newest)
  message: string;
  time: number; // unix seconds
}

/// A git submodule with its recorded (superproject) vs checked-out commit.
export interface SubmoduleInfo {
  name: string;
  path: string; // relative to the superproject root
  url: string | null;
  head_sha: string | null; // commit the superproject records (the gitlink)
  workdir_sha: string | null; // commit actually checked out; differs when out of date
  initialized: boolean; // cloned + checked out (not an empty dir)
  dirty: boolean; // uncommitted changes inside the submodule
}

/// One commit in a file's history (the commit changed the file).
export interface FileHistoryEntry {
  id: string;
  short_id: string;
  summary: string;
  author: string;
  email: string;
  time: number;
}

/// A run of consecutive lines sharing a last-changing commit. `start_line` is
/// 1-based; `lines` is the run length.
export interface BlameHunkInfo {
  commit_id: string;
  short_id: string;
  author: string;
  time: number;
  start_line: number;
  lines: number;
}

/// One HEAD reflog entry: where HEAD moved to (`id`) and why (`message`).
export interface ReflogNode {
  id: string;
  short_id: string;
  message: string;
  author: string;
  email: string;
  time: number;
}

// Origin char from libgit2: context, added, removed, the eof-newline markers,
// and the file/hunk headers (filtered out before reaching DiffViewer).
export type DiffLineOrigin = " " | "+" | "-" | ">" | "<" | "F" | "H";

export interface DiffLine {
  origin: DiffLineOrigin;
  content: string;
  old_lineno: number | null;
  new_lineno: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  old_path: string | null;
  binary: boolean;
  status: FileStatusKind;
  hunks: DiffHunk[];
  truncated: boolean;
}

/// The raw file content shown by the "File" preview (vs the diff). `lines` is
/// capped on the backend unless a full load was requested.
export interface FileContent {
  path: string;
  binary: boolean;
  lines: string[];
  truncated: boolean;
}

/// An in-progress git operation paused mid-flight (conflicts or an `edit` stop).
/// `kind` is null when the working tree is clean (nothing paused).
export type SequencerKind = "rebase" | "merge" | "cherry_pick" | "revert";

export interface SequencerState {
  kind: SequencerKind | null;
  interactive: boolean; // true for an interactive rebase
  current: number; // step n of total (rebase only; 0 when unknown)
  total: number;
  onto: string | null; // short oid being replayed onto
  head_name: string | null; // branch being rebased
}

/// A conflicted file split into plain context and conflict blocks. `base` is set
/// only when the file carries diff3 markers (`|||||||`).
export type ConflictSegment =
  | { kind: "context"; lines: string[] }
  | { kind: "conflict"; ours: string[]; theirs: string[]; base: string[] | null };

export interface ConflictFile {
  path: string;
  segments: ConflictSegment[];
}

/// One line of an interactive-rebase plan. `message` carries the new commit
/// message for a `reword` (null otherwise).
export type RebaseAction = "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";

export interface TodoItem {
  action: RebaseAction;
  sha: string;
  summary: string;
  message: string | null;
}
