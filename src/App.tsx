import { useEffect, useRef, useState } from "react";
import * as api from "./api";
import type { RepoInfo, Tab } from "./types";
import * as store from "./storage";
import TabBar from "./components/TabBar";
import Home from "./components/Home";
import RepoView from "./components/RepoView";
import UpdateToast from "./components/UpdateToast";
import { runSilentUpdate, type UpdateStatus } from "./updater";

/// App shell: owns the open tabs + recents, routes between the Home tab and one
/// mounted RepoView per open repository. All repo state lives inside RepoView.
export default function App() {
  // Restore last session synchronously as initial state, so the persist effect
  // below always sees the real tabs (no first-render empty-state clobber).
  const session = store.getSession();
  const [tabs, setTabs] = useState<Tab[]>(() =>
    session.paths.map((p) => ({ path: p, name: store.basename(p) }))
  );
  const [activePath, setActivePath] = useState<string | null>(session.activePath);
  const [recents, setRecents] = useState(store.getRecents());
  const closedTabs = useRef<string[]>([]); // stack of recently closed tab paths

  // Check Cloudflare for a newer signed build once, on launch (prod only).
  // Progress surfaces in a small toast; on success the app relaunches itself.
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    void runSilentUpdate(setUpdateStatus);
  }, []);

  // Persist the session whenever tabs or focus change.
  useEffect(() => {
    store.saveSession({ paths: tabs.map((t) => t.path), activePath });
  }, [tabs, activePath]);

  const refreshRecents = () => setRecents(store.getRecents());

  const openTab = (path: string) => {
    setTabs((prev) =>
      prev.some((t) => t.path === path) ? prev : [...prev, { path, name: store.basename(path) }]
    );
    setActivePath(path);
  };

  const pickAndOpen = async () => {
    const p = await api.pickRepoFolder();
    if (p) openTab(p);
  };

  const closeTab = (path: string) => {
    const idx = tabs.findIndex((t) => t.path === path);
    closedTabs.current.push(path); // remember for restore (Cmd/Ctrl+Shift+T)
    const next = tabs.filter((t) => t.path !== path);
    setTabs(next);
    if (activePath === path) {
      setActivePath(next.length ? next[Math.min(idx, next.length - 1)].path : null);
    }
  };

  const restoreTab = () => {
    const last = closedTabs.current.pop();
    if (last) openTab(last);
  };

  // Cycle focus across [Home, ...tabs]; dir +1 = next, -1 = previous.
  const cycleTab = (dir: 1 | -1) => {
    const order: (string | null)[] = [null, ...tabs.map((t) => t.path)];
    const cur = order.indexOf(activePath);
    setActivePath(order[(cur + dir + order.length) % order.length]);
  };

  // Tab keyboard shortcuts (Cmd on macOS / Ctrl elsewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
      } else if (mod && e.shiftKey && key === "t") {
        e.preventDefault();
        restoreTab();
      } else if (mod && key === "t") {
        e.preventDefault();
        void pickAndOpen();
      } else if (mod && key === "w") {
        e.preventDefault();
        if (activePath) closeTab(activePath);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activePath]);

  const reorder = (from: number, to: number) =>
    setTabs((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });

  // RepoView reports the real repo name once libgit2 opens it; refine the tab
  // label (was a path basename) and record the repo in recents.
  const onRepoLoaded = (path: string, info: RepoInfo) => {
    setTabs((prev) => prev.map((t) => (t.path === path ? { ...t, name: info.name } : t)));
    store.addRecent({ path, name: info.name });
    refreshRecents();
  };

  const onRemoveRecent = (path: string) => {
    store.removeRecent(path);
    refreshRecents();
  };

  return (
    <div className="app">
      <TabBar
        tabs={tabs}
        activePath={activePath}
        onActivate={setActivePath}
        onClose={closeTab}
        onReorder={reorder}
        onOpen={pickAndOpen}
      />

      <div className="app-body">
        <div className="repo-host" style={{ display: activePath === null ? "flex" : "none" }}>
          <Home
            recents={recents}
            onOpen={pickAndOpen}
            onOpenRecent={openTab}
            onRemoveRecent={onRemoveRecent}
          />
        </div>

        {tabs.map((t) => (
          <div
            key={t.path}
            className="repo-host"
            style={{ display: t.path === activePath ? "flex" : "none" }}
          >
            <RepoView path={t.path} isActive={t.path === activePath} onLoaded={onRepoLoaded} />
          </div>
        ))}
      </div>

      <UpdateToast status={updateStatus} />
    </div>
  );
}
