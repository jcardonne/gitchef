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
