use crate::error::{AppError, AppResult};
use git2::{Delta, DiffFindOptions, DiffFormat, DiffOptions, Oid, Repository};
use serde::Serialize;
use std::path::Path;
use super::repo::FileStatusKind;

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
    pub status: FileStatusKind,
    /// Rename source (pre-rename path) when `status` is `renamed`; `None`
    /// otherwise. Lets the commit/compare file list show "old -> new".
    pub old_path: Option<String>,
    pub hunks: Vec<DiffHunk>,
    /// True when the diff was capped; the UI offers a "Load full file" action.
    pub truncated: bool,
}

impl FileDiff {
    /// A content-less diff (no hunks) - used for "no changes" and binary files.
    fn empty(path: &str, binary: bool, status: FileStatusKind) -> Self {
        Self { path: path.to_string(), binary, status, old_path: None, hunks: Vec::new(), truncated: false }
    }
}

/// Map a libgit2 delta to the UI's file-status kind. Copies surface as new
/// files; unmodified/ignored/unreadable never appear in the diffs we build.
fn delta_kind(delta: Delta) -> FileStatusKind {
    match delta {
        Delta::Added | Delta::Untracked | Delta::Copied => FileStatusKind::New,
        Delta::Deleted => FileStatusKind::Deleted,
        Delta::Renamed => FileStatusKind::Renamed,
        Delta::Typechange => FileStatusKind::Typechange,
        Delta::Conflicted => FileStatusKind::Conflicted,
        _ => FileStatusKind::Modified,
    }
}

#[derive(Serialize)]
pub struct FileContent {
    pub path: String,
    pub binary: bool,
    pub lines: Vec<String>,
    /// True when the content was capped; the UI offers a "Load full file" action.
    pub truncated: bool,
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
            let st = delta.status();
            let old_path = if matches!(st, Delta::Renamed) {
                delta.old_file().path().map(|p| p.to_string_lossy().into_owned())
            } else {
                None
            };
            files.push(FileDiff {
                path: path.clone(),
                binary: delta.flags().is_binary(),
                status: delta_kind(st),
                old_path,
                hunks: Vec::new(),
                truncated: false,
            });
        }
        let file = files.last_mut().unwrap();

        match line.origin() {
            'F' => {} // file header - skip, we already have the path
            // libgit2's "\ No newline at end of file" markers (ADD_EOFNL '>',
            // DEL_EOFNL '<', CONTEXT_EOFNL '='). They carry no content and no
            // line numbers - git prints them as a note under the hunk, not as a
            // diff line. Forwarding them made the split view render a stray '>'
            // gutter row and broke the -/+ run pairing either side of them.
            '>' | '<' | '=' => {}
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
    Ok(structured.unwrap_or_else(|| FileDiff::empty(path, false, FileStatusKind::Modified)))
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
        return Ok(FileDiff::empty(path, true, FileStatusKind::New));
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
        status: FileStatusKind::New,
        old_path: None,
        hunks: vec![DiffHunk { header, lines }],
        truncated: total > shown,
    })
}

/// Raw content of a file for the "File" preview (the counterpart to the diff).
/// The source mirrors the diff's "after" side so the two views agree:
///   - `rev = Some(sha)` -> the blob at that commit's tree,
///   - `rev = None, staged = true` -> the staged blob in the index,
///   - `rev = None, staged = false` -> the working-tree file on disk.
///
/// Capped like diffs unless `full`, so a huge file can't flood the webview.
pub fn file_content(
    repo: &Repository,
    path: &str,
    rev: Option<&str>,
    staged: bool,
    full: bool,
) -> AppResult<FileContent> {
    let bytes = read_file_bytes(repo, path, rev, staged)?;
    if bytes.iter().take(8000).any(|&b| b == 0) {
        return Ok(FileContent {
            path: path.to_string(),
            binary: true,
            lines: Vec::new(),
            truncated: false,
        });
    }
    let text = String::from_utf8_lossy(&bytes);
    let max = if full { usize::MAX } else { MAX_DIFF_LINES };
    let total = text.lines().count();
    let lines: Vec<String> = text.lines().take(max).map(cap_line).collect();
    let truncated = total > lines.len();
    Ok(FileContent { path: path.to_string(), binary: false, lines, truncated })
}

