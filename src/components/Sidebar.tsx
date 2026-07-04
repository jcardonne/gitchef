import { useState, type ReactNode } from "react";
import type { BranchInfo, StashInfo, SubmoduleInfo, TagInfo, WorktreeInfo } from "../types";
import { relativeTime } from "../util";
import { getSidebarGroups, setSidebarGroups } from "../storage";

const LocalIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="12" height="8" rx="1.3" />
    <path d="M8 11v2.5M5.5 13.5h5" />
  </svg>
);
const RemoteIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.5 12.5a3 3 0 0 1-.3-6A3.6 3.6 0 0 1 11 5.3a2.8 2.8 0 0 1 .4 7.2H4.5z" />
  </svg>
);
const TagsIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 8.3V3.2a.7.7 0 0 1 .7-.7h5.1L14 7.8a1 1 0 0 1 0 1.4l-3.8 3.8a1 1 0 0 1-1.4 0L2.5 8.3z" />
    <circle cx="5.2" cy="5.2" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);
const WorktreeIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="3.2" r="1.5" />
    <circle cx="3.8" cy="12.8" r="1.5" />
    <circle cx="12.2" cy="12.8" r="1.5" />
    <path d="M8 4.7V9M3.8 9H12.2M3.8 9V11.3M12.2 9V11.3" />
  </svg>
);
const StashIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 5.5 3.2 3h9.6L14 5.5" />
    <rect x="2" y="5.5" width="12" height="7" rx="1" />
    <path d="M6 8.5h4" />
  </svg>
);
const RefreshIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
    <path d="M13.5 2v3h-3" />
  </svg>
);
const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);
const SubmoduleIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="2.5" width="8" height="8" rx="1.2" />
    <rect x="6" y="6.5" width="8" height="7" rx="1.2" />
  </svg>
);
const DownloadIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 2.5v7M5 7l3 3 3-3M3 13h10" />
  </svg>
);

interface Props {
  branches: BranchInfo[];
  tags: TagInfo[];
  worktrees: WorktreeInfo[];
  submodules: SubmoduleInfo[];
  stashes: StashInfo[];
  /// Per-worktree dirty flags keyed by worktree path, refreshed on demand.
  wips: Record<string, boolean>;
  selectedCommit: string | null;
  onCheckout: (name: string) => void;
  onMerge: (name: string) => void;
  onBranchMenu: (branch: BranchInfo) => void;
  onSelectTag: (target: string) => void;
  onCheckoutTag: (name: string) => void;
  onTagMenu: (name: string, target: string) => void;
  onSectionMenu: (section: "local" | "remote" | "tags") => void;
  onOpenWorktree: (path: string) => void;
  onRefreshWips: () => void;
  onAddWorktree: () => void;
  onOpenSubmodule: (path: string) => void;
  onSubmoduleMenu: (sub: SubmoduleInfo) => void;
  onUpdateAllSubmodules: () => void;
  onSelectStash: (sha: string) => void;
  onStashMenu: (stash: StashInfo) => void;
}

