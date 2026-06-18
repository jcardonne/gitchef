// Builds dist/demo.html: the real built GitChef bundle, but with the Tauri IPC
// bridge shimmed to serve canned fixture data, so the UI renders in a plain
// browser (Puppeteer) for README screenshots. Throwaway tooling.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const index = readFileSync(join(root, "dist/index.html"), "utf8");

// The shim is a CLASSIC script: it runs at parse time, before the deferred
// `type=module` app bundle, so window.__TAURI_INTERNALS__ + localStorage are
// set before any app code (including TabBar's module-load getCurrentWindow()).
const shim = /* js */ `
<script>
(() => {
  const S = new URLSearchParams(location.search).get("s") || "graph";
  const REPO = "/Users/dev/Projects/GitChef";

  // --- seed persistence (theme + restored session) BEFORE the app boots ---
  localStorage.setItem("gitchef.theme", "dark");
  localStorage.setItem("gitchef.session", JSON.stringify({ paths: [REPO], activePath: REPO }));
  localStorage.setItem("gitchef.recents", JSON.stringify([
    { path: REPO, name: "GitChef", lastOpened: Date.now() },
    { path: "/Users/dev/Projects/orchard", name: "orchard", lastOpened: Date.now() - 9e6 },
  ]));

  // --- avatars as offline data-URIs (no network in headless) ---
  const av = (initials, bg) => "data:image/svg+xml;base64," + btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
    '<rect width="64" height="64" rx="32" fill="' + bg + '"/>' +
    '<text x="32" y="42" font-family="Inter,Arial,sans-serif" font-size="26" font-weight="600" ' +
    'fill="#fff" text-anchor="middle">' + initials + '</text></svg>'
  );
  const PEOPLE = {
    "jean@cardonne.dev":   { name: "Jean Cardonne",  a: av("JC", "#22c5a4") },
    "maya@orchard.io":     { name: "Maya Lindqvist", a: av("ML", "#6ea8fe") },
    "ren@hexlab.dev":      { name: "Ren Takahashi",  a: av("RT", "#bb9af7") },
    "ola@coastline.app":   { name: "Ola Berg",       a: av("OB", "#e0af68") },
  };
  const AVATARS = Object.fromEntries(Object.entries(PEOPLE).map(([e, p]) => [e, p.a]));

  const HOUR = 3600, DAY = 86400;
  const now = Math.floor(Date.now() / 1000);
  let _h = 0;
  const sha = (n) => (n + "f3a9c12b84e7d6005a1b2c3d4e5f60718293a4b5").slice(0, 40);
  // commit factory; t = seconds-ago
  const C = (i, summary, email, t, parents, refs = [], lane = 0, color = 0, body = "") => ({
    id: sha("c" + i), short_id: sha("c" + i).slice(0, 7),
    summary, message: body ? summary + "\\n\\n" + body : summary,
    author: PEOPLE[email].name, email, time: now - t,
    parents: parents.map((p) => sha("c" + p)), refs, lane, color,
  });

  // --- commit DAG (newest first), with a merged feature branch, tag, stash ---
  const NODES = [
    C(0, "Merge branch 'feature/line-staging'", "jean@cardonne.dev", 2*HOUR, [1, 4],
      [{name:"main",kind:"head"},{name:"main",kind:"branch"},{name:"origin/main",kind:"remote"}], 0, 0,
      "Bring per-line hunk staging into main."),
    C(1, "perf(diff): virtualize the unified diff view", "jean@cardonne.dev", 6*HOUR, [2], [], 0, 0,
      "Mount only the rows in (and around) the viewport so a 160k-line\\ndiff scrolls at 60fps. Padding spacers fake the scroll height."),
    C(2, "fix(graph): align avatar dots with their commit rows", "maya@orchard.io", 9*HOUR, [3], [], 0, 0),
    C(3, "feat(sidebar): worktrees & stashes sections", "maya@orchard.io", 1*DAY, [7],
      [{name:"v0.12.0",kind:"tag"}], 0, 0),
    // feature branch (lane 1)
    C(4, "feat(diff): stage individual lines from a hunk", "ren@hexlab.dev", 5*HOUR, [5],
      [{name:"feature/line-staging",kind:"branch"}], 1, 1,
      "Click-select changed lines; right-click to stage/unstage/discard\\njust the selection."),
    C(5, "feat(diff): inline hunk-level staging", "ren@hexlab.dev", 8*HOUR, [7], [], 1, 1),
    // stash node (lane 2, diamond)
    { id: sha("s0"), short_id: sha("s0").slice(0,7), summary: "WIP on main: graph spine experiment",
      message: "WIP on main: graph spine experiment", author: PEOPLE["jean@cardonne.dev"].name,
      email: "jean@cardonne.dev", time: now - 30*HOUR, parents: [sha("c7")],
      refs: [{name:"stash@{0}",kind:"stash"}], lane: 2, color: 4 },
    C(7, "refactor(repo): stateless, per-path backend commands", "jean@cardonne.dev", 2*DAY, [8], [], 0, 0),
    C(8, "feat(tabs): tabbed multi-repository workspace", "ola@coastline.app", 3*DAY, [9], [], 0, 0),
    C(9, "feat: author avatars from the repo's remote provider", "maya@orchard.io", 4*DAY, [10],
      [{name:"v0.11.0",kind:"tag"}], 0, 0),
    C(10, "feat: commit graph with branches, tags & remotes", "jean@cardonne.dev", 5*DAY, [11], [], 0, 0),
    C(11, "feat: staging panel + inline diff viewer", "ren@hexlab.dev", 6*DAY, [12], [], 0, 0),
    C(12, "chore: scaffold Tauri 2 + React + libgit2", "jean@cardonne.dev", 7*DAY, [], [], 0, 0),
  ];

  const BRANCHES = [
    { name: "main", is_head: true, is_remote: false, upstream: "origin/main", ahead: 1, behind: 0, target: sha("c0") },
    { name: "feature/line-staging", is_head: false, is_remote: false, upstream: null, ahead: 2, behind: 1, target: sha("c4") },
    { name: "release/0.12", is_head: false, is_remote: false, upstream: null, ahead: 0, behind: 0, target: sha("c3") },
    { name: "origin/main", is_head: false, is_remote: true, upstream: null, ahead: 0, behind: 0, target: sha("c1") },
    { name: "origin/feature/line-staging", is_head: false, is_remote: true, upstream: null, ahead: 0, behind: 0, target: sha("c5") },
  ];
  const TAGS = [ { name: "v0.12.0", target: sha("c3") }, { name: "v0.11.0", target: sha("c9") } ];
  const WORKTREES = [
    { name: "GitChef", path: REPO, branch: "main", is_main: true, is_current: true, locked: false },
    { name: "hotfix-0.12.1", path: "/Users/dev/Projects/gitchef-hotfix", branch: "release/0.12", is_main: false, is_current: false, locked: false },
  ];
  const STASHES = [ { sha: sha("s0"), index: 0, message: "WIP on main: graph spine experiment", time: now - 30*HOUR } ];

  // --- diffs ---
  const ctx = (s, o, n) => ({ origin: " ", content: s, old_lineno: o, new_lineno: n });
  const add = (s, n) => ({ origin: "+", content: s, old_lineno: null, new_lineno: n });
  const del = (s, o) => ({ origin: "-", content: s, old_lineno: o, new_lineno: null });

  const DIFF_VIRTUAL = { path: "src/components/DiffViewer.tsx", binary: false, truncated: false, hunks: [
    { header: "@@ -28,11 +28,18 @@ export default function DiffViewer({ diff }: Props) {", lines: [
      ctx("  const rows = useMemo<Row[]>(() => {", 28, 28),
      ctx("    if (!diff) return [];", 29, 29),
      del("    return diff.hunks.flatMap((h, hi) => [", 30),
      del("      { hunk: h.header, hi },", 31),
      del("      ...h.lines.map((l) => ({ line: l, hi })),", 32),
      del("    ]);", 33),
      add("    const out: Row[] = [];", 30),
      add("    diff.hunks.forEach((h, hi) => {", 31),
      add("      if (h.header) out.push({ hunk: h.header, hi });", 32),
      add("      for (const l of h.lines) out.push({ line: l, hi });", 33),
      add("    });", 34),
      add("    return out;", 35),
      ctx("  }, [diff]);", 34, 36),
      ctx("", 35, 37),
      add("  const { ref, start, end, padTop, padBottom } = useVirtual(rows.length, ROW_H, diff);", 38),
    ]},
  ]};
  const DIFF_USEVIRTUAL = { path: "src/useVirtual.ts", binary: false, truncated: false, hunks: [
    { header: "@@ -0,0 +1,9 @@", lines: [
      add("// Fixed-row windowing: mount only the rows visible in the scroll", 1),
      add("// container, padding the rest so scrollbars stay honest.", 2),
      add("export function useVirtual(count: number, rowH: number, resetKey?: unknown) {", 3),
      add("  const ref = useRef<HTMLDivElement>(null);", 4),
      add("  const [scrollTop, setScrollTop] = useState(0);", 5),
      add("  const start = Math.max(0, Math.floor(scrollTop / rowH) - 8);", 6),
      add("  const end = start + Math.ceil(height / rowH) + 16;", 7),
      add("  return { ref, start, end, padTop: start * rowH, padBottom };", 8),
      add("}", 9),
    ]},
  ]};
  const COMMIT_FILES = [DIFF_VIRTUAL, DIFF_USEVIRTUAL];

  // staging-scenario working tree
  const STATUS = { staged: [
      { path: "src/components/StagingPanel.tsx", status: "modified", staged: true },
      { path: "src/components/ChangeList.tsx", status: "modified", staged: true },
    ], unstaged: [
      { path: "src/components/DiffViewer.tsx", status: "modified", staged: false },
      { path: "src/useVirtual.ts", status: "new", staged: false },
      { path: "src/styles.css", status: "modified", staged: false },
      { path: "README.md", status: "modified", staged: false },
    ] };
  const WORK_STATS = { files: 6, insertions: 184, deletions: 37 };

  const handlers = {
    open_repo: () => ({ path: REPO, name: "GitChef", head: "main", has_upstream: true, provider: "github" }),
    commit_graph: () => NODES,
    commit_avatars: () => AVATARS,
    list_branches: () => BRANCHES,
    list_tags: () => TAGS,
    list_worktrees: () => WORKTREES,
    list_stashes: () => STASHES,
    worktree_wips: () => ({ "/Users/dev/Projects/gitchef-hotfix": true }),
    repo_status: () => (S === "staging" ? STATUS : { staged: [], unstaged: [] }),
    work_stats: () => (S === "staging" ? WORK_STATS : { files: 0, insertions: 0, deletions: 0 }),
    commit_diff: () => COMMIT_FILES,
    file_diff: (a) => {
      if (a && a.path === "src/useVirtual.ts") return DIFF_USEVIRTUAL;
      return DIFF_VIRTUAL;
    },
  };

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (cb) => { const id = Math.floor(Math.random() * 1e9); window["_" + id] = cb; return id; },
    convertFileSrc: (p) => p,
    invoke: (cmd, args) => {
      const h = handlers[cmd];
      if (h) return Promise.resolve(h(args || {}));
      // updater/dialog/menu/etc: resolve to null so guarded callers no-op.
      return Promise.resolve(null);
    },
  };

  // --- auto-drive (for headless screenshotting): reproduce the demo gestures ---
  if (new URLSearchParams(location.search).get("drive") !== "1") return;
  const waitFor = (sel, cb, n = 0) => {
    const el = document.querySelector(sel);
    if (el) return cb(el);
    if (n > 80) return;
    setTimeout(() => waitFor(sel, cb, n + 1), 100);
  };
  const setReactValue = (el, value) => {
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  window.addEventListener("DOMContentLoaded", () => {
    if (S === "staging") {
      waitFor(".staging .change-list .file-row", (row) => {
        row.click(); // open the working-file diff in the center
        waitFor(".commit-box textarea", (ta) =>
          setReactValue(ta, "feat(diff): stage individual lines from the diff gutter"));
      });
    } else {
      waitFor(".commit-row", () => {
        const rows = [...document.querySelectorAll(".commit-row")];
        const t = rows.find((r) => r.querySelector(".commit-summary")?.textContent?.includes("virtualize"));
        (t || rows[1]).click(); // select commit -> right panel fills; graph stays in center
      });
    }
  });
})();
</script>
`;

const out = index.replace("</head>", shim + "</head>");
writeFileSync(join(root, "dist/demo.html"), out);
console.log("wrote dist/demo.html");
