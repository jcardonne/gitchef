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
  return (
    <div className="home">
      <div className="home-inner">
        <h1>GitChef</h1>
        <p>Open-source visual Git client.</p>
        <button className="primary-btn home-open" onClick={onOpen}>
          Open a repository
        </button>

        {recents.length > 0 && (
        <div className="recents">
          <div className="recents-title">Recent</div>
          {recents.map((r) => (
            <div key={r.path} className="recent-row" onClick={() => onOpenRecent(r.path)}>
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
                ✕
              </button>
            </div>
          ))}
        </div>
        )}
      </div>
    </div>
  );
}
