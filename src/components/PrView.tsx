import React, { useEffect, useMemo, useRef, useState } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import Prism from "prismjs";
import "../highlight";
import type { FileDiff, PrDetails, PullRequest } from "../types";
import * as api from "../api";
import * as storage from "../storage";
import { relativeTime } from "../util";
import DiffViewer from "./DiffViewer";
import { CheckIcon, CloseIcon, PullRequestIcon } from "../icons";

interface Props {
  pr: PullRequest;
  path: string;
  isCurrentBranch: boolean;
  onCheckout: (number: number, branch: string) => void;
  onClose: () => void;
  onOpenUrl: (url: string) => void;
  notify: (msg: string) => void;
}

export default function PrView({
  pr,
  path,
  isCurrentBranch,
  onCheckout,
  onClose,
  onOpenUrl,
  notify,
}: Props) {
  const [details, setDetails] = useState<PrDetails | null>(null);
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "files" | "commits">("overview");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const [findOpen, setFindOpen] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [mergeMenuOpen, setMergeMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // ponytail: monotonic request ID so fast PR switching or slow diff loading never clobbers active PR
  const loadReq = useRef(0);
  const mergeMenuRef = useRef<HTMLDivElement>(null);

  // Persistence for viewed files per repository and PR
  const [viewedFiles, setViewedFiles] = useState<Set<string>>(() => {
    return new Set(storage.getPrViewedFiles(path, pr.number));
  });

  // Click outside to dismiss merge menu
  useEffect(() => {
    if (!mergeMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (mergeMenuRef.current && !mergeMenuRef.current.contains(e.target as Node)) {
        setMergeMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [mergeMenuOpen]);

  const toggleViewed = (filePath: string) => {
    setViewedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      storage.setPrViewedFiles(path, pr.number, Array.from(next));
      return next;
    });
  };

  const toggleAllViewed = () => {
    if (!diffs) return;
    const allViewed = diffs.every((f) => viewedFiles.has(f.path));
    const next = allViewed ? new Set<string>() : new Set(diffs.map((f) => f.path));
    setViewedFiles(next);
    storage.setPrViewedFiles(path, pr.number, Array.from(next));
  };

  const loadData = async () => {
    const req = ++loadReq.current;
    setLoading(true);
    setError(null);
    try {
      const d = await api.getPrDetails(path, pr.number);
      if (loadReq.current === req) {
        setDetails(d);
      }
    } catch (e) {
      if (loadReq.current === req) {
        setError(String(e));
      }
    } finally {
      if (loadReq.current === req) {
        setLoading(false);
      }
    }

    setDiffLoading(true);
    setDiffError(null);
    try {
      const diffList = await api.getPrDiff(path, pr.number);
      if (loadReq.current === req) {
        setDiffs(diffList);
        if (diffList.length > 0) {
          setSelectedFilePath((prev) => (prev && diffList.some((f) => f.path === prev) ? prev : diffList[0].path));
        }
      }
    } catch (e) {
      if (loadReq.current === req) {
        setDiffError(String(e));
        console.warn("Could not load PR diff:", e);
      }
    } finally {
      if (loadReq.current === req) {
        setDiffLoading(false);
      }
    }
  };

  // Re-sync viewed files, reset state, and reload when switching PRs
  useEffect(() => {
    setDetails(null);
    setDiffs(null);
    setError(null);
    setDiffError(null);
    setViewedFiles(new Set(storage.getPrViewedFiles(path, pr.number)));
    setSelectedFilePath(null);
    setFileFilter("");
    loadData();
  }, [path, pr.number]);

  // Filtered diffs according to file search
  const filteredDiffs = useMemo(() => {
    if (!diffs) return [];
    if (!fileFilter.trim()) return diffs;
    const q = fileFilter.toLowerCase().trim();
    return diffs.filter((f) => f.path.toLowerCase().includes(q));
  }, [diffs, fileFilter]);

  const selectedDiff = useMemo(() => {
    if (!diffs || diffs.length === 0) return null;
    if (selectedFilePath) {
      const match = diffs.find((f) => f.path === selectedFilePath);
      if (match) return match;
    }
    if (filteredDiffs.length > 0) return filteredDiffs[0];
    return diffs[0] ?? null;
  }, [diffs, selectedFilePath, filteredDiffs]);

  // Aggregate stats from details with fallback to diff hunks if details has 0 files / 0 stats
  const stats = useMemo(() => {
    let files = details?.changed_files ?? 0;
    let additions = details?.additions ?? 0;
    let deletions = details?.deletions ?? 0;

    if (diffs && (files === 0 || (additions === 0 && deletions === 0))) {
      files = diffs.length;
      additions = 0;
      deletions = 0;
      for (const f of diffs) {
        for (const h of f.hunks) {
          for (const l of h.lines) {
            if (l.origin === "+") additions++;
            else if (l.origin === "-") deletions++;
          }
        }
      }
    }
    return { files, additions, deletions };
  }, [details, diffs]);

  // Global & tab keyboard shortcuts with proper layering
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if (e.key === "Escape") {
        e.preventDefault();
        // Layered dismiss: merge menu -> find bar -> file filter -> close view
        if (mergeMenuOpen) {
          setMergeMenuOpen(false);
        } else if (findOpen) {
          setFindOpen(false);
        } else if (fileFilter) {
          setFileFilter("");
        } else {
          onClose();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        if (activeTab === "files") {
          e.preventDefault();
          setFindOpen((prev) => !prev);
        }
      } else if (activeTab === "files" && !isInput && filteredDiffs.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          const currentPath = selectedDiff?.path ?? filteredDiffs[0]?.path;
          const currentIdx = filteredDiffs.findIndex((f) => f.path === currentPath);
          const nextIdx = (currentIdx + 1) % filteredDiffs.length;
          setSelectedFilePath(filteredDiffs[nextIdx].path);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          const currentPath = selectedDiff?.path ?? filteredDiffs[0]?.path;
          const currentIdx = filteredDiffs.findIndex((f) => f.path === currentPath);
          const prevIdx = (currentIdx - 1 + filteredDiffs.length) % filteredDiffs.length;
          setSelectedFilePath(filteredDiffs[prevIdx].path);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, activeTab, filteredDiffs, selectedDiff, fileFilter, mergeMenuOpen, findOpen]);

  const handleApprove = async () => {
    setBusy(true);
    try {
      await api.approvePr(path, pr.number);
      notify("Pull request approved!");
      loadData();
    } catch (e) {
      notify(`Approve failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const handleMerge = async (method: "merge" | "squash" | "rebase") => {
    setMergeMenuOpen(false);
    setBusy(true);
    try {
      await api.mergePr(path, pr.number, method);
      notify(`Pull request merged (${method})!`);
      loadData();
    } catch (e) {
      notify(`Merge failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const formatIsoDate = (iso?: string | null) => {
    if (!iso) return "";
    const sec = Math.floor(new Date(iso).getTime() / 1000);
    return relativeTime(sec);
  };

  const prWebUrl = details?.url || pr.url;

  return (
    <div className="pr-view-root">
      {/* Top action / back bar */}
      <div className="pr-view-header">
        <div className="pr-header-left">
          <button className="pr-back-btn" onClick={onClose} title="Back to commit graph (Escape)">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M11 3L5 8l6 5" />
            </svg>
            <span>Back to graph</span>
            <kbd className="pr-kbd-badge">Esc</kbd>
          </button>

          {(() => {
            const isDraft = details ? details.draft : pr.draft;
            const statusKind = isDraft && (details?.state === "OPEN" || !details?.state)
              ? "draft"
              : (details?.state?.toLowerCase() || "open");
            const statusLabel = statusKind === "draft"
              ? "Draft"
              : statusKind.charAt(0).toUpperCase() + statusKind.slice(1);
            return (
              <span className={`pr-status-badge ${statusKind}`}>
                <PullRequestIcon size={12} />
                <span>{statusLabel}</span>
              </span>
            );
          })()}

          <div className="pr-view-title">
            <span
              className="pr-title-num copyable"
              title="Click to copy PR link"
              onClick={() => {
                void api.copyText(prWebUrl);
                notify("PR link copied to clipboard");
              }}
            >
              #{pr.number}
            </span>
            <span className="pr-title-text" title={details?.title || pr.title}>
              {details?.title || pr.title}
            </span>
          </div>
        </div>

        <div className="pr-header-right">
          {isCurrentBranch ? (
            <span className="pr-current-branch-badge">Current branch</span>
          ) : (
            <button
              className="mini-btn pr-action-btn"
              title={`Checkout #${pr.number} (${details?.branch || pr.branch}) locally`}
              disabled={busy}
              onClick={() => onCheckout(pr.number, details?.branch || pr.branch)}
            >
              Checkout branch
            </button>
          )}

          <button
            className="mini-btn pr-action-btn"
            title="Approve pull request via CLI"
            disabled={busy || details?.state === "MERGED" || details?.state === "CLOSED"}
            onClick={handleApprove}
          >
            <CheckIcon size={11} />
            <span>Approve</span>
          </button>

          <div className="pr-merge-dropdown-wrap" ref={mergeMenuRef}>
            <button
              className="mini-btn primary pr-action-btn"
              title="Merge options"
              disabled={busy || details?.state === "MERGED" || details?.state === "CLOSED"}
              onClick={() => setMergeMenuOpen((prev) => !prev)}
            >
              <span>Merge PR</span>
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>

            {mergeMenuOpen && (
              <div className="pr-merge-menu">
                <button onClick={() => handleMerge("merge")}>
                  <strong>Create merge commit</strong>
                  <small>All commits will be added with a merge commit.</small>
                </button>
                <button onClick={() => handleMerge("squash")}>
                  <strong>Squash and merge</strong>
                  <small>Combine all commits into a single commit.</small>
                </button>
                <button onClick={() => handleMerge("rebase")}>
                  <strong>Rebase and merge</strong>
                  <small>Rebase commits onto base branch without merge commit.</small>
                </button>
              </div>
            )}
          </div>

          <button
            className="mini-btn pr-action-btn"
            title="Open in web browser"
            onClick={() => onOpenUrl(prWebUrl)}
          >
            <span>Open in Browser</span>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 9v4H3V4h4M9 3h4v4M6.5 9.5L13 3" />
            </svg>
          </button>

          <button className="icon-btn pr-refresh-btn" title="Refresh PR" onClick={loadData} disabled={loading}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={loading ? "spin" : ""}>
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Meta subheader */}
      <div className="pr-view-meta">
        <div className="pr-view-meta-author">
          {details?.author_avatar || pr.author_avatar ? (
            <img className="pr-avatar" src={details?.author_avatar || pr.author_avatar!} alt="" />
          ) : (
            <span className="pr-avatar pr-avatar-fallback">{(details?.author || pr.author).charAt(0).toUpperCase()}</span>
          )}
          <span className="pr-meta-author-name">@{details?.author || pr.author}</span>
          <span className="pr-meta-dim">
            {details?.created_at ? `created ${formatIsoDate(details.created_at)}` : ""}
          </span>
        </div>

        <div className="pr-view-branch-pill">
          <span
            className="pr-branch-name base copyable"
            title="Click to copy base branch name"
            onClick={() => {
              void api.copyText(details?.base_branch || "main");
              notify("Base branch copied to clipboard");
            }}
          >
            {details?.base_branch || "main"}
          </span>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M11 8H3M8 5l-3 3 3 3" />
          </svg>
          <span
            className="pr-branch-name head copyable"
            title="Click to copy branch name"
            onClick={() => {
              void api.copyText(details?.branch || pr.branch);
              notify("Branch name copied to clipboard");
            }}
          >
            {details?.branch || pr.branch}
          </span>
        </div>

        {details && (
          <div className="pr-diff-stat-pills">
            <span className="pr-stat-files">{stats.files} files changed</span>
            <span className="pr-stat-add">+{stats.additions}</span>
            <span className="pr-stat-del">-{stats.deletions}</span>
          </div>
        )}
      </div>

      {/* Navigation tabs */}
      <div className="pr-view-tabs">
        <button
          className={`pr-tab ${activeTab === "overview" ? "active" : ""}`}
          onClick={() => setActiveTab("overview")}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 3.5h11v9H7l-3 2v-2H2.5v-9z" />
          </svg>
          <span>Overview</span>
        </button>

        <button
          className={`pr-tab ${activeTab === "files" ? "active" : ""}`}
          onClick={() => setActiveTab("files")}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 2.5h7l3 3V13.5H3V2.5z" />
            <path d="M10 2.5v3h3" />
          </svg>
          <span>Files Changed</span>
          {diffs && <span className="pr-tab-count">{diffs.length}</span>}
        </button>

        <button
          className={`pr-tab ${activeTab === "commits" ? "active" : ""}`}
          onClick={() => setActiveTab("commits")}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="3.2" />
            <path d="M1 8h3.8M11.2 8H15" />
          </svg>
          <span>Commits</span>
          {details?.commits && <span className="pr-tab-count">{details.commits.length}</span>}
        </button>
      </div>

      {/* Tab content */}
      <div className="pr-tab-body">
        {error && (
          <div className="pr-error-banner">
            <div className="pr-error-text">
              <strong>Could not load PR details:</strong> {error}
            </div>
            <div className="pr-error-actions">
              <button className="mini-btn" onClick={loadData}>Retry</button>
              <button className="mini-btn primary" onClick={() => onOpenUrl(prWebUrl)}>Open on Web</button>
            </div>
          </div>
        )}

        {loading && !details && (
          <div className="pr-loading-state">
            <div className="spinner" />
            <span>Loading pull request #{pr.number}…</span>
          </div>
        )}

        {/* Tab 1: Overview */}
        {activeTab === "overview" && details && (
          <div className="pr-overview-content">
            <div className="pr-overview-main">
              {/* Description */}
              <div className="pr-section-card pr-description-card">
                <div className="pr-section-header">Description</div>
                <div className="pr-markdown-body">
                  {details.body ? (
                    <SimpleMarkdown text={details.body} repoUrl={prWebUrl} />
                  ) : (
                    <div className="pr-empty-hint">No description provided.</div>
                  )}
                </div>
              </div>

              {/* Comments */}
              {details.comments.length > 0 && (
                <div className="pr-section-card pr-comments-card">
                  <div className="pr-section-header">Conversation ({details.comments.length})</div>
                  <div className="pr-comments-list">
                    {details.comments.map((cm, i) => (
                      <div key={i} className="pr-comment-item">
                        <div className="pr-comment-header">
                          {cm.author_avatar ? (
                            <img className="pr-avatar" src={cm.author_avatar} alt="" />
                          ) : (
                            <span className="pr-avatar pr-avatar-fallback">{cm.author.charAt(0).toUpperCase()}</span>
                          )}
                          <span className="pr-comment-author">@{cm.author}</span>
                          <span className="pr-meta-dim">{formatIsoDate(cm.created_at)}</span>
                        </div>
                        <div className="pr-comment-body">
                          <SimpleMarkdown text={cm.body} repoUrl={prWebUrl} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Sidebar info */}
            <div className="pr-overview-side">
              {/* Checks */}
              <div className="pr-side-card">
                <div className="pr-side-header">
                  <span>Checks & Workflows</span>
                  {details.checks.length > 0 && (
                    <span className="pr-side-count">{details.checks.length}</span>
                  )}
                </div>
                {details.checks.length === 0 ? (
                  <div className="pr-empty-hint small">No checks reported</div>
                ) : (
                  <div className="pr-checks-list">
                    {details.checks.map((chk, idx) => {
                      // ponytail: normalize outcomes across GitHub CheckRun conclusion & StatusContext state
                      const outcome = (chk.conclusion || chk.status || "").toUpperCase();
                      const isFail = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(outcome);
                      const isSuccess = ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(outcome);
                      return (
                        <div key={idx} className="pr-check-row">
                          <span className={`pr-check-icon ${isSuccess ? "pass" : isFail ? "fail" : "pending"}`}>
                            {isSuccess ? <CheckIcon size={10} /> : isFail ? <CloseIcon size={10} /> : "●"}
                          </span>
                          <div className="pr-check-info">
                            <div className="pr-check-name">{chk.name}</div>
                            {chk.workflow && <div className="pr-check-wf">{chk.workflow}</div>}
                          </div>
                          {chk.url && (
                            <button
                              className="mini-btn pr-check-link-btn"
                              title="Open job logs"
                              onClick={() => onOpenUrl(chk.url!)}
                            >
                              Logs
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Reviews */}
              <div className="pr-side-card">
                <div className="pr-side-header">
                  <span>Reviews</span>
                  {details.reviews.length > 0 && (
                    <span className="pr-side-count">{details.reviews.length}</span>
                  )}
                </div>
                {details.reviews.length === 0 ? (
                  <div className="pr-empty-hint small">No reviews submitted yet</div>
                ) : (
                  <div className="pr-reviews-list">
                    {details.reviews.map((rev, idx) => (
                      <div key={idx} className="pr-review-row">
                        {rev.author_avatar ? (
                          <img className="pr-avatar" src={rev.author_avatar} alt="" />
                        ) : (
                          <span className="pr-avatar pr-avatar-fallback">{rev.author.charAt(0).toUpperCase()}</span>
                        )}
                        <div className="pr-review-info">
                          <span className="pr-review-author">@{rev.author}</span>
                          <span className={`pr-review-state ${rev.state.toLowerCase()}`}>{rev.state}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: Files Changed */}
        {activeTab === "files" && (
          <div className="pr-files-layout">
            {diffLoading && !diffs ? (
              <div className="pr-loading-state">
                <div className="spinner" />
                <span>Loading pull request diffs…</span>
              </div>
            ) : diffs && diffs.length > 0 ? (
              <>
                <div className="pr-files-tree">
                  <div className="pr-files-tree-header">
                    <span>
                      Files ({filteredDiffs.length}
                      {filteredDiffs.length !== diffs.length ? ` of ${diffs.length}` : ""})
                    </span>
                    <div className="pr-diff-mode-toggle">
                      <button
                        className={`mini-btn ${diffMode === "unified" ? "primary" : ""}`}
                        onClick={() => setDiffMode("unified")}
                        title="Unified view"
                      >
                        Unified
                      </button>
                      <button
                        className={`mini-btn ${diffMode === "split" ? "primary" : ""}`}
                        onClick={() => setDiffMode("split")}
                        title="Side-by-side split view"
                      >
                        Split
                      </button>
                    </div>
                  </div>

                  {/* Viewed files progress & action */}
                  <div className="pr-viewed-summary-bar">
                    <div className="pr-viewed-count-label">
                      <span>{viewedFiles.size} of {diffs.length} viewed</span>
                      <button
                        className="pr-viewed-toggle-all-btn"
                        onClick={toggleAllViewed}
                        title={diffs.every((f) => viewedFiles.has(f.path)) ? "Reset viewed marks" : "Mark all files as viewed"}
                      >
                        {diffs.every((f) => viewedFiles.has(f.path)) ? "Unmark all" : "Mark all"}
                      </button>
                    </div>
                    <div className="pr-viewed-progress-track">
                      <div
                        className="pr-viewed-progress-fill"
                        style={{ width: `${diffs.length > 0 ? (viewedFiles.size / diffs.length) * 100 : 0}%` }}
                      />
                    </div>
                  </div>

                  {/* Filter input */}
                  <div className="pr-files-filter-box">
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="7" cy="7" r="5" />
                      <path d="M11 11l4 4" />
                    </svg>
                    <input
                      type="text"
                      className="pr-files-filter-input"
                      placeholder="Filter files (Esc to clear)…"
                      value={fileFilter}
                      onChange={(e) => setFileFilter(e.target.value)}
                    />
                    {fileFilter && (
                      <button className="pr-files-filter-clear" onClick={() => setFileFilter("")} title="Clear filter">
                        ✕
                      </button>
                    )}
                  </div>

                  {/* Files list */}
                  <div className="pr-files-list">
                    {filteredDiffs.length === 0 ? (
                      <div className="pr-empty-hint small">No files matching &quot;{fileFilter}&quot;</div>
                    ) : (
                      filteredDiffs.map((f) => {
                        const isViewed = viewedFiles.has(f.path);
                        const adds = f.hunks.reduce((acc, h) => acc + h.lines.filter((l) => l.origin === "+").length, 0);
                        const dels = f.hunks.reduce((acc, h) => acc + h.lines.filter((l) => l.origin === "-").length, 0);
                        const isSelected = selectedDiff?.path === f.path;
                        return (
                          <div
                            key={f.path}
                            className={`pr-file-item ${isSelected ? "selected" : ""} ${isViewed ? "viewed" : ""}`}
                            onClick={() => setSelectedFilePath(f.path)}
                            title={f.path}
                          >
                            <input
                              type="checkbox"
                              className="pr-file-viewed-check"
                              checked={isViewed}
                              onChange={(e) => {
                                e.stopPropagation();
                                toggleViewed(f.path);
                              }}
                              title={isViewed ? "Mark as not viewed" : "Mark as viewed"}
                            />
                            <span className={`pr-file-status-tag ${f.status}`}>{f.status.charAt(0).toUpperCase()}</span>
                            <span className="pr-file-path">{f.path}</span>
                            <span className="pr-file-stats">
                              {adds > 0 && <span className="stat-add">+{adds}</span>}
                              {dels > 0 && <span className="stat-del">-{dels}</span>}
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                <div className="pr-files-viewer">
                  <DiffViewer
                    diff={selectedDiff}
                    mode={diffMode}
                    findOpen={findOpen}
                    onFindClose={() => setFindOpen(false)}
                  />
                </div>
              </>
            ) : diffError ? (
              <div className="pr-empty-hint error">
                <div>Failed to load diff: {diffError}</div>
                <button className="mini-btn" onClick={loadData} style={{ marginTop: 8 }}>
                  Retry
                </button>
              </div>
            ) : (
              <div className="pr-empty-hint">No file changes in this pull request.</div>
            )}
          </div>
        )}

        {/* Tab 3: Commits */}
        {activeTab === "commits" && details && (
          <div className="pr-commits-layout">
            <div className="pr-commits-list">
              {details.commits.length === 0 ? (
                <div className="pr-empty-hint">No commits found in this pull request.</div>
              ) : (
                details.commits.map((cm) => (
                  <div key={cm.oid} className="pr-commit-row">
                    <div className="pr-commit-left">
                      <span className="pr-commit-sha">{cm.oid.slice(0, 7)}</span>
                      <div className="pr-commit-titles">
                        <div className="pr-commit-headline">{cm.headline}</div>
                        {cm.body && <div className="pr-commit-body-text">{cm.body}</div>}
                      </div>
                    </div>
                    <div className="pr-commit-right">
                      <span className="pr-commit-author">{cm.author}</span>
                      <span className="pr-meta-dim">{formatIsoDate(cm.date)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Full GitHub Flavored Markdown (GFM) renderer for PR descriptions and comments:
 * - GFM tables (with alignment, code inside tables, links)
 * - Horizontal rules (---)
 * - Nested lists & task lists (- [x] / - [ ])
 * - Collapsible <details><summary> sections
 * - Code fences highlighted via PrismJS
 * - Markdown images ![alt](url) with click-to-open
 * - Issue #123 & mention @username auto-linking
 * - External link safety via Tauri api.openUrl
 * - Sanitized via DOMPurify
 */
function SimpleMarkdown({ text, repoUrl }: { text: string; repoUrl?: string }) {
  const html = useMemo(() => {
    if (!text) return "";
    const repoBaseUrl = repoUrl ? repoUrl.replace(/\/(?:pull|merge_requests)\/\d+.*$/, "") : "";
    const isGithub = !repoBaseUrl || repoBaseUrl.includes("github.com");

    const instance = new Marked({
      gfm: true,
      breaks: true,
    });

    instance.use({
      extensions: [
        {
          name: "issueRef",
          level: "inline",
          start(src: string) {
            const match = /(?:^|\s)#\d+/.exec(src);
            return match ? match.index + (match[0].startsWith(" ") ? 1 : 0) : undefined;
          },
          tokenizer(src: string) {
            const match = /^#(\d+)\b/.exec(src);
            if (match) {
              return {
                type: "issueRef",
                raw: match[0],
                num: match[1],
              };
            }
          },
          renderer(token: any) {
            const href = repoBaseUrl ? `${repoBaseUrl}/issues/${token.num}` : "";
            return `<a href="${href || "#"}" class="md-issue-tag" data-issue="${token.num}">#${token.num}</a>`;
          },
        },
        {
          name: "userMention",
          level: "inline",
          start(src: string) {
            const match = /(?:^|\s)@[a-zA-Z0-9_\-]+/.exec(src);
            return match ? match.index + (match[0].startsWith(" ") ? 1 : 0) : undefined;
          },
          tokenizer(src: string) {
            const match = /^@([a-zA-Z0-9_\-]+)\b/.exec(src);
            if (match) {
              return {
                type: "userMention",
                raw: match[0],
                username: match[1],
              };
            }
          },
          renderer(token: any) {
            const href = isGithub ? `https://github.com/${token.username}` : "";
            return `<a href="${href || "#"}" class="md-mention" data-user="${token.username}">@${token.username}</a>`;
          },
        },
      ],
      renderer: {
        code({ text, lang }: { text: string; lang?: string }) {
          const cleanLang = lang ? lang.split(/\s+/)[0].toLowerCase() : "";
          const grammar = cleanLang && Prism.languages[cleanLang] ? Prism.languages[cleanLang] : null;
          const highlighted = grammar ? Prism.highlight(text, grammar, cleanLang) : escapeHtml(text);
          return `<pre class="md-code-block"><code class="language-${cleanLang || "text"}">${highlighted}</code></pre>`;
        },
        image({ href, title, text }: { href: string; title?: string | null; text: string }) {
          const titleAttr = title || text || "Image";
          return `<span class="md-image-card"><img src="${href}" alt="${escapeHtml(text || "")}" class="md-image" loading="lazy" title="${escapeHtml(titleAttr)} · Click to open" />${text ? `<span class="md-image-caption">${escapeHtml(text)}</span>` : ""}</span>`;
        },
        link({ href, title, text }: { href: string; title?: string | null; text: string }) {
          const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
          return `<a href="${href}"${titleAttr} class="md-link" target="_blank" rel="noopener noreferrer">${text}</a>`;
        },
      },
    });

    const raw = instance.parse(text) as string;
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ["target", "rel", "loading", "data-issue", "data-user", "type", "checked", "disabled"],
      ADD_TAGS: ["details", "summary", "input"],
    });
  }, [text, repoUrl]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const link = target.closest("a");
    if (link) {
      const href = link.getAttribute("href");
      if (href && (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:"))) {
        e.preventDefault();
        e.stopPropagation();
        void api.openUrl(href);
        return;
      }
    }
    const img = target.closest("img");
    if (img && img.src) {
      e.preventDefault();
      e.stopPropagation();
      void api.openUrl(img.src);
      return;
    }
  };

  return (
    <div
      className="simple-markdown"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
    />
  );
}
