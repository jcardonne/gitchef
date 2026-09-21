import React, { useEffect, useMemo, useState } from "react";
import type { FileDiff, PrDetails, PullRequest } from "../types";
import * as api from "../api";
import { relativeTime } from "../util";
import DiffViewer from "./DiffViewer";
import { CheckIcon, CloseIcon, PullRequestIcon } from "../icons";

interface Props {
  pr: PullRequest;
  path: string;
  isCurrentBranch: boolean;
  onCheckout: (branch: string) => void;
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
  const [activeTab, setActiveTab] = useState<"overview" | "files" | "commits">("overview");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const [findOpen, setFindOpen] = useState(false);
  const [mergeMenuOpen, setMergeMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Close on Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        if (activeTab === "files") {
          e.preventDefault();
          setFindOpen((prev) => !prev);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, activeTab]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.getPrDetails(path, pr.number);
      setDetails(d);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }

    setDiffLoading(true);
    try {
      const diffList = await api.getPrDiff(path, pr.number);
      setDiffs(diffList);
      if (diffList.length > 0 && !selectedFilePath) {
        setSelectedFilePath(diffList[0].path);
      }
    } catch (e) {
      console.warn("Could not load PR diff:", e);
    } finally {
      setDiffLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [path, pr.number]);

  const selectedDiff = useMemo(() => {
    if (!diffs || !selectedFilePath) return null;
    return diffs.find((f) => f.path === selectedFilePath) ?? diffs[0] ?? null;
  }, [diffs, selectedFilePath]);

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

