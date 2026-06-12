import { useState } from "react";
import type { BranchInfo, RepoInfo } from "../types";
import { getPullDefault, setPullDefault, type PullAction } from "../storage";
import { comboHint } from "../shortcuts";

interface Props {
  repo: RepoInfo;
  busy: boolean;
  branches: BranchInfo[];
  onCheckout: (name: string) => void;
  onPullAction: (action: PullAction) => void;
  onPush: () => void;
  onNewBranch: () => void;
}

const svg = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const FetchIcon = () => (
  <svg {...svg}>
    <path d="M13.7 7A5.7 5.7 0 0 0 3.2 4.8" />
    <path d="M2.3 9A5.7 5.7 0 0 0 12.8 11.2" />
    <path d="M13.5 2.2V4.9H10.8" />
    <path d="M2.5 13.8V11.1H5.2" />
  </svg>
);
const PullIcon = () => (
  <svg {...svg}>
    <path d="M8 2v8" />
    <path d="M4.5 6.5 8 10l3.5-3.5" />
    <path d="M3 14h10" />
  </svg>
);
const PushIcon = () => (
  <svg {...svg}>
    <path d="M3 2h10" />
    <path d="M8 14V6" />
    <path d="M4.5 9.5 8 6l3.5 3.5" />
  </svg>
);
const BranchIcon = () => (
  <svg {...svg}>
    <circle cx="5" cy="4" r="1.6" />
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="11" cy="6.5" r="1.6" />
    <path d="M5 5.6v4.8M5 8h2.5A3 3 0 0 0 10.5 5" />
  </svg>
);
const Caret = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 6l4 4 4-4" />
  </svg>
);

const PULL_OPTIONS: { key: PullAction; label: string }[] = [
  { key: "fetch", label: "Fetch All" },
  { key: "ff", label: "Pull (fast-forward if possible)" },
  { key: "ff-only", label: "Pull (fast-forward only)" },
  { key: "rebase", label: "Pull (rebase)" },
];

/// Per-repo action bar: branch picker + pull split-button + push/branch.
export default function Toolbar({
  repo,
  busy,
  branches,
  onCheckout,
  onPullAction,
  onPush,
  onNewBranch,
}: Props) {
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [pullOpen, setPullOpen] = useState(false);
  const [pullDefault, setPullDefaultState] = useState<PullAction>(getPullDefault());

  const locals = branches.filter((b) => !b.is_remote);
  const filtered = locals.filter((b) =>
    b.name.toLowerCase().includes(branchQuery.toLowerCase())
  );

  const runPull = (action: PullAction) => {
    setPullDefault(action);
    setPullDefaultState(action);
    onPullAction(action);
    setPullOpen(false);
  };

  return (
    <div className="toolbar">
      <span className="repo-name">{repo.name}</span>

      <div className="branch-picker">
        <button className="branch-trigger" onClick={() => setBranchOpen((o) => !o)}>
          <BranchIcon />
          <span className="branch-trigger-name">{repo.head ?? "—"}</span>
          <Caret />
        </button>
        {branchOpen && (
          <>
            <div className="dropdown-backdrop" onClick={() => setBranchOpen(false)} />
            <div className="branch-menu">
              <input
                autoFocus
                className="branch-menu-search"
                placeholder="Search"
                value={branchQuery}
                onChange={(e) => setBranchQuery(e.target.value)}
              />
              <div className="branch-menu-list">
                {filtered.length === 0 && <div className="empty-hint small">No branches</div>}
                {filtered.map((b) => (
                  <div
                    key={b.name}
                    className={`branch-menu-item${b.is_head ? " current" : ""}`}
                    onClick={() => {
                      if (!b.is_head) onCheckout(b.name);
                      setBranchOpen(false);
                    }}
                  >
                    <BranchIcon />
                    <span className="branch-menu-name">{b.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="toolbar-spacer" />

      <div className="split-btn">
        <button
          className="tool-btn split-main"
          disabled={busy}
          onClick={() => onPullAction(pullDefault)}
          title={`${pullDefault === "fetch" ? "Fetch" : "Pull"} (${comboHint(["mod", "shift", "L"])})`}
        >
          {pullDefault === "fetch" ? <FetchIcon /> : <PullIcon />}
          {pullDefault === "fetch" ? "Fetch" : "Pull"}
        </button>
        <button className="tool-btn split-caret" disabled={busy} onClick={() => setPullOpen((o) => !o)}>
          <Caret />
        </button>
        {pullOpen && (
          <>
            <div className="dropdown-backdrop" onClick={() => setPullOpen(false)} />
            <div className="pull-menu">
              <div className="pull-menu-head">Default pull / fetch action</div>
              {PULL_OPTIONS.map((o) => (
                <div key={o.key} className="pull-menu-item" onClick={() => runPull(o.key)}>
                  <span className={`radio${pullDefault === o.key ? " on" : ""}`} />
                  {o.label}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <button
        className="tool-btn"
        disabled={busy}
        onClick={onPush}
        title={`${repo.has_upstream ? "Push" : "Publish branch: push and set upstream"} (${comboHint(["mod", "shift", "P"])})`}
      >
        <PushIcon />
        {repo.has_upstream ? "Push" : "Publish"}
      </button>
      <button className="tool-btn" disabled={busy} onClick={onNewBranch}>
        <BranchIcon />
        Branch
      </button>
    </div>
  );
}
