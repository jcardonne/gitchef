import type { RepoInfo } from "../types";

interface Props {
  repo: RepoInfo | null;
  busy: boolean;
  onOpen: () => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onNewBranch: () => void;
}

export default function Toolbar({
  repo,
  busy,
  onOpen,
  onFetch,
  onPull,
  onPush,
  onNewBranch,
}: Props) {
  return (
    <div className="toolbar">
      <div className="brand">
        <span className="brand-mark">⌥</span> GitChef
      </div>

      <button className="tool-btn" onClick={onOpen}>
        Open
      </button>

      {repo && (
        <>
          <div className="repo-label">
            <span className="repo-name">{repo.name}</span>
            {repo.head && <span className="repo-head">⌥ {repo.head}</span>}
          </div>
          <div className="toolbar-spacer" />
          <button className="tool-btn" disabled={busy} onClick={onFetch}>
            Fetch
          </button>
          <button className="tool-btn" disabled={busy} onClick={onPull}>
            Pull
          </button>
          <button className="tool-btn" disabled={busy} onClick={onPush}>
            Push
          </button>
          <button className="tool-btn" disabled={busy} onClick={onNewBranch}>
            Branch
          </button>
        </>
      )}
    </div>
  );
}
