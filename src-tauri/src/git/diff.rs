use crate::error::{AppError, AppResult};
use git2::{DiffFormat, DiffOptions, Oid, Repository};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct DiffLine {
    pub origin: String,
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Serialize)]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize)]
pub struct FileDiff {
    pub path: String,
    pub binary: bool,
    pub hunks: Vec<DiffHunk>,
    /// True when the diff was capped; the UI offers a "Load full file" action.
    pub truncated: bool,
}

impl FileDiff {
    /// A content-less diff (no hunks) - used for "no changes" and binary files.
    fn empty(path: &str, binary: bool) -> Self {
        Self { path: path.to_string(), binary, hunks: Vec::new(), truncated: false }
    }
}

/// Hard caps so a huge file can never flood the webview with DOM nodes (which
/// freezes the app). Beyond these the diff is truncated with a marker.
const MAX_DIFF_LINES: usize = 3000;
const MAX_LINE_LEN: usize = 2000;

/// Cap a single line's length so a minified one-liner can't be megabytes wide.
fn cap_line(s: &str) -> String {
    if s.chars().count() > MAX_LINE_LEN {
        let cut: String = s.chars().take(MAX_LINE_LEN).collect();
        format!("{cut} … (line truncated)")
    } else {
        s.to_string()
    }
}

/// Turn a libgit2 patch into structured per-file hunks the UI can render,
/// stopping once `max` content lines have been collected.
fn diff_to_files(diff: &git2::Diff, max: usize) -> AppResult<Vec<FileDiff>> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut total_lines = 0usize;
    let mut truncated = false;
    let printed = diff.print(DiffFormat::Patch, |delta, _hunk, line| {
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();

        if files.last().map(|f| f.path != path).unwrap_or(true) {
            files.push(FileDiff {
                path: path.clone(),
                binary: delta.flags().is_binary(),
                hunks: Vec::new(),
                truncated: false,
            });
        }
        let file = files.last_mut().unwrap();

        match line.origin() {
            'F' => {} // file header - skip, we already have the path
            'H' => file.hunks.push(DiffHunk {
                header: String::from_utf8_lossy(line.content()).trim_end().to_string(),
                lines: Vec::new(),
            }),
            origin => {
                if total_lines >= max {
                    file.truncated = true; // mark the file that actually got cut
                    truncated = true;
                    return false; // abort the print: budget reached
                }
                total_lines += 1;
                if file.hunks.is_empty() {
                    file.hunks.push(DiffHunk { header: String::new(), lines: Vec::new() });
                }
                let hunk = file.hunks.last_mut().unwrap();
                hunk.lines.push(DiffLine {
                    origin: origin.to_string(),
                    content: cap_line(
                        String::from_utf8_lossy(line.content()).trim_end_matches('\n'),
                    ),
                    old_lineno: line.old_lineno(),
                    new_lineno: line.new_lineno(),
                });
            }
        }
        true
    });
    // Aborting the callback (truncation) surfaces as an error; only propagate
    // errors that are NOT our intentional early stop.
    if !truncated {
        printed?;
    }
    Ok(files)
}

/// Diff a single path - staged (HEAD vs index) or unstaged (index vs working dir).
/// `full` lifts the line cap so the UI can load a big file on demand.
pub fn file_diff(repo: &Repository, path: &str, staged: bool, full: bool) -> AppResult<FileDiff> {
    let max = if full { usize::MAX } else { MAX_DIFF_LINES };
    let mut opts = DiffOptions::new();
    opts.pathspec(path)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);

    let diff = if staged {
        let index = repo.index()?;
        let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head_tree.as_ref(), Some(&index), Some(&mut opts))?
    } else {
        repo.diff_index_to_workdir(None, Some(&mut opts))?
    };

    let structured = diff_to_files(&diff, max)?.into_iter().find(|f| f.path == path);
    if let Some(fd) = &structured {
        if !fd.hunks.is_empty() || fd.binary {
            return Ok(structured.unwrap());
        }
    }

    // Empty patch. For a newly added file (absent from HEAD) libgit2 can yield no
    // hunks; show the whole file as additions so new files always render.
    if is_new_in_head(repo, path) {
        return whole_file_as_added(repo, path, max);
    }
    Ok(structured.unwrap_or_else(|| FileDiff::empty(path, false)))
}

/// True if `path` does not exist in the HEAD tree (i.e. it's a new file).
fn is_new_in_head(repo: &Repository, path: &str) -> bool {
    match repo.head().ok().and_then(|h| h.peel_to_tree().ok()) {
        Some(tree) => tree.get_path(Path::new(path)).is_err(),
        None => true, // unborn HEAD: nothing committed yet, so everything is new
    }
}

/// Render a whole file as an all-additions diff. Binary files and empty files
/// get a clear marker instead of a misleading "No changes".
fn whole_file_as_added(repo: &Repository, path: &str, max: usize) -> AppResult<FileDiff> {
    let bytes = std::fs::read(super::workdir(repo)?.join(path)).unwrap_or_default();
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Ok(FileDiff::empty(path, true));
    }
    let text = String::from_utf8_lossy(&bytes);
    let total = text.lines().count();
    let lines: Vec<DiffLine> = text
        .lines()
        .take(max)
        .enumerate()
        .map(|(i, l)| DiffLine {
            origin: "+".into(),
            content: cap_line(l),
            old_lineno: None,
            new_lineno: Some((i + 1) as u32),
        })
        .collect();
    let shown = lines.len();
    let header = if total == 0 {
        "(new empty file)".to_string()
    } else {
        format!("@@ -0,0 +1,{shown} @@")
    };
    Ok(FileDiff {
        path: path.to_string(),
        binary: false,
        hunks: vec![DiffHunk { header, lines }],
        truncated: total > shown,
    })
}

/// Diff between a commit and the current working tree (incl. staged changes).
pub fn compare_workdir(repo: &Repository, sha: &str) -> AppResult<Vec<FileDiff>> {
    let oid = Oid::from_str(sha).map_err(|e| AppError::Msg(format!("invalid commit id: {e}")))?;
    let tree = repo.find_commit(oid)?.tree()?;
    let mut opts = DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let diff = repo.diff_tree_to_workdir_with_index(Some(&tree), Some(&mut opts))?;
    diff_to_files(&diff, MAX_DIFF_LINES)
}

/// All file changes introduced by a single commit (vs its first parent).
pub fn commit_diff(repo: &Repository, id: &str) -> AppResult<Vec<FileDiff>> {
    let oid = Oid::from_str(id).map_err(|e| AppError::Msg(format!("invalid commit id: {e}")))?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = DiffOptions::new();
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
    diff_to_files(&diff, MAX_DIFF_LINES)
}
