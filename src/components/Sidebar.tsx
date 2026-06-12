import { useState, type ReactNode } from "react";
import type { BranchInfo, TagInfo } from "../types";
import { getSidebarGroups, setSidebarGroups } from "../storage";

const LocalIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="12" height="8" rx="1.3" />
    <path d="M8 11v2.5M5.5 13.5h5" />
  </svg>
);
const RemoteIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.5 12.5a3 3 0 0 1-.3-6A3.6 3.6 0 0 1 11 5.3a2.8 2.8 0 0 1 .4 7.2H4.5z" />
  </svg>
);
const TagsIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 8.3V3.2a.7.7 0 0 1 .7-.7h5.1L14 7.8a1 1 0 0 1 0 1.4l-3.8 3.8a1 1 0 0 1-1.4 0L2.5 8.3z" />
    <circle cx="5.2" cy="5.2" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

interface Props {
  branches: BranchInfo[];
  tags: TagInfo[];
  selectedCommit: string | null;
  onCheckout: (name: string) => void;
  onMerge: (name: string) => void;
  onBranchMenu: (branch: BranchInfo) => void;
  onSelectTag: (target: string) => void;
  onCheckoutTag: (name: string) => void;
  onTagMenu: (name: string, target: string) => void;
  onSectionMenu: (section: "local" | "remote" | "tags") => void;
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
  onBranchMenu,
  onSelectTag,
  onCheckoutTag,
  onTagMenu,
  onSectionMenu,
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
      <Group title="Local" icon={<LocalIcon />} count={local.length} open={open.local} onToggle={() => toggle("local")} onMenu={() => onSectionMenu("local")}>
        {local.length === 0 && <div className="empty-hint small">No branches</div>}
        {local.map((b) => (
          <div
            key={b.name}
            className={`branch-row${b.is_head ? " head" : ""}`}
            onClick={() => !b.is_head && onCheckout(b.name)}
            onContextMenu={(e) => {
              e.preventDefault();
              onBranchMenu(b);
            }}
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

      <Group title="Remote" icon={<RemoteIcon />} count={remote.length} open={open.remote} onToggle={() => toggle("remote")} onMenu={() => onSectionMenu("remote")}>
        {remote.length === 0 && <div className="empty-hint small">No remotes</div>}
        {remote.map((b) => (
          <div
            key={b.name}
            className="branch-row remote"
            onContextMenu={(e) => {
              e.preventDefault();
              onBranchMenu(b);
            }}
          >
            <span className="branch-name">{b.name}</span>
          </div>
        ))}
      </Group>

      <Group title="Tags" icon={<TagsIcon />} count={tags.length} open={open.tags} onToggle={() => toggle("tags")} onMenu={() => onSectionMenu("tags")}>
        {tags.length === 0 && <div className="empty-hint small">No tags</div>}
        {tags.map((t) => (
          <div
            key={t.name}
            className={`branch-row tag${selectedCommit === t.target ? " selected" : ""}`}
            title="Click to inspect · double-click to checkout"
            onClick={() => onSelectTag(t.target)}
            onDoubleClick={() => onCheckoutTag(t.name)}
            onContextMenu={(e) => {
              e.preventDefault();
              onTagMenu(t.name, t.target);
            }}
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
  icon,
  count,
  open,
  onToggle,
  onMenu,
  children,
}: {
  title: string;
  icon: ReactNode;
  count: number;
  open: boolean;
  onToggle: () => void;
  onMenu?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="sidebar-group">
      <div
        className="sidebar-title"
        onClick={onToggle}
        onContextMenu={
          onMenu
            ? (e) => {
                e.preventDefault();
                onMenu();
              }
            : undefined
        }
      >
        <span className="group-icon">{icon}</span>
        <span className="group-name">{title}</span>
        <span className="group-count">{count}</span>
      </div>
      {open && <div className="group-body">{children}</div>}
    </div>
  );
}
