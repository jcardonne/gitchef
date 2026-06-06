import { useState, type ReactNode } from "react";
import type { BranchInfo, TagInfo } from "../types";
import { getSidebarGroups, setSidebarGroups } from "../storage";

interface Props {
  branches: BranchInfo[];
  tags: TagInfo[];
  selectedCommit: string | null;
  onCheckout: (name: string) => void;
  onMerge: (name: string) => void;
  onSelectTag: (target: string) => void;
  onCheckoutTag: (name: string) => void;
}

/// Left rail with collapsible Local / Remote / Tags sections.
/// Branch: click = checkout, hover = Merge. Tag: click = inspect its commit,
/// double-click = checkout (detached).
export default function Sidebar({
  branches,
  tags,
  selectedCommit,
  onCheckout,
  onMerge,
  onSelectTag,
  onCheckoutTag,
}: Props) {
  const [open, setOpen] = useState(getSidebarGroups);
  const toggle = (k: keyof typeof open) =>
    setOpen((o) => {
      const next = { ...o, [k]: !o[k] };
      setSidebarGroups(next);
      return next;
    });

  const local = branches.filter((b) => !b.is_remote);
  const remote = branches.filter((b) => b.is_remote);

  return (
    <div className="sidebar">
      <Group title="Local" count={local.length} open={open.local} onToggle={() => toggle("local")}>
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
            {!b.is_head && (
              <button
                className="mini-btn branch-merge"
                title={`Merge ${b.name} into current branch`}
                onClick={(e) => {
                  e.stopPropagation();
                  onMerge(b.name);
                }}
              >
                Merge
              </button>
            )}
          </div>
        ))}
      </Group>

      <Group title="Remote" count={remote.length} open={open.remote} onToggle={() => toggle("remote")}>
        {remote.length === 0 && <div className="empty-hint small">No remotes</div>}
        {remote.map((b) => (
          <div key={b.name} className="branch-row remote">
            <span className="branch-name">{b.name}</span>
          </div>
        ))}
      </Group>

      <Group title="Tags" count={tags.length} open={open.tags} onToggle={() => toggle("tags")}>
        {tags.length === 0 && <div className="empty-hint small">No tags</div>}
        {tags.map((t) => (
          <div
            key={t.name}
            className={`branch-row tag${selectedCommit === t.target ? " selected" : ""}`}
            title="Click to inspect · double-click to checkout"
            onClick={() => onSelectTag(t.target)}
            onDoubleClick={() => onCheckoutTag(t.name)}
          >
            <span className="tag-glyph">⌖</span>
            <span className="branch-name">{t.name}</span>
          </div>
        ))}
      </Group>
    </div>
  );
}

function Group({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="sidebar-group">
      <div className="sidebar-title" onClick={onToggle}>
        <span className={`chevron${open ? " open" : ""}`}>▸</span>
        <span className="group-name">{title}</span>
        <span className="group-count">{count}</span>
      </div>
      {open && <div className="group-body">{children}</div>}
    </div>
  );
}