/// Fetch a file's bytes from the requested source (commit blob, index blob, or
/// the working tree). Index/commit lookups that miss fall back to the working
/// tree, which also yields empty bytes for a deleted file (rendered as empty).
fn read_file_bytes(
    repo: &Repository,
    path: &str,
    rev: Option<&str>,
    staged: bool,
) -> AppResult<Vec<u8>> {
    if let Some(rev) = rev {
        let oid = Oid::from_str(rev).map_err(|e| AppError::Msg(format!("invalid commit id: {e}")))?;
        let tree = repo.find_commit(oid)?.tree()?;
        if let Ok(entry) = tree.get_path(Path::new(path)) {
            return Ok(repo.find_blob(entry.id())?.content().to_vec());
        }
        // Absent from this commit (e.g. the file was deleted here): fall back to
        // the working tree, which yields empty bytes for a file that no longer
        // exists - rendered as empty instead of surfacing an error.
        return Ok(std::fs::read(super::workdir(repo)?.join(path)).unwrap_or_default());
    }
    if staged {
        if let Some(entry) = repo.index()?.get_path(Path::new(path), 0) {
            return Ok(repo.find_blob(entry.id)?.content().to_vec());
        }
    }
    Ok(std::fs::read(super::workdir(repo)?.join(path)).unwrap_or_default())
}

/// Rename detection for the commit + compare file lists. Without it libgit2
/// reports a rename as a delete+add pair; `find_similar` collapses that pair
/// into one `Renamed` delta. `for_untracked` lets a move into a not-yet-staged
/// path still pair with its tracked source (matters for `compare_workdir`).
fn find_renames() -> DiffFindOptions {
    let mut opts = DiffFindOptions::new();
    opts.renames(true).for_untracked(true);
    opts
}

/// Diff between a commit and the current working tree (incl. staged changes).
pub fn compare_workdir(repo: &Repository, sha: &str) -> AppResult<Vec<FileDiff>> {
    let oid = Oid::from_str(sha).map_err(|e| AppError::Msg(format!("invalid commit id: {e}")))?;
    let tree = repo.find_commit(oid)?.tree()?;
    let mut opts = DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let mut diff = repo.diff_tree_to_workdir_with_index(Some(&tree), Some(&mut opts))?;
    diff.find_similar(Some(&mut find_renames()))?;
    diff_to_files(&diff, MAX_DIFF_LINES)
}

/// All file changes introduced by a single commit (vs its first parent).
pub fn commit_diff(repo: &Repository, id: &str) -> AppResult<Vec<FileDiff>> {
    let oid = Oid::from_str(id).map_err(|e| AppError::Msg(format!("invalid commit id: {e}")))?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = DiffOptions::new();
    let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
    diff.find_similar(Some(&mut find_renames()))?;
    diff_to_files(&diff, MAX_DIFF_LINES)
}

/// Line/file stats for a single commit (vs its first parent). Uses `diff.stats()`
/// so the totals are accurate even for big commits whose per-file hunks truncate.
pub fn commit_stats(repo: &Repository, id: &str) -> AppResult<crate::git::repo::WorkStats> {
    let oid = Oid::from_str(id).map_err(|e| AppError::Msg(format!("invalid commit id: {e}")))?;
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = DiffOptions::new();
    let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
    diff.find_similar(Some(&mut find_renames()))?;
    let s = diff.stats()?;
    Ok(crate::git::repo::WorkStats {
        files: s.files_changed(),
        insertions: s.insertions(),
        deletions: s.deletions(),
    })
}

