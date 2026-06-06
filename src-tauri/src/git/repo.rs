use crate::error::AppResult;
use git2::{DiffOptions, Repository, Status, StatusOptions};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub head: Option<String>,
}

/// Serializes to the lowercase variant name, matching the TS `FileStatusKind`
/// union exactly - so adding a variant here forces a matching TS update.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum FileStatusKind {
    New,
    Modified,
    Deleted,
    Renamed,
    Typechange,
    Conflicted,
}

#[derive(Serialize)]
pub struct FileStatus {
    pub path: String,
    pub status: FileStatusKind,
    pub staged: bool,
}

#[derive(Serialize)]
pub struct StatusResult {
    pub staged: Vec<FileStatus>,
    pub unstaged: Vec<FileStatus>,
}

#[derive(Serialize)]
pub struct WorkStats {
    pub files: usize,
    pub insertions: usize,
    pub deletions: usize,
}

/// Line/file stats for everything uncommitted (working tree + index vs HEAD).
/// Drives the "uncommitted changes" node at the top of the graph.
pub fn work_stats(repo: &Repository) -> AppResult<WorkStats> {
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    let diff = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))?;
    let s = diff.stats()?;
    Ok(WorkStats {
        files: s.files_changed(),
        insertions: s.insertions(),
        deletions: s.deletions(),
    })
}

pub fn info(repo: &Repository) -> AppResult<RepoInfo> {
    let path = repo
        .workdir()
        .unwrap_or_else(|| repo.path())
        .to_string_lossy()
        .into_owned();
    let name = Path::new(path.trim_end_matches('/'))
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repository".into());
    let head = match repo.head() {
        Ok(h) if h.is_branch() => h.shorthand().map(|s| s.to_string()),
        Ok(h) => h.target().map(super::short_oid),
        Err(_) => None, // unborn branch (fresh repo, no commits yet)
    };
    Ok(RepoInfo { path, name, head })
}

/// Working-tree status split into what's staged (index vs HEAD) and what's not
/// (working dir vs index). A file can appear in both lists if it has staged and
/// unstaged changes - exactly how GitKraken shows it.
pub fn status(repo: &Repository) -> AppResult<StatusResult> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    for entry in statuses.iter() {
        let s = entry.status();
        let path = entry.path().unwrap_or_default().to_string();

        if s.is_conflicted() {
            unstaged.push(FileStatus { path, status: FileStatusKind::Conflicted, staged: false });
            continue;
        }
        if s.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        ) {
            staged.push(FileStatus { path: path.clone(), status: label_status(s, true), staged: true });
        }
        if s.intersects(
            Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE,
        ) {
            unstaged.push(FileStatus { path, status: label_status(s, false), staged: false });
        }
    }
    Ok(StatusResult { staged, unstaged })
}

/// Map a status bitset to a kind, reading either the index (staged) side or the
/// working-tree side depending on `staged`.
fn label_status(s: Status, staged: bool) -> FileStatusKind {
    let (new, deleted, renamed, typechange) = if staged {
        (Status::INDEX_NEW, Status::INDEX_DELETED, Status::INDEX_RENAMED, Status::INDEX_TYPECHANGE)
    } else {
        (Status::WT_NEW, Status::WT_DELETED, Status::WT_RENAMED, Status::WT_TYPECHANGE)
    };
    if s.contains(new) {
        FileStatusKind::New
    } else if s.contains(deleted) {
        FileStatusKind::Deleted
    } else if s.contains(renamed) {
        FileStatusKind::Renamed
    } else if s.contains(typechange) {
        FileStatusKind::Typechange
    } else {
        FileStatusKind::Modified
    }
}
