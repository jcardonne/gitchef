import type { ReactNode } from "react";

// Large, subtle illustration icons for empty states (stroke matches the existing
// graph/staging empty-state icons; .empty-state svg dims + sizes them in CSS).

export function DocIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 2.5h5l3 3v7.4a.6.6 0 0 1-.6.6H4.6a.6.6 0 0 1-.6-.6V3.1a.6.6 0 0 1 .6-.6z" />
      <path d="M9 2.6V5.4h2.9" />
      <path d="M6 8.5h4M6 10.5h3" />
    </svg>
  );
}

export function BinaryIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="3" width="11" height="10" rx="1.4" />
      <path d="M5.6 6.4v3.2" />
      <rect x="8.4" y="6.4" width="2.4" height="3.2" rx="1.2" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.7" />
      <path d="M5.5 8.2l1.7 1.7 3.3-3.5" />
    </svg>
  );
}

/// Composed empty/idle state: centered icon, title, and optional hint. Shared by
/// the diff and file preview panes (the graph + staging panes inline the same
/// `.empty-state` markup directly).
export default function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div className="empty-state">
      {icon}
      <div className="empty-state-title">{title}</div>
      {hint && <div className="empty-state-hint">{hint}</div>}
    </div>
  );
}
