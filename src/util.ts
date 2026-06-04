// Lane colors for the commit graph - cycled by `color` index from the backend.
export const LANE_COLORS = [
  "#22c5a4", // teal (brand)
  "#6ea8fe",
  "#f7768e",
  "#e0af68",
  "#bb9af7",
  "#7dcfff",
  "#9ece6a",
  "#ff9e64",
];

export const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

export function relativeTime(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return "just now";
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
