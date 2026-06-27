// Loading placeholder shown while libgit2 opens a repository. Mirrors the real
// toolbar + 3-pane shell (same layout classes) so content drops in without a
// jump. Pure presentational; the shimmer is a CSS pulse, reduced-motion-guarded.

// Per-row message widths - deliberately uneven so the graph column reads as real
// commit history rather than a uniform block.
const MSG_W = ["58%", "44%", "69%", "52%", "38%", "63%", "49%", "57%", "42%", "66%", "47%", "54%", "61%", "45%"];

export default function RepoSkeleton() {
  return (
    <>
      <div className="toolbar">
        <span className="skeleton" style={{ width: 60, height: 14 }} />
        <span className="skeleton" style={{ width: 96, height: 24, borderRadius: 6 }} />
        <span className="toolbar-spacer" />
        <span className="skeleton" style={{ width: 64, height: 28, borderRadius: 6 }} />
        <span className="skeleton" style={{ width: 64, height: 28, borderRadius: 6 }} />
        <span className="skeleton" style={{ width: 76, height: 28, borderRadius: 6 }} />
      </div>

      <div className="main">
        <div className="sidebar">
          {[0, 1, 2, 3].map((g) => (
            <div key={g} className="sk-group">
              <span className="skeleton" style={{ width: 88, height: 11 }} />
              {[0, 1, 2].map((r) => (
                <span
                  key={r}
                  className="skeleton"
                  style={{ width: `${52 + ((g * 3 + r) % 4) * 11}%`, height: 11 }}
                />
              ))}
            </div>
          ))}
        </div>

        <div className="center">
          <div className="center-graph">
            {MSG_W.map((w, i) => (
              <div key={i} className="sk-row">
                <span className="skeleton sk-dot" />
                <span className="skeleton" style={{ width: w, height: 11 }} />
                <span className="skeleton sk-author" />
                <span className="skeleton sk-sha" />
              </div>
            ))}
          </div>
        </div>

        <div className="right">
          <div className="sk-panel">
            <span className="skeleton" style={{ width: 130, height: 14 }} />
            <span className="skeleton" style={{ width: "82%", height: 11 }} />
            <span className="skeleton" style={{ width: "68%", height: 11 }} />
            <span className="skeleton" style={{ width: "74%", height: 11 }} />
            <span className="skeleton" style={{ width: "55%", height: 11 }} />
          </div>
        </div>
      </div>
    </>
  );
}