/// Left rail with collapsible Local / Remote / Tags / Worktrees / Stashes
/// sections. Branch: click = checkout, hover = Merge. Tag: click = inspect its
/// commit, double-click = checkout (detached). Worktree: click = open it in a
/// new tab; hover the header for refresh-WIPs / add-worktree. Stash: click =
/// inspect, right-click = apply / pop / drop / edit.
export default function Sidebar({
  branches,
  tags,
  worktrees,
  submodules,
  stashes,
  wips,
  selectedCommit,
  onCheckout,
  onMerge,
  onBranchMenu,
  onSelectTag,
  onCheckoutTag,
  onTagMenu,
  onSectionMenu,
  onOpenWorktree,
  onRefreshWips,
  onAddWorktree,
  onOpenSubmodule,
  onSubmoduleMenu,
  onUpdateAllSubmodules,
  onSelectStash,
  onStashMenu,
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

  // Hover-revealed header buttons for the Worktrees section. stopPropagation so
  // a click acts instead of toggling the section open/closed.
  const worktreeActions = (
    <span className="group-actions">
      <button
        className="group-action"
        title="Refresh work-in-progress indicators"
        onClick={(e) => {
          e.stopPropagation();
          onRefreshWips();
        }}
      >
        <RefreshIcon />
      </button>
      <button
        className="group-action"
        title="Add a new workspace (worktree)"
        onClick={(e) => {
          e.stopPropagation();
          onAddWorktree();
        }}
      >
        <PlusIcon />
      </button>
    </span>
  );

  // Hover-revealed "update all submodules" button (init + checkout recorded commits).
  const submoduleActions = (
    <span className="group-actions">
      <button
        className="group-action"
        title="Update all submodules (init + checkout recorded commits)"
        onClick={(e) => {
          e.stopPropagation();
          onUpdateAllSubmodules();
        }}
      >
        <DownloadIcon />
      </button>
    </span>
  );

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

      <Group title="Worktrees" icon={<WorktreeIcon />} count={worktrees.length} open={open.worktrees} onToggle={() => toggle("worktrees")} actions={worktreeActions}>
        {worktrees.length === 0 && <div className="empty-hint small">No worktrees</div>}
        {worktrees.map((w) => (
          <div
            key={w.path}
            className={`branch-row worktree${w.is_current ? " current" : ""}`}
            title={w.path}
            onClick={() => !w.is_current && onOpenWorktree(w.path)}
          >
            <span className="branch-name">{w.branch ?? w.name}</span>
            {w.locked && (
              <span className="wt-lock" title="Locked" aria-label="locked">
                🔒
              </span>
            )}
            {wips[w.path] && <span className="wt-dot" title="Uncommitted changes" />}
          </div>
        ))}
      </Group>

      <Group title="Submodules" icon={<SubmoduleIcon />} count={submodules.length} open={open.submodules} onToggle={() => toggle("submodules")} actions={submodules.length ? submoduleActions : undefined}>
        {submodules.length === 0 && <div className="empty-hint small">No submodules</div>}
        {submodules.map((sm) => {
          const stale = sm.initialized && sm.head_sha !== sm.workdir_sha;
          return (
            <div
              key={sm.path}
              className={`branch-row submodule${sm.initialized ? "" : " uninit"}`}
              title={`${sm.path}${sm.url ? ` · ${sm.url}` : ""}`}
              onClick={() => sm.initialized && onOpenSubmodule(sm.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                onSubmoduleMenu(sm);
              }}
            >
              <span className="branch-name">{sm.name || sm.path}</span>
              {!sm.initialized && (
                <span className="sm-badge" title="Not initialized - update to clone it">
                  init
                </span>
              )}
              {stale && (
                <span
                  className="sm-badge stale"
                  title={`Out of date: recorded ${sm.head_sha ?? "?"}, checked out ${sm.workdir_sha ?? "?"}`}
                >
                  ⇄
                </span>
              )}
              {sm.dirty && <span className="wt-dot" title="Uncommitted changes" />}
            </div>
          );
        })}
      </Group>

      <Group title="Stashes" icon={<StashIcon />} count={stashes.length} open={open.stashes} onToggle={() => toggle("stashes")}>
        {stashes.length === 0 && <div className="empty-hint small">No stashes</div>}
        {stashes.map((s) => (
          <div
            key={s.sha}
            className={`branch-row stash${selectedCommit === s.sha ? " selected" : ""}`}
            title={s.message}
            onClick={() => onSelectStash(s.sha)}
            onContextMenu={(e) => {
              e.preventDefault();
              onStashMenu(s);
            }}
          >
            <span className="branch-name">{s.message}</span>
            <span className="stash-time">{relativeTime(s.time)}</span>
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
  actions,
  children,
}: {
  title: string;
  icon: ReactNode;
  count: number;
  open: boolean;
  onToggle: () => void;
  onMenu?: () => void;
  actions?: ReactNode;
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
        <svg
          className={`chevron${open ? " open" : ""}`}
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 3.5 10.5 8 6 12.5" />
        </svg>
        <span className="group-icon">{icon}</span>
        <span className="group-name">{title}</span>
        <span className="group-count">{count}</span>
        {actions}
      </div>
      {open && <div className="group-body">{children}</div>}
    </div>
  );
}
