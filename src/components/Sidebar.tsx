import { useState, type ReactNode } from "react";
import type { BranchInfo, PullRequest, StashInfo, SubmoduleInfo, TagInfo, WorktreeInfo } from "../types";
import { relativeTime } from "../util";
import { getSidebarGroups, setSidebarGroups } from "../storage";
import { CheckIcon, CloseIcon, LocalIcon, LockIcon, PullRequestIcon, RemoteIcon, StashIcon, TagIcon } from "../icons";

const WorktreeIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="3.2" r="1.5" />
    <circle cx="3.8" cy="12.8" r="1.5" />
    <circle cx="12.2" cy="12.8" r="1.5" />
    <path d="M8 4.7V9M3.8 9H12.2M3.8 9V11.3M12.2 9V11.3" />
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
  prs: PullRequest[];
  /// Per-worktree dirty flags keyed by worktree path, refreshed on demand.
  wips: Record<string, boolean>;
  selectedCommit: string | null;
  /// Jump the graph to a branch's tip commit (does NOT checkout).
  onSelectBranch: (target: string) => void;
  onOpenPr: (url: string) => void;
  onPrMenu: (pr: PullRequest) => void;
  onRefreshPrs: () => void;
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
/// sections. Branch: click = jump the graph to its tip (checkout lives in the
/// right-click menu), hover = Merge. Tag: click = jump to its commit,
/// double-click = checkout (detached). Worktree: click = open it in a new tab;
/// hover the header for refresh-WIPs / add-worktree. Stash: click = inspect,
/// right-click = apply / pop / drop / edit.
export default function Sidebar({
  branches,
  tags,
  worktrees,
  submodules,
  stashes,
  prs,
  wips,
  selectedCommit,
  onSelectBranch,
  onOpenPr,
  onPrMenu,
  onRefreshPrs,
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

  // Hover-revealed "refresh pull requests" button (a network CLI call, on demand).
  const prActions = (
    <span className="group-actions">
      <button
        className="group-action"
        title="Refresh pull requests"
        onClick={(e) => {
          e.stopPropagation();
          onRefreshPrs();
        }}
      >
        <RefreshIcon />
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
            className={`branch-row${b.is_head ? " head" : ""}${selectedCommit && selectedCommit === b.target ? " selected" : ""}`}
            onClick={() => b.target && onSelectBranch(b.target)}
            onDoubleClick={() => !b.is_head && onCheckout(b.name)}
            onContextMenu={(e) => {
              e.preventDefault();
              onBranchMenu(b);
            }}
            title={b.upstream ? `${b.upstream}\nClick to reveal · double-click to checkout` : "Click to reveal · double-click to checkout"}
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
            className={`branch-row remote${selectedCommit && selectedCommit === b.target ? " selected" : ""}`}
            title="Click to reveal in the graph"
            onClick={() => b.target && onSelectBranch(b.target)}
            onContextMenu={(e) => {
              e.preventDefault();
              onBranchMenu(b);
            }}
          >
            <span className="branch-name">{b.name}</span>
          </div>
        ))}
      </Group>

      <Group title="Pull Requests" icon={<PullRequestIcon />} count={prs.length} open={open.pullRequests} onToggle={() => toggle("pullRequests")} actions={prs.length ? prActions : undefined}>
        {prs.length === 0 && <div className="empty-hint small">No open pull requests</div>}
        {prs.map((pr) => (
          <div
            key={pr.number}
            className="branch-row pr"
            title={`#${pr.number} ${pr.title}\n${pr.branch} · @${pr.author}`}
            onClick={() => onOpenPr(pr.url)}
            onContextMenu={(e) => {
              e.preventDefault();
              onPrMenu(pr);
            }}
          >
            {pr.author_avatar ? (
              <img className="pr-avatar" src={pr.author_avatar} alt="" />
            ) : (
              <span className="pr-avatar pr-avatar-fallback" aria-hidden="true">
                {pr.author.charAt(0).toUpperCase() || "?"}
              </span>
            )}
            <span className="pr-num">#{pr.number}</span>
            {pr.checks !== "none" && (
              <span className={`pr-ci pr-ci-${pr.checks}`} title={`CI: ${pr.checks}`} />
            )}
            {pr.review === "approved" && (
              <span className="pr-review approved" title="Approved">
                <CheckIcon size={11} />
              </span>
            )}
            {pr.review === "changes_requested" && (
              <span className="pr-review changes" title="Changes requested">
                <CloseIcon size={11} />
              </span>
            )}
            <span className="branch-name pr-title">{pr.title}</span>
            {pr.draft && (
              <span className="sm-badge" title="Draft">
                draft
              </span>
            )}
          </div>
        ))}
      </Group>

      <Group title="Tags" icon={<TagIcon />} count={tags.length} open={open.tags} onToggle={() => toggle("tags")} onMenu={() => onSectionMenu("tags")}>
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
            <span className="tag-glyph"><TagIcon size={11} /></span>
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
                <LockIcon size={12} />
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
