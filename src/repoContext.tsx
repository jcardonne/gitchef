import { createContext, useContext } from "react";
import type { StatusResult } from "./types";

/// Options for `RepoActions.refresh`. Both gates default to true (a full
/// refresh); callers on the working-tree-only hot path opt out of the parts a
/// stage / unstage / discard can't change, so the commit graph isn't re-walked
/// and re-rendered on every staging action.
export interface RefreshOpts {
  /** Re-walk the commit graph + branches + tags (history / ref state). */
  history?: boolean;
  /** Recompute the work-tree +insertions / -deletions / files totals. */
  stats?: boolean;
}

/// Cross-cutting primitives every repo-scoped component needs: which repo it
/// acts on, the busy flag, and the run/refresh/notify action bus. Provided by
/// RepoView so children don't have to drill these props.
export interface RepoActions {
  repoPath: string;
  busy: boolean;
  activeAction: string | null;
  run: (fn: () => Promise<void>, action?: string) => void;
  refresh: (opts?: RefreshOpts) => Promise<StatusResult>;
  notify: (msg: string, error?: boolean) => void;
}

export const RepoContext = createContext<RepoActions | null>(null);

export function useRepo(): RepoActions {
  const ctx = useContext(RepoContext);
  if (!ctx) throw new Error("useRepo must be used inside a RepoContext provider");
  return ctx;
}