  return (
    <div className="pr-view-root">
      {/* Top action / back bar */}
      <div className="pr-view-header">
        <div className="pr-view-header-left">
          <button className="pr-back-btn" onClick={onClose} title="Back to graph (Esc)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M11 3L5 8l6 5" />
            </svg>
            <span>Back to graph</span>
          </button>
          <span className="pr-header-divider" />
          <span className={`pr-status-badge ${details?.state?.toLowerCase() || (pr.draft ? "draft" : "open")}`}>
            <PullRequestIcon size={12} />
            <span>{details?.state ? details.state.charAt(0) + details.state.slice(1).toLowerCase() : pr.draft ? "Draft" : "Open"}</span>
          </span>
          <span className="pr-header-title">
            <span className="pr-header-num">#{pr.number}</span>
            <span className="pr-header-text">{details?.title || pr.title}</span>
          </span>
        </div>

        <div className="pr-view-header-right">
          {!isCurrentBranch && (
            <button
              className="mini-btn pr-action-btn"
              title={`Checkout '${details?.branch || pr.branch}' locally`}
              disabled={busy}
              onClick={() => onCheckout(details?.branch || pr.branch)}
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

          <div className="pr-merge-dropdown-wrap">
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
            onClick={() => onOpenUrl(details?.url || pr.url)}
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
          <span className="pr-branch-name base">{details?.base_branch || "main"}</span>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M11 8H3M8 5l-3 3 3 3" />
          </svg>
          <span className="pr-branch-name head">{details?.branch || pr.branch}</span>
        </div>

        {details && (
          <div className="pr-diff-stat-pills">
            <span className="pr-stat-files">{details.changed_files} files changed</span>
            <span className="pr-stat-add">+{details.additions}</span>
            <span className="pr-stat-del">-{details.deletions}</span>
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
              <button className="mini-btn primary" onClick={() => onOpenUrl(pr.url)}>Open on Web</button>
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
                    <SimpleMarkdown text={details.body} />
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
                          <SimpleMarkdown text={cm.body} />
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
                      const isSuccess = chk.conclusion === "SUCCESS" || chk.status === "SUCCESS";
                      const isFail = chk.conclusion === "FAILURE" || chk.conclusion === "ERROR" || chk.status === "FAILURE";
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
                    <span>Changed Files ({diffs.length})</span>
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

                  <div className="pr-files-list">
                    {diffs.map((f) => {
                      const adds = f.hunks.reduce((acc, h) => acc + h.lines.filter((l) => l.origin === "+").length, 0);
                      const dels = f.hunks.reduce((acc, h) => acc + h.lines.filter((l) => l.origin === "-").length, 0);
                      const isSelected = (selectedDiff?.path ?? diffs[0]?.path) === f.path;
                      return (
                        <div
                          key={f.path}
                          className={`pr-file-item ${isSelected ? "selected" : ""}`}
                          onClick={() => setSelectedFilePath(f.path)}
                          title={f.path}
                        >
                          <span className={`pr-file-status-tag ${f.status}`}>{f.status.charAt(0).toUpperCase()}</span>
                          <span className="pr-file-path">{f.path}</span>
                          <span className="pr-file-stats">
                            {adds > 0 && <span className="stat-add">+{adds}</span>}
                            {dels > 0 && <span className="stat-del">-{dels}</span>}
                          </span>
                        </div>
                      );
                    })}
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

/**
 * Lightweight, safe markdown formatter for PR descriptions and comments.
 */
function SimpleMarkdown({ text }: { text: string }) {
  const rendered = useMemo(() => {
    const lines = text.split("\n");
    const elements: React.ReactNode[] = [];
    let inCodeBlock = false;
    let codeLines: string[] = [];

    lines.forEach((line, idx) => {
      if (line.startsWith("```")) {
        if (inCodeBlock) {
          elements.push(
            <pre key={`code-${idx}`} className="md-code-block">
              <code>{codeLines.join("\n")}</code>
            </pre>
          );
          codeLines = [];
          inCodeBlock = false;
        } else {
          inCodeBlock = true;
        }
        return;
      }

      if (inCodeBlock) {
        codeLines.push(line);
        return;
      }

      if (line.startsWith("### ")) {
        elements.push(<h4 key={idx} className="md-h3">{renderInline(line.slice(4))}</h4>);
      } else if (line.startsWith("## ")) {
        elements.push(<h3 key={idx} className="md-h2">{renderInline(line.slice(3))}</h3>);
      } else if (line.startsWith("# ")) {
        elements.push(<h2 key={idx} className="md-h1">{renderInline(line.slice(2))}</h2>);
      } else if (line.startsWith("> ")) {
        elements.push(<blockquote key={idx} className="md-quote">{renderInline(line.slice(2))}</blockquote>);
      } else if (line.startsWith("- [x] ") || line.startsWith("- [X] ")) {
        elements.push(
          <div key={idx} className="md-task checked">
            <input type="checkbox" checked readOnly />
            <span>{renderInline(line.slice(6))}</span>
          </div>
        );
      } else if (line.startsWith("- [ ] ")) {
        elements.push(
          <div key={idx} className="md-task">
            <input type="checkbox" checked={false} readOnly />
            <span>{renderInline(line.slice(6))}</span>
          </div>
        );
      } else if (line.startsWith("- ") || line.startsWith("* ")) {
        elements.push(
          <li key={idx} className="md-li">
            {renderInline(line.slice(2))}
          </li>
        );
      } else if (line.trim() === "") {
        elements.push(<div key={idx} className="md-spacer" />);
      } else {
        elements.push(<p key={idx} className="md-p">{renderInline(line)}</p>);
      }
    });

    if (inCodeBlock && codeLines.length > 0) {
      elements.push(
        <pre key="code-tail" className="md-code-block">
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
    }

    return elements;
  }, [text]);

  return <div className="simple-markdown">{rendered}</div>;
}

function renderInline(str: string): React.ReactNode[] {
  // Matches inline code `code`, bold **bold**, and links [text](url)
  const parts: React.ReactNode[] = [];
  let remaining = str;
  let key = 0;

  while (remaining.length > 0) {
    const codeMatch = remaining.match(/`([^`]+)`/);
    const boldMatch = remaining.match(/\*\*([^*]+)\*\*/);
    const linkMatch = remaining.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);

    const matchIndices = [
      codeMatch ? { type: "code", index: codeMatch.index!, match: codeMatch } : null,
      boldMatch ? { type: "bold", index: boldMatch.index!, match: boldMatch } : null,
      linkMatch ? { type: "link", index: linkMatch.index!, match: linkMatch } : null,
    ].filter(Boolean) as { type: string; index: number; match: RegExpMatchArray }[];

    if (matchIndices.length === 0) {
      parts.push(remaining);
      break;
    }

    matchIndices.sort((a, b) => a.index - b.index);
    const first = matchIndices[0];

    if (first.index > 0) {
      parts.push(remaining.slice(0, first.index));
    }

    if (first.type === "code") {
      parts.push(<code key={key++} className="md-inline-code">{first.match[1]}</code>);
      remaining = remaining.slice(first.index + first.match[0].length);
    } else if (first.type === "bold") {
      parts.push(<strong key={key++}>{first.match[1]}</strong>);
      remaining = remaining.slice(first.index + first.match[0].length);
    } else if (first.type === "link") {
      parts.push(
        <a key={key++} href={first.match[2]} target="_blank" rel="noreferrer" className="md-link">
          {first.match[1]}
        </a>
      );
      remaining = remaining.slice(first.index + first.match[0].length);
    }
  }

  return parts;
}
