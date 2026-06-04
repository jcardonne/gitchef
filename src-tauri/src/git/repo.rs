use crate::error::AppResult;
use git2::{Repository, Status, StatusOptions};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub head: Option<String>,
}

#[derive(Serialize)]
pub struct FileStatus {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Serialize)]
pub struct StatusResult {
    pub staged: Vec<FileStatus>,
    pub unstaged: Vec<FileStatus>,
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
        Ok(h) => h.target().map(|o| o.to_string()[..7].to_string()),
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
            unstaged.push(FileStatus { path, status: "conflicted".into(), staged: false });
            continue;
        }
        if s.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        ) {
            staged.push(FileStatus { path: path.clone(), status: label_index(s), staged: true });
        }
        if s.intersects(
            Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE,
        ) {
            unstaged.push(FileStatus { path, status: label_wt(s), staged: false });
        }
    }
    Ok(StatusResult { staged, unstaged })
}

fn label_index(s: Status) -> String {
    if s.contains(Status::INDEX_NEW) {
        "new"
    } else if s.contains(Status::INDEX_DELETED) {
        "deleted"
    } else if s.contains(Status::INDEX_RENAMED) {
        "renamed"
    } else if s.contains(Status::INDEX_TYPECHANGE) {
        "typechange"
    } else {
        "modified"
    }
    .into()
}

fn label_wt(s: Status) -> String {
    if s.contains(Status::WT_NEW) {
        "new"
    } else if s.contains(Status::WT_DELETED) {
        "deleted"
    } else if s.contains(Status::WT_RENAMED) {
        "renamed"
    } else if s.contains(Status::WT_TYPECHANGE) {
        "typechange"
    } else {
        "modified"
    }
    .into()
}
