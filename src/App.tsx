import { useCallback, useEffect, useState } from "react";
import * as api from "./api";
import type {
  BranchInfo,
  CommitNode,
  FileDiff,
  RepoInfo,
  StatusResult,
} from "./types";
import Toolbar from "./components/Toolbar";
import Sidebar from "./components/Sidebar";
import GraphView from "./components/GraphView";
import StagingPanel from "./components/StagingPanel";
import DiffViewer from "./components/DiffViewer";

const EMPTY_STATUS: StatusResult = { staged: [], unstaged: [] };

export default function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [nodes, setNodes] = useState<CommitNode[]>([]);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [status, setStatus] = useState<StatusResult>(EMPTY_STATUS);

  const [rightTab, setRightTab] = useState<"changes" | "commit">("changes");
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<FileDiff[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);

  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [newBranchName, setNewBranchName] = useState<string | null>(null);

  const notify = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 4000);
  };

  /// Wrap any backend action: flips `busy`, surfaces errors as a toast.
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    const [s, g, b] = await Promise.all([
      api.repoStatus(),
      api.commitGraph(),
      api.listBranches(),
    ]);
    setStatus(s);
    setNodes(g);
    setBranches(b);
  }, []);

  const openRepo = () =>
    run(async () => {
      const path = await api.pickRepoFolder();
      if (!path) return;
      const info = await api.openRepo(path);
      setRepo(info);
      setSelectedCommit(null);
      setSelectedPath(null);
      setDiff(null);
      setCommitFiles([]);
      setRightTab("changes");
      await refresh();
    });

  // --- commit graph selection ---
  const selectCommit = (id: string) =>
    run(async () => {
      setSelectedCommit(id);
      setRightTab("commit");
      setSelectedPath(null);
      setDiff(null);
      setCommitFiles(await api.commitDiff(id));
    });

  // --- working-change selection ---
  const selectWorkingFile = (path: string, staged: boolean) =>
    run(async () => {
      setSelectedPath(path);
      setDiff(await api.fileDiff(path, staged));
    });

  const selectCommitFile = (file: FileDiff) => {
    setSelectedPath(file.path);
    setDiff(file);
  };

  // --- staging actions (refresh status + graph afterwards) ---
  const afterMutation = async () => {
    await refresh();
  };

  const onStage = (p: string) => run(async () => (await api.stage(p), afterMutation()));
  const onUnstage = (p: string) => run(async () => (await api.unstage(p), afterMutation()));
  const onStageAll = () => run(async () => (await api.stageAll(), afterMutation()));
  const onUnstageAll = () => run(async () => (await api.unstageAll(), afterMutation()));
  const onCommit = (message: string) =>
    run(async () => {
      const sha = await api.commit(message);
      notify(`Committed ${sha.slice(0, 7)}`);
      setRightTab("changes");
      await refresh();
    });

  const onCheckout = (name: string) =>
    run(async () => {
      await api.checkout(name);
      const info = await api.openRepo(repo!.path); // refresh HEAD label
      setRepo(info);
      await refresh();
    });

  const onCreateBranch = (name: string) =>
    run(async () => {
      await api.createBranch(name, true);
      const info = await api.openRepo(repo!.path);
      setRepo(info);
      await refresh();
      notify(`Created and switched to ${name}`);
    });

  const onFetch = () =>
    run(async () => {
      await api.fetch();
      notify("Fetched from remotes");
      await refresh();
    });
  const onPull = () =>
    run(async () => {
      const out = await api.pull();
      notify(out.trim() || "Pulled");
      const info = await api.openRepo(repo!.path);
      setRepo(info);
      await refresh();
    });
  const onPush = () =>
    run(async () => {
      await api.push();
      notify("Pushed");
      await refresh();
    });

  // keyboard: nothing fancy yet, just clear toast on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && setToast(null);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  if (!repo) {
    return (
      <div className="app">
        <Toolbar
          repo={null}
          busy={busy}
          onOpen={openRepo}
          onFetch={onFetch}
          onPull={onPull}
          onPush={onPush}
          onNewBranch={() => {}}
        />
        <div className="welcome">
          <h1>GitChef</h1>
          <p>Open-source visual Git client.</p>
          <button className="primary-btn" onClick={openRepo}>
            Open a repository
          </button>
        </div>
        {toast && <div className="toast">{toast}</div>}
      </div>
    );
  }

  return (
    <div className="app">
      <Toolbar
        repo={repo}
        busy={busy}
        onOpen={openRepo}
        onFetch={onFetch}
        onPull={onPull}
        onPush={onPush}
        onNewBranch={() => setNewBranchName("")}
      />

      <div className="main">
        <Sidebar branches={branches} onCheckout={onCheckout} />

        <div className="center">
          <GraphView nodes={nodes} selectedId={selectedCommit} onSelect={selectCommit} />
        </div>

        <div className="right">
          <div className="right-tabs">
            <button
              className={rightTab === "changes" ? "active" : ""}
              onClick={() => setRightTab("changes")}
            >
              Changes ({status.staged.length + status.unstaged.length})
            </button>
            <button
              className={rightTab === "commit" ? "active" : ""}
              disabled={!selectedCommit}
              onClick={() => setRightTab("commit")}
            >
              Commit
            </button>
          </div>

          <div className="right-top">
            {rightTab === "changes" ? (
              <StagingPanel
                status={status}
                selectedPath={selectedPath}
                onSelectFile={selectWorkingFile}
                onStage={onStage}
                onUnstage={onUnstage}
                onStageAll={onStageAll}
                onUnstageAll={onUnstageAll}
                onCommit={onCommit}
                busy={busy}
              />
            ) : (
              <div className="commit-files">
                {commitFiles.length === 0 && (
                  <div className="empty-hint">No file changes.</div>
                )}
                {commitFiles.map((f) => (
                  <div
                    key={f.path}
                    className={`file-row${selectedPath === f.path ? " selected" : ""}`}
                    onClick={() => selectCommitFile(f)}
                  >
                    <span className="file-path">{f.path}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="right-bottom">
            <DiffViewer diff={diff} />
          </div>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {newBranchName !== null && (
        <div className="modal-overlay" onClick={() => setNewBranchName(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>New branch</h3>
            <input
              autoFocus
              placeholder="branch-name"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newBranchName.trim()) {
                  const name = newBranchName.trim();
                  setNewBranchName(null);
                  onCreateBranch(name);
                }
              }}
            />
            <div className="modal-actions">
              <button onClick={() => setNewBranchName(null)}>Cancel</button>
              <button
                className="primary-btn"
                disabled={!newBranchName.trim()}
                onClick={() => {
                  const name = newBranchName.trim();
                  setNewBranchName(null);
                  onCreateBranch(name);
                }}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
