use crate::error::{AppError, AppResult};
use git2::{DiffFormat, DiffOptions, Oid, Repository};
use serde::Serialize;

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
}

/// Turn a libgit2 patch into structured per-file hunks the UI can render.
fn diff_to_files(diff: &git2::Diff) -> AppResult<Vec<FileDiff>> {
    let mut files: Vec<FileDiff> = Vec::new();
    diff.print(DiffFormat::Patch, |delta, _hunk, line| {
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
                if file.hunks.is_empty() {
                    file.hunks.push(DiffHunk { header: String::new(), lines: Vec::new() });
                }
                let hunk = file.hunks.last_mut().unwrap();
                hunk.lines.push(DiffLine {
                    origin: origin.to_string(),
                    content: String::from_utf8_lossy(line.content())
                        .trim_end_matches('\n')
                        .to_string(),
                    old_lineno: line.old_lineno(),
                    new_lineno: line.new_lineno(),
                });
            }
        }
        true
    })?;
    Ok(files)
}

/// Diff a single path - staged (HEAD vs index) or unstaged (index vs working dir).
pub fn file_diff(repo: &Repository, path: &str, staged: bool) -> AppResult<FileDiff> {
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

    Ok(diff_to_files(&diff)?
        .into_iter()
        .find(|f| f.path == path)
        .unwrap_or(FileDiff { path: path.to_string(), binary: false, hunks: Vec::new() }))
}

/// All file changes introduced by a single commit (vs its first parent).
pub fn commit_diff(repo: &Repository, id: &str) -> AppResult<Vec<FileDiff>> {
    let oid = Oid::from_str(id).map_err(|e| AppError::Msg(format!("invalid commit id: {e}")))?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = DiffOptions::new();
    let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
    diff_to_files(&diff)
}
