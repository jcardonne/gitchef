// Mirrors the serde structs returned by the Rust backend.

export interface RepoInfo {
  path: string;
  name: string;
  head: string | null;
}

export interface FileStatus {
  path: string;
  status: string; // new | modified | deleted | renamed | typechange | conflicted
  staged: boolean;
}

export interface StatusResult {
  staged: FileStatus[];
  unstaged: FileStatus[];
}

export interface CommitNode {
  id: string;
  short_id: string;
  summary: string;
  author: string;
  email: string;
  time: number;
  parents: string[];
  refs: string[];
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

export interface DiffLine {
  origin: string; // ' ' | '+' | '-' | '>' | '<'
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
}
