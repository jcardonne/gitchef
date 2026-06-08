import { createContext, useContext } from "react";

/// Cross-cutting primitives every repo-scoped component needs: which repo it
/// acts on, the busy flag, and the run/refresh/notify action bus. Provided by
/// RepoView so children don't have to drill these props.
export interface RepoActions {
  repoPath: string;
  busy: boolean;
  run: (fn: () => Promise<void>) => void;
  refresh: () => Promise<void>;
  notify: (msg: string, error?: boolean) => void;
}

export const RepoContext = createContext<RepoActions | null>(null);

export function useRepo(): RepoActions {
  const ctx = useContext(RepoContext);
  if (!ctx) throw new Error("useRepo must be used inside a RepoContext provider");
  return ctx;
}
