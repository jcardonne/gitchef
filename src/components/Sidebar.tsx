import type { BranchInfo } from "../types";

interface Props {
  branches: BranchInfo[];
  onCheckout: (name: string) => void;
}

/// Left rail: local branches (checkout on click) and remote branches, grouped.
export default function Sidebar({ branches, onCheckout }: Props) {
  const local = branches.filter((b) => !b.is_remote);
  const remote = branches.filter((b) => b.is_remote);

  return (
    <div className="sidebar">
      <div className="sidebar-group">
        <div className="sidebar-title">Local</div>
        {local.length === 0 && <div className="empty-hint small">No branches</div>}
        {local.map((b) => (
          <div
            key={b.name}
            className={`branch-row${b.is_head ? " head" : ""}`}
            onClick={() => !b.is_head && onCheckout(b.name)}
            title={b.upstream ?? undefined}
          >
            <span className="branch-name">{b.name}</span>
            {(b.ahead > 0 || b.behind > 0) && (
              <span className="ab">
                {b.ahead > 0 && <span className="ahead">↑{b.ahead}</span>}
                {b.behind > 0 && <span className="behind">↓{b.behind}</span>}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="sidebar-group">
        <div className="sidebar-title">Remote</div>
        {remote.length === 0 && <div className="empty-hint small">No remotes</div>}
        {remote.map((b) => (
          <div key={b.name} className="branch-row remote">
            <span className="branch-name">{b.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
