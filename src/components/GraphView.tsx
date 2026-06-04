import { useMemo } from "react";
import type { CommitNode } from "../types";
import { laneColor, relativeTime } from "../util";

const ROW_H = 48;
const LANE_W = 16;
const DOT_R = 5;
const PAD_X = 14;

interface Props {
  nodes: CommitNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/// Renders the commit DAG: an SVG of lanes/edges/dots on the left, aligned
/// row-for-row with commit text on the right. Both use the same ROW_H so the
/// dot always sits next to its message.
export default function GraphView({ nodes, selectedId, onSelect }: Props) {
  const index = useMemo(() => {
    const m = new Map<string, number>();
    nodes.forEach((n, i) => m.set(n.id, i));
    return m;
  }, [nodes]);

  const maxLane = nodes.reduce((m, n) => Math.max(m, n.lane), 0);
  const graphWidth = PAD_X + (maxLane + 1) * LANE_W;
  const x = (lane: number) => PAD_X + lane * LANE_W;
  const y = (i: number) => i * ROW_H + ROW_H / 2;

  if (nodes.length === 0) {
    return <div className="empty-hint">No commits yet.</div>;
  }

  return (
    <div className="graph">
      <svg
        className="graph-svg"
        width={graphWidth}
        height={nodes.length * ROW_H}
        style={{ minWidth: graphWidth }}
      >
        {/* edges first so dots paint over them */}
        {nodes.map((n, i) =>
          n.parents.map((pid) => {
            const j = index.get(pid);
            if (j === undefined) return null;
            const x1 = x(n.lane);
            const y1 = y(i);
            const x2 = x(nodes[j].lane);
            const y2 = y(j);
            const mid = (y1 + y2) / 2;
            const d = `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
            return (
              <path
                key={`${n.id}-${pid}`}
                d={d}
                fill="none"
                stroke={laneColor(n.color)}
                strokeWidth={1.6}
              />
            );
          })
        )}
        {nodes.map((n, i) => (
          <circle
            key={n.id}
            cx={x(n.lane)}
            cy={y(i)}
            r={n.refs.length ? DOT_R + 1.5 : DOT_R}
            fill={laneColor(n.color)}
            stroke={n.id === selectedId ? "#fff" : "#11151c"}
            strokeWidth={n.id === selectedId ? 2 : 1.5}
          />
        ))}
      </svg>

      <div className="graph-rows">
        {nodes.map((n) => (
          <div
            key={n.id}
            className={`commit-row${n.id === selectedId ? " selected" : ""}`}
            style={{ height: ROW_H }}
            onClick={() => onSelect(n.id)}
          >
            <div className="commit-line">
              {n.refs.map((r) => (
                <span
                  key={r}
                  className={`ref-chip${r.includes("/") ? " remote" : ""}`}
                  style={{ borderColor: laneColor(n.color) }}
                >
                  {r}
                </span>
              ))}
              <span className="commit-summary">{n.summary || "(no message)"}</span>
            </div>
            <div className="commit-meta">
              {n.author} · {n.short_id} · {relativeTime(n.time)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
