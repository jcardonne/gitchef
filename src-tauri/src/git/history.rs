use crate::error::{AppError, AppResult};
use git2::{BlameOptions, Oid, Repository, Sort};
use serde::Serialize;
use std::path::Path;

/// One commit in a file's history (the commit changed the file).
#[derive(Serialize)]
pub struct FileHistoryEntry {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub author: String,
    pub email: String,
    pub time: i64,
}

/// Blob oid of `path` in `tree`, or None if the path isn't present there.
fn blob_at(tree: &git2::Tree, path: &Path) -> Option<Oid> {
    tree.get_path(path).ok().map(|e| e.id())
}

/// Commits reachable from HEAD (newest first, capped at `limit`) where `path`'s
/// blob differs from its first parent's - i.e. the commit added, modified, or
/// removed the file. No rename following (matches `git log` without --follow).
pub fn file_history(repo: &Repository, path: &str, limit: usize) -> AppResult<Vec<FileHistoryEntry>> {
    let p = Path::new(path);
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    // Ignore the error on an unborn HEAD (fresh repo): the walk just yields
    // nothing and we return an empty history, matching commit_graph.
    let _ = walk.push_head();
    let mut out = Vec::new();
    for oid in walk {
        if out.len() >= limit {
            break;
        }
        let Ok(oid) = oid else { break };
        let Ok(commit) = repo.find_commit(oid) else { continue };
        let Ok(tree) = commit.tree() else { continue };
        let cur = blob_at(&tree, p);
        // Compare against the first parent's tree (root commit -> None = added).
        let prev = commit.parent(0).ok().and_then(|pc| pc.tree().ok()).and_then(|t| blob_at(&t, p));
        if cur == prev {
            continue;
        }
        let author = commit.author();
        out.push(FileHistoryEntry {
            id: oid.to_string(),
            short_id: super::short_oid(oid),
            summary: commit.summary().unwrap_or_default().to_string(),
            author: author.name().unwrap_or_default().to_string(),
            email: author.email().unwrap_or_default().to_string(),
            time: commit.time().seconds(),
        });
    }
    Ok(out)
}

/// One blame hunk: a run of consecutive final lines sharing a last-changing
/// commit. `start_line` is 1-based; `lines` is the run length.
#[derive(Serialize)]
pub struct BlameHunkInfo {
    pub commit_id: String,
    pub short_id: String,
    pub author: String,
    pub time: i64,
    pub start_line: usize,
    pub lines: usize,
}

/// Per-line authorship of `path` as of `rev` (HEAD when None). Hunks are copied
/// into owned structs so nothing borrowed from the Blame escapes (keeps the
/// async command future Send).
pub fn file_blame(repo: &Repository, path: &str, rev: Option<&str>) -> AppResult<Vec<BlameHunkInfo>> {
    let mut opts = BlameOptions::new();
    if let Some(r) = rev {
        let oid = Oid::from_str(r).map_err(|e| AppError::Msg(format!("invalid commit id: {e}")))?;
        opts.newest_commit(oid);
    }
    let blame = repo.blame_file(Path::new(path), Some(&mut opts))?;
    let mut out = Vec::with_capacity(blame.len());
    for i in 0..blame.len() {
        let Some(h) = blame.get_index(i) else { continue };
        let sig = h.final_signature();
        let oid = h.final_commit_id();
        out.push(BlameHunkInfo {
            commit_id: oid.to_string(),
            short_id: super::short_oid(oid),
            author: sig.name().unwrap_or_default().to_string(),
            time: sig.when().seconds(),
            start_line: h.final_start_line(),
            lines: h.lines_in_hunk(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use crate::git::run_git;
    use git2::Repository;
    use std::path::{Path, PathBuf};

    fn tmp(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut p = std::env::temp_dir();
        p.push(format!("gitchef-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn fresh(dir: &Path) -> Repository {
        Repository::open(dir).unwrap()
    }

    fn commit_all(dir: &Path, msg: &str) {
        run_git(dir, &["add", "-A"]).unwrap();
        run_git(dir, &["commit", "-m", msg]).unwrap();
    }

    #[test]
    fn file_history_lists_only_commits_that_touched_the_path() {
        let dir = tmp("filehistory");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("f.txt"), "v1\n").unwrap();
        commit_all(&dir, "add f");
        std::fs::write(dir.join("other.txt"), "x\n").unwrap();
        commit_all(&dir, "add other"); // must NOT appear in f.txt history
        std::fs::write(dir.join("f.txt"), "v2\n").unwrap();
        commit_all(&dir, "change f");

        let hist = super::file_history(&fresh(&dir), "f.txt", 50).unwrap();
        assert_eq!(hist.len(), 2); // "change f" + "add f", not "add other"
        assert_eq!(hist[0].summary, "change f"); // newest first
        assert_eq!(hist[1].summary, "add f");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_history_on_unborn_head_is_empty_not_error() {
        let dir = tmp("filehistory-unborn");
        Repository::init(&dir).unwrap(); // no commits yet
        let hist = super::file_history(&fresh(&dir), "f.txt", 50).unwrap();
        assert!(hist.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn blame_attributes_lines_to_their_commit() {
        let dir = tmp("blame");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("f.txt"), "a\nb\n").unwrap();
        commit_all(&dir, "two lines");

        let blame = super::file_blame(&fresh(&dir), "f.txt", None).unwrap();
        assert_eq!(blame.len(), 1); // both lines from one commit -> one hunk
        assert_eq!(blame[0].start_line, 1);
        assert_eq!(blame[0].lines, 2);

        std::fs::remove_dir_all(&dir).ok();
    }
}
