import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import * as api from "../api";
import type { RecentRepo } from "../storage";
import { relativeTime } from "../util";

interface Props {
  recents: RecentRepo[];
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
}

/// The Home tab: open a new repo, or jump back into a recently opened one.
export default function Home({ recents, onOpen, onOpenRecent, onRemoveRecent }: Props) {
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
        <img className="home-logo" src="/logo.png" alt="" />
        <h1>GitChef</h1>
        <p>
          Open-source visual Git client.
          <span className="home-version">v{__APP_VERSION__}</span>
        </p>
        <button className="primary-btn home-open" onClick={onOpen}>
          Open a repository
        </button>

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
              <div className="recent-main">
                <span className="recent-name">{r.name}</span>
                <span className="recent-path">{r.path}</span>
              </div>
              <span className="recent-time">{relativeTime(r.lastOpened / 1000)}</span>
              <button
                className="mini-btn"
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
