// Mirrors the serde structs returned by the Rust backend.

export type RemoteProvider = "github" | "gitlab";

export interface RepoInfo {
  path: string;
  name: string;
  head: string | null;
  // True when the current branch tracks a same-name remote branch; false means
  // push must publish (-u origin HEAD) first.
  has_upstream: boolean;
  // Host of the primary remote (origin, else first remote), e.g. "github.com",
  // "gitlab.com", "gitlab.example.com"; null when the repo has no remote.
  remote_host: string | null;
  // Provider inferred from remote_host, or null for self-hosted / unknown hosts
  // (avatars then fall back to Gravatar).
  provider: RemoteProvider | null;
}

/// An open repository tab (path doubles as its stable id).
export interface Tab {
  path: string;
  name: string;
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

export interface TagInfo {
  name: string;
  target: string; // commit SHA the tag points at
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
  binary: boolean;
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