/// All file changes between two arbitrary commits: diff of tree(a) -> tree(b),
/// so `+`/`-` line origins read as b relative to a. Mirrors `commit_diff` but
/// with two explicit endpoints instead of commit-vs-first-parent.
pub fn diff_commits(repo: &Repository, a: &str, b: &str) -> AppResult<Vec<FileDiff>> {
    let oid_a = Oid::from_str(a).map_err(|e| AppError::Msg(format!("invalid commit id: {e}")))?;
    let oid_b = Oid::from_str(b).map_err(|e| AppError::Msg(format!("invalid commit id: {e}")))?;
    let tree_a = repo.find_commit(oid_a)?.tree()?;
    let tree_b = repo.find_commit(oid_b)?.tree()?;
    let mut opts = DiffOptions::new();
    let mut diff = repo.diff_tree_to_tree(Some(&tree_a), Some(&tree_b), Some(&mut opts))?;
    diff.find_similar(Some(&mut find_renames()))?;
    diff_to_files(&diff, MAX_DIFF_LINES)
}

#[cfg(test)]
mod tests {
    use super::{file_content, file_diff, MAX_DIFF_LINES};
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

    // The backend is stateless - open a fresh Repository per call, or libgit2's
    // cached index hides changes the git CLI made.
    fn fresh(dir: &Path) -> Repository {
        Repository::open(dir).unwrap()
    }

    /// A file with no trailing newline makes libgit2 emit "\ No newline at end
    /// of file" pseudo-lines (origins '>', '<', '='). They must not reach the
    /// UI: the split view's -/+ pairing loop cannot advance past such an origin
    /// and spins forever, hanging the webview.
    #[test]
    fn eofnl_markers_are_not_emitted_as_diff_lines() {
        let dir = tmp("eofnl");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("f.txt"), "a\nb").unwrap(); // no trailing newline
        run_git(&dir, &["add", "f.txt"]).unwrap();
        run_git(&dir, &["commit", "-m", "init"]).unwrap();
        std::fs::write(dir.join("f.txt"), "a\nB").unwrap(); // still none

