use super::{run_git, workdir};
use crate::error::AppResult;
use git2::{BranchType, Repository, StatusOptions};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

#[derive(Serialize)]
pub struct WorktreeInfo {
    /// Last path segment - a short, human label for the worktree.
    pub name: String,
    pub path: String,
    /// Branch shorthand checked out in the worktree, or None when detached.
    pub branch: Option<String>,
    /// The main (primary) worktree - always the first entry git reports.
    pub is_main: bool,
    /// The worktree this tab is opened on (so the UI can flag the active one).
    pub is_current: bool,
    pub locked: bool,
}

/// List every worktree (main + linked) via `git worktree list --porcelain`,
/// the canonical machine-readable source: it covers main, linked, detached,
/// bare and locked worktrees uniformly, which reconstructing through libgit2's
/// commondir gymnastics does not.
pub fn list_worktrees(repo: &Repository) -> AppResult<Vec<WorktreeInfo>> {
    let dir = workdir(repo)?;
    let raw = run_git(dir, &["worktree", "list", "--porcelain"])?;
    let current = repo.workdir().and_then(|p| p.canonicalize().ok());
    Ok(parse_worktrees(&raw, current.as_deref()))
}

/// Parse `git worktree list --porcelain`. Records are separated by a blank
/// line; the first record is always the main worktree.
fn parse_worktrees(raw: &str, current: Option<&Path>) -> Vec<WorktreeInfo> {
    let mut out = Vec::new();
    for (i, block) in raw.split("\n\n").filter(|b| !b.trim().is_empty()).enumerate() {
        let mut path = String::new();
        let mut branch = None;
        let mut locked = false;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = p.to_string();
            } else if let Some(b) = line.strip_prefix("branch ") {
                branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
            } else if line == "locked" || line.starts_with("locked ") {
                locked = true;
            }
            // `HEAD <oid>`, `detached` and `bare` lines need no field here.
        }
        if path.is_empty() {
            continue;
        }
        let is_current = current
            .and_then(|c| Path::new(&path).canonicalize().ok().map(|p| p == *c))
            .unwrap_or(false);
        let name = Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&path)
            .to_string();
        out.push(WorktreeInfo { name, path, branch, is_main: i == 0, is_current, locked });
    }
    out
}

/// Add a worktree at `path` checking out `branch`. Reuses an existing local
/// branch, or creates one (`-b`) when it doesn't exist yet.
pub fn add_worktree(repo: &Repository, path: &str, branch: &str) -> AppResult<String> {
    let dir = workdir(repo)?;
    if repo.find_branch(branch, BranchType::Local).is_ok() {
        run_git(dir, &["worktree", "add", path, branch])
    } else {
        run_git(dir, &["worktree", "add", "-b", branch, path])
    }
}

/// Map each worktree path to whether it has uncommitted changes (tracked or
/// untracked) - the per-worktree "WIP" indicator. Opening + scanning every
/// worktree is the expensive part, so this runs on demand (initial load + the
/// manual "refresh WIPs" button) rather than on every UI refresh.
pub fn worktree_wips(repo: &Repository) -> AppResult<HashMap<String, bool>> {
    let mut out = HashMap::new();
    for wt in list_worktrees(repo)? {
        let dirty = is_dirty(&wt.path).unwrap_or(false);
        out.insert(wt.path, dirty);
    }
    Ok(out)
}

/// Whether a working tree has any staged/unstaged/untracked change.
fn is_dirty(path: &str) -> AppResult<bool> {
    let r = Repository::open(path)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).include_ignored(false);
    let statuses = r.statuses(Some(&mut opts))?;
    Ok(!statuses.is_empty())
}

#[cfg(test)]
mod tests {
    use super::{add_worktree, list_worktrees, parse_worktrees, worktree_wips};
    use crate::git::run_git;
    use git2::Repository;
    use std::path::Path;

    fn init(dir: &Path) {
        Repository::init(dir).unwrap();
        run_git(dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("f.txt"), "base\n").unwrap();
        run_git(dir, &["add", "f.txt"]).unwrap();
        run_git(dir, &["commit", "-m", "init"]).unwrap();
    }

    #[test]
    fn parses_main_linked_detached_and_locked() {
        let raw = "\
worktree /repo/main
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo/feature
HEAD 2222222222222222222222222222222222222222
branch refs/heads/feature
locked

worktree /repo/detached
HEAD 3333333333333333333333333333333333333333
detached
";
        let wts = parse_worktrees(raw, None);
        assert_eq!(wts.len(), 3);

        assert_eq!(wts[0].path, "/repo/main");
        assert_eq!(wts[0].branch.as_deref(), Some("main"));
        assert!(wts[0].is_main);
        assert!(!wts[0].locked);

        assert_eq!(wts[1].name, "feature");
        assert_eq!(wts[1].branch.as_deref(), Some("feature"));
        assert!(!wts[1].is_main);
        assert!(wts[1].locked, "the `locked` line marks it locked");

        assert_eq!(wts[2].branch, None, "detached worktree has no branch");
        assert!(!wts[2].is_current, "current is false when no path is provided");
    }

    #[test]
    fn add_list_and_scan_worktrees() {
        let base = std::env::temp_dir().join(format!("gitchef-wt-{}", std::process::id()));
        let main = base.join("main");
        std::fs::create_dir_all(&main).unwrap();
        init(&main);
        let repo = Repository::open(&main).unwrap();

        // Adding a worktree on a fresh branch creates the linked checkout.
        let linked = base.join("feature");
        add_worktree(&repo, linked.to_str().unwrap(), "feature").unwrap();

        let wts = list_worktrees(&repo).unwrap();
        assert_eq!(wts.len(), 2, "main + linked worktree: {wts:?}", wts = wts.iter().map(|w| &w.path).collect::<Vec<_>>());
        assert!(wts[0].is_main, "first entry is the main worktree");
        assert!(wts[0].is_current, "the opened repo is flagged current");
        let feature = wts.iter().find(|w| w.branch.as_deref() == Some("feature")).expect("feature worktree listed");
        assert!(!feature.is_main);

        // A clean worktree is not dirty; an untracked file makes it a WIP.
        let wips = worktree_wips(&repo).unwrap();
        assert_eq!(wips.get(&feature.path), Some(&false), "clean worktree: {wips:?}");
        std::fs::write(linked.join("new.txt"), "wip\n").unwrap();
        let wips = worktree_wips(&repo).unwrap();
        assert_eq!(wips.get(&feature.path), Some(&true), "untracked file marks WIP: {wips:?}");

        run_git(&main, &["worktree", "remove", "--force", linked.to_str().unwrap()]).ok();
        std::fs::remove_dir_all(&base).ok();
    }
}
