import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/// Build a throwaway git repo with a tall commit history and a large set of
/// untracked files, so the webview is forced to virtualize both the commit
/// graph and the change list. Returns the repo path plus the counts the spec
/// asserts on. Runs in the wdio worker (Node), not the webview.
export function createFixtureRepo({ commits = 300, files = 600 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gitchef-e2e-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "e2e@gitchef.test"]);
  git(["config", "user.name", "GitChef E2E"]);
  git(["config", "commit.gpgsign", "false"]);
  // The 300-commit build below trips git's `gc --auto`, which writes a
  // commit-graph file; libgit2's revwalk then reads it mid-write and fails with
  // "object not found", blanking the graph. Keep these throwaway repos plain:
  // no background gc, and have libgit2 walk real objects, not a commit-graph.
  git(["config", "gc.auto", "0"]);
  git(["config", "maintenance.auto", "false"]);
  git(["config", "core.commitGraph", "false"]);

  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "root-commit"]);

  // A history taller than the viewport (one process, not N spawns).
  execSync(
    `for i in $(seq 1 ${commits}); do git commit -q --allow-empty -m "commit $i"; done`,
    { cwd: dir, shell: "/bin/bash", stdio: "pipe" }
  );

  // Many untracked files -> a change list taller than the viewport. Written
  // last so they stay untracked; flat zero-padded names so list view is one
  // flat window and path order is lexicographic.
  for (let i = 0; i < files; i++) {
    writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.txt`), `file ${i}\n`);
  }

  return { dir, commits, files };
}

/// Build a repo left PAUSED mid-rebase with one conflicted file, so the app
/// opens straight into the sequencer banner + conflict resolver (the native
/// branch-menu trigger isn't reachable from the webview, so we set up the
/// conflict with real git here and let the UI drive the resolution + continue).
export function createConflictRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gitchef-e2e-conflict-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "e2e@gitchef.test"]);
  git(["config", "user.name", "GitChef E2E"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "gc.auto", "0"]);

  writeFileSync(join(dir, "file.txt"), "line1\nbase\nline3\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "base"]);

  // feature edits the middle line one way...
  git(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(dir, "file.txt"), "line1\nfeature change\nline3\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "feature edit"]);

  // ...main edits the same line another way -> replaying feature conflicts.
  git(["checkout", "-q", "main"]);
  writeFileSync(join(dir, "file.txt"), "line1\nmain change\nline3\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "main edit"]);

  git(["checkout", "-q", "feature"]);
  try {
    git(["-c", "core.editor=true", "rebase", "main"]);
  } catch {
    // expected: the rebase stops on the conflict, leaving .git/rebase-merge
  }
  return { dir };
}