        let fd = file_diff(&fresh(&dir), "f.txt", false, false).unwrap();
        let origins: Vec<&str> =
            fd.hunks.iter().flat_map(|h| h.lines.iter().map(|l| l.origin.as_str())).collect();
        assert!(!origins.is_empty(), "the edit should produce diff lines: {origins:?}");
        assert!(
            origins.iter().all(|o| matches!(*o, " " | "+" | "-")),
            "only real diff origins may reach the UI: {origins:?}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Commit "v1", stage "v2\nv2b", then leave "v3" in the working tree, so all
    /// three content sources (commit / index / workdir) hold distinct text.
    fn three_state_repo(dir: &Path) -> String {
        Repository::init(dir).unwrap();
        run_git(dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("f.txt"), "v1\n").unwrap();
        run_git(dir, &["add", "f.txt"]).unwrap();
        run_git(dir, &["commit", "-m", "init"]).unwrap();
        let sha = run_git(dir, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        std::fs::write(dir.join("f.txt"), "v2\nv2b\n").unwrap();
        run_git(dir, &["add", "f.txt"]).unwrap();
        std::fs::write(dir.join("f.txt"), "v3\n").unwrap();
        sha
    }

    #[test]
    fn commit_stats_counts_insertions_and_deletions() {
        let dir = tmp("commitstats");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("f.txt"), "a\nb\nc\n").unwrap();
        run_git(&dir, &["add", "f.txt"]).unwrap();
        run_git(&dir, &["commit", "-m", "one"]).unwrap();
        // Drop one line ("c"), add two ("d","e"): 2 insertions, 1 deletion.
        std::fs::write(dir.join("f.txt"), "a\nb\nd\ne\n").unwrap();
        run_git(&dir, &["add", "f.txt"]).unwrap();
        run_git(&dir, &["commit", "-m", "two"]).unwrap();
        let sha = run_git(&dir, &["rev-parse", "HEAD"]).unwrap().trim().to_string();

        let s = super::commit_stats(&fresh(&dir), &sha).unwrap();
        assert_eq!(s.files, 1);
        assert_eq!(s.insertions, 2);
        assert_eq!(s.deletions, 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn diffs_two_arbitrary_commits() {
        let dir = tmp("diffcommits");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("f.txt"), "v1\n").unwrap();
        run_git(&dir, &["add", "f.txt"]).unwrap();
        run_git(&dir, &["commit", "-m", "one"]).unwrap();
        let a = run_git(&dir, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        std::fs::write(dir.join("f.txt"), "v2\n").unwrap();
        run_git(&dir, &["add", "f.txt"]).unwrap();
        run_git(&dir, &["commit", "-m", "two"]).unwrap();
        let b = run_git(&dir, &["rev-parse", "HEAD"]).unwrap().trim().to_string();

        let files = super::diff_commits(&fresh(&dir), &a, &b).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "f.txt");
        assert!(!files[0].hunks.is_empty());
        // Reverse endpoints still diffs the same file (b -> a).
        assert_eq!(super::diff_commits(&fresh(&dir), &b, &a).unwrap()[0].path, "f.txt");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reads_workdir_index_and_commit_distinctly() {
        let dir = tmp("filecontent");
        let sha = three_state_repo(&dir);

        let workdir = file_content(&fresh(&dir), "f.txt", None, false, false).unwrap();
        assert_eq!(workdir.lines, ["v3"]);
        assert!(!workdir.binary && !workdir.truncated);

        let index = file_content(&fresh(&dir), "f.txt", None, true, false).unwrap();
        assert_eq!(index.lines, ["v2", "v2b"]);

        let commit = file_content(&fresh(&dir), "f.txt", Some(&sha), false, false).unwrap();
        assert_eq!(commit.lines, ["v1"]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_lookup_miss_renders_empty_not_error() {
        let dir = tmp("filecontentmiss");
        let sha = three_state_repo(&dir);
        // A path absent from the commit's tree (e.g. deleted in that commit) must
        // render as empty rather than surfacing an error in the File preview.
        let ghost = file_content(&fresh(&dir), "ghost.txt", Some(&sha), false, false).unwrap();
        assert!(ghost.lines.is_empty());
        assert!(!ghost.binary && !ghost.truncated);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn caps_line_count_unless_full() {
        let dir = tmp("filecontentcap");
        Repository::init(&dir).unwrap();
        let big = (1..=MAX_DIFF_LINES + 1).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        std::fs::write(dir.join("big.txt"), big).unwrap();

        let capped = file_content(&fresh(&dir), "big.txt", None, false, false).unwrap();
        assert_eq!(capped.lines.len(), MAX_DIFF_LINES);
        assert!(capped.truncated);

        let full = file_content(&fresh(&dir), "big.txt", None, false, true).unwrap();
        assert_eq!(full.lines.len(), MAX_DIFF_LINES + 1);
        assert!(!full.truncated);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn flags_binary_content() {
        let dir = tmp("filecontentbin");
        Repository::init(&dir).unwrap();
        std::fs::write(dir.join("b.bin"), [0u8, 1, 2, 0, 3]).unwrap();

        let c = file_content(&fresh(&dir), "b.bin", None, false, false).unwrap();
        assert!(c.binary);
        assert!(c.lines.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }
    #[test]
    fn commit_diff_collapses_a_rename() {
        let dir = tmp("rename");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("old.txt"), "alpha\nbeta\ngamma\n").unwrap();
        run_git(&dir, &["add", "old.txt"]).unwrap();
        run_git(&dir, &["commit", "-m", "add"]).unwrap();
        // Pure rename (100% similar) -> must surface as one Renamed entry, not a
        // delete + add pair, once find_similar runs in commit_diff.
        run_git(&dir, &["mv", "old.txt", "new.txt"]).unwrap();
        run_git(&dir, &["commit", "-m", "rename"]).unwrap();
        let sha = run_git(&dir, &["rev-parse", "HEAD"]).unwrap().trim().to_string();

        let files = super::commit_diff(&fresh(&dir), &sha).unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(files.len(), 1, "rename should collapse to one row, got {paths:?}");
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].old_path.as_deref(), Some("old.txt"));
        assert!(
            matches!(files[0].status, crate::git::repo::FileStatusKind::Renamed),
            "expected Renamed status"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

}
