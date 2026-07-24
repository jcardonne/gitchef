import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import * as api from "../api";
import type { RecentRepo } from "../storage";
import { relativeTime } from "../util";

interface Props {
  recents: RecentRepo[];
  onOpen: () => void;
  onClone: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
}

const FolderIcon = () => (
  <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.5 4.2a1 1 0 0 1 1-1h3.2l1.5 1.6h6.3a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
  </svg>
);
const CloneGlyph = () => (
  <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 1.5v7.5" />
    <path d="M5 6l3 3 3-3" />
    <path d="M2.5 11v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V11" />
  </svg>
);
const RepoGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.5 4.2a1 1 0 0 1 1-1h3.2l1.5 1.6h6.3a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
  </svg>
);

/// The Home tab: launch a repo (open local / clone) or jump back into a recent one.
export default function Home({ recents, onOpen, onClone, onOpenRecent, onRemoveRecent }: Props) {
  const showRecentMenu = async (r: RecentRepo) => {
    const items = await Promise.all([
      MenuItem.new({ text: "Open", action: () => onOpenRecent(r.path) }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: "Copy Path", action: () => void api.copyText(r.path).catch(console.error) }),
      MenuItem.new({ text: "Reveal in Finder", action: () => void api.revealPath(r.path).catch(console.error) }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: "Remove from Recents", action: () => onRemoveRecent(r.path) }),
    ]);
    await (await Menu.new({ items })).popup();
  };
  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-hero">
          <span className="home-logo-wrap">
            <img className="home-logo" src="/logo.png" alt="" />
          </span>
          <h1>GitChef</h1>
          <p className="home-tagline">A fast, native, open-source Git client.</p>
          <span className="home-version">v{__APP_VERSION__}</span>
        </div>

        <div className="home-cards">
          <button className="home-card" onClick={onOpen}>
            <span className="home-card-icon"><FolderIcon /></span>
            <span className="home-card-text">
              <span className="home-card-title">Open a repository</span>
              <span className="home-card-sub">From a folder on your machine</span>
            </span>
          </button>
          <button className="home-card" onClick={onClone}>
            <span className="home-card-icon"><CloneGlyph /></span>
            <span className="home-card-text">
              <span className="home-card-title">Clone a repository</span>
              <span className="home-card-sub">From GitHub, GitLab, or a URL</span>
            </span>
          </button>
        </div>

        {recents.length > 0 && (
          <div className="recents">
            <div className="recents-title">Recent</div>
            {recents.map((r) => (
              <div
                key={r.path}
                className="recent-row"
                onClick={() => onOpenRecent(r.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void showRecentMenu(r);
                }}
              >
                <span className="recent-glyph"><RepoGlyph /></span>
                <div className="recent-main">
                  <span className="recent-name">{r.name}</span>
                  <span className="recent-path">{r.path}</span>
                </div>
                <span className="recent-time">{relativeTime(r.lastOpened / 1000)}</span>
                <button
                  className="recent-remove"
                  title="Remove from recents"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveRecent(r.path);
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
