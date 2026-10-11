use super::{literal, run_git, run_git_stdin, workdir};
use crate::error::{AppError, AppResult};
use git2::{build::CheckoutBuilder, ObjectType, Repository};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

/// Absolute path of a repo-relative file.
fn abs(repo: &Repository, rel: &str) -> AppResult<String> {
    Ok(workdir(repo)?.join(rel).to_string_lossy().into_owned())
}

/// The target itself if it exists on disk, otherwise its nearest existing
/// ancestor directory. Lets "Show in Finder" still open somewhere useful for a
/// commit's file that no longer exists in the working tree (deleted/renamed).
fn nearest_existing(target: &str) -> std::path::PathBuf {
    let mut p: &Path = Path::new(target);
    if p.exists() {
        return p.to_path_buf();
    }
    while let Some(parent) = p.parent() {
        if parent.exists() {
            return parent.to_path_buf();
        }
        p = parent;
    }
    Path::new(target).to_path_buf()
}

// --- bulk staging (multi-select) ---

/// Stage a batch in ONE index write. The old per-path helper re-opened and
/// rewrote the entire index file for every path, so "Stage all" on a 20k-file
/// tree did ~20k full index serializations (O(N^2) disk). Open once, apply every
/// path, write once.
pub fn stage_paths(repo: &Repository, paths: Vec<String>) -> AppResult<()> {
    let wd = workdir(repo)?.to_path_buf();
    let mut index = repo.index()?;
    for p in &paths {
        let rel = Path::new(p);
        // Path gone from disk -> a staged deletion; otherwise stage its content.
        // symlink_metadata, not exists(): the latter FOLLOWS the link, so a
        // dangling symlink (common in dotfiles repos) reads as gone. An
        // untracked one was then silently never staged, and a TRACKED one whose
        // target had been deleted was staged as a deletion of a file that is
        // still right there.
        if wd.join(p).symlink_metadata().is_ok() {
            index.add_path(rel)?;
        } else {
            index.remove_path(rel)?;
        }
    }
    index.write()?;
    Ok(())
}

/// Unstage a batch in ONE reset (reset_default takes a pathspec iterator), vs the
/// old per-path reset that rewrote the index each time.
pub fn unstage_paths(repo: &Repository, paths: Vec<String>) -> AppResult<()> {
    match repo.head().ok().and_then(|h| h.peel(ObjectType::Commit).ok()) {
        Some(head) => repo.reset_default(Some(&head), paths.iter().map(String::as_str))?,
        None => {
            // No commits yet: nothing in HEAD to reset to, just drop from the index.
            let mut index = repo.index()?;
            for p in &paths {
                index.remove_path(Path::new(p))?;
            }
            index.write()?;
        }
    }
    Ok(())
}

/// Discard a batch: peel HEAD->tree ONCE to classify tracked vs untracked, then
/// do a SINGLE checkout for all tracked paths (the old code peeled HEAD and ran a
/// checkout per path). Untracked (new) files aren't in HEAD, so the only way to
/// discard them is to delete them from disk.
pub fn discard_paths(repo: &Repository, paths: Vec<String>) -> AppResult<()> {
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let wd = workdir(repo)?.to_path_buf();
    let mut cob = CheckoutBuilder::new();
    let mut any_tracked = false;
    for p in &paths {
        let tracked = head_tree
            .as_ref()
            .map(|t| t.get_path(Path::new(p)).is_ok())
            .unwrap_or(false);
        if tracked {
            cob.path(p.as_str());
            any_tracked = true;
        } else {
            let full = wd.join(p);
            if full.exists() {
                std::fs::remove_file(full)?;
            }
        }
    }
    // CRITICAL: only checkout when at least one tracked path was added. An empty
    // pathspec with force() would check out the ENTIRE working tree from HEAD.
    if any_tracked {
        cob.force();
        repo.checkout_head(Some(&mut cob))?;
    }
    Ok(())
}

/// Discard `paths` but keep a recoverable copy: a path-scoped `git stash push
/// --include-untracked` removes exactly the same changes a discard would (tracked
/// edits revert, untracked files are removed) and leaves a stash behind. Returns
/// that stash's commit sha, or None when nothing could be stashed (nothing to
/// save, or git refused, e.g. unmerged paths) and a plain discard ran instead.
pub fn discard_paths_with_backup(
    repo: &Repository,
    paths: Vec<String>,
    message: &str,
) -> AppResult<Option<String>> {
    let dir = workdir(repo)?;
    let lits: Vec<String> = paths.iter().map(|p| literal(p)).collect();
    let mut args: Vec<&str> = vec!["stash", "push", "--include-untracked", "-m", message, "--"];
    args.extend(lits.iter().map(String::as_str));
    // Compare the stash tip before and after instead of matching git's (localized)
    // "No local changes to save" text.
    let tip = || run_git(dir, &["rev-parse", "-q", "--verify", "refs/stash"]).ok().map(|s| s.trim().to_string());
    let before = tip();
    if run_git(dir, &args).is_ok() {
        let after = tip();
        if after.is_some() && after != before {
            return Ok(after);
        }
    }
    discard_paths(repo, paths)?;
    Ok(None)
}

// --- partial (hunk-level) staging ---

/// The "-a,b +c,d" core of a hunk header, ignoring the trailing function-context
/// heading (libgit2 and the git CLI can format that part differently). Uniquely
/// identifies a hunk within one file's diff.
fn hunk_key(header: &str) -> Option<&str> {
    let rest = header.strip_prefix("@@ ")?;
    let end = rest.find(" @@")?;
    Some(&rest[..end])
}

/// Split a `git diff` patch into its file-header block (everything before the
/// first "@@") and the single hunk whose "-a,b +c,d" key matches `target`.
fn carve_hunk(patch: &str, target: &str) -> AppResult<(String, String)> {
    let mut header = String::new();
    let mut hunks: Vec<String> = Vec::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("@@ ") {
            hunks.push(String::new());
        }
        match hunks.last_mut() {
            Some(h) => h.push_str(line),
            None => header.push_str(line),
        }
    }
    let hunk = hunks
        .into_iter()
        .find(|h| h.lines().next().and_then(hunk_key) == Some(target))
        .ok_or_else(|| AppError::Msg("hunk no longer matches the file - refresh and retry".into()))?;
    Ok((header, hunk))
}

/// `git diff` pinned to the shape `carve_hunk` and `git apply -p1` expect: a
/// user's `diff.context`, `diff.noprefix`, `diff.external` or a textconv
/// attribute each otherwise break EVERY hunk stage/unstage/discard with a
/// misleading "hunk no longer matches the file" error.
fn pinned_diff(dir: &Path, staged: bool, path: &str) -> AppResult<String> {
    let mut args = vec![
        "diff",
        "-U3",
        "--no-ext-diff",
        "--no-textconv",
        // libgit2 produced the header we match against, and it enables neither
        // of these: git's CLI turns the indent heuristic on by DEFAULT, which
        // shifts hunk boundaries near blank lines, so without this the headers
        // disagree on ordinary content with no user config at all.
        "--no-indent-heuristic",
        "--diff-algorithm=myers",
        "--src-prefix=a/",
        "--dst-prefix=b/",
    ];
    if staged {
        args.push("--cached");
    }
    let spec = literal(path);
    args.push("--");
    args.push(&spec);
    run_git(dir, &args)
}

/// Stage, unstage, or discard a single hunk. Rather than reconstruct a patch
/// (fragile around "\ No newline" markers), carve the matching hunk out of git's
/// own `git diff` output and pipe it back through `git apply`:
///   stage   - worktree-vs-index diff, applied to the index
///   unstage - index-vs-HEAD diff, reverse-applied to the index
///   discard - worktree-vs-index diff, reverse-applied to the working tree
pub fn apply_hunk(repo: &Repository, path: &str, action: &str, hunk_header: &str) -> AppResult<()> {
    let dir = workdir(repo)?;
    let (staged, apply_args): (bool, &[&str]) = match action {
        "stage" => (false, &["apply", "--cached"]),
        "unstage" => (true, &["apply", "--cached", "--reverse"]),
        "discard" => (false, &["apply", "--reverse"]),
        other => return Err(AppError::Msg(format!("unknown hunk action: {other}"))),
    };
    let target = hunk_key(hunk_header).ok_or_else(|| AppError::Msg("malformed hunk header".into()))?;
    let patch = pinned_diff(dir, staged, path)?;
    let (header, hunk) = carve_hunk(&patch, target)?;
    run_git_stdin(dir, apply_args, &format!("{header}{hunk}"))?;
    Ok(())
}

/// Old/new start line of a hunk header `@@ -A[,B] +C[,D] @@`.
fn parse_hunk_start(header: &str) -> AppResult<(u32, u32)> {
    let bad = || AppError::Msg("malformed hunk header".into());
    let rest = header.strip_prefix("@@ -").ok_or_else(bad)?;
    let mut parts = rest.split(' ');
    let old = parts.next().ok_or_else(bad)?;
    let new = parts.next().and_then(|p| p.strip_prefix('+')).ok_or_else(bad)?;
    let start = |seg: &str| seg.split(',').next().unwrap_or("").parse::<u32>().map_err(|_| bad());
    Ok((start(old)?, start(new)?))
}

/// Stage / unstage / discard a SELECTED SUBSET of one hunk's changed lines.
/// `selected` holds the line keys the diff view assigns: "+<new_lineno>" for an
/// addition, "-<old_lineno>" for a deletion. We carve the hunk from git's own
/// diff, keep the selected changes, turn unselected changes on the apply target's
/// side into context (and drop the rest), then `git apply --recount`.
pub fn apply_lines(
    repo: &Repository,
    path: &str,
    action: &str,
    hunk_header: &str,
    selected: Vec<String>,
) -> AppResult<()> {
    let dir = workdir(repo)?;
    let reverse = matches!(action, "discard" | "unstage");
    let (staged, apply_args): (bool, &[&str]) = match action {
        "stage" => (false, &["apply", "--cached", "--recount"]),
        "unstage" => (true, &["apply", "--cached", "--reverse", "--recount"]),
        "discard" => (false, &["apply", "--reverse", "--recount"]),
        other => return Err(AppError::Msg(format!("unknown line action: {other}"))),
    };
    let target = hunk_key(hunk_header).ok_or_else(|| AppError::Msg("malformed hunk header".into()))?;
    let patch = pinned_diff(dir, staged, path)?;
    let (header, hunk) = carve_hunk(&patch, target)?;

    // The "\ No newline at end of file" marker can't be repositioned correctly
    // once lines are filtered, so refuse partial staging on such hunks (the
    // whole-hunk path stays byte-exact). Rare in practice.
    if hunk.lines().any(|l| l.starts_with('\\')) {
        return Err(AppError::Msg(
            "Line-level staging isn't supported for a file with no trailing newline - use Stage hunk.".into(),
        ));
    }

    // Parse "+<n>"/"-<n>" keys once into (is_add, lineno) to avoid per-line allocs.
    let mut sel: std::collections::HashSet<(bool, u32)> = std::collections::HashSet::new();
    for key in &selected {
        let (sign, rest) = key.split_at(1.min(key.len()));
        if let Ok(n) = rest.parse::<u32>() {
            sel.insert((sign == "+", n));
        }
    }

    let mut lines = hunk.lines();
    let head = lines.next().ok_or_else(|| AppError::Msg("empty hunk".into()))?;
    let (mut old_ln, mut new_ln) = parse_hunk_start(head)?;

    // Auto-expand the selection across replacement blocks. A maximal run of change
    // lines (no intervening context) that has BOTH a deletion and an addition is a
    // replacement; staging only one side would leave the other in place (keep
    // `old` AND add `new`), so if any line of such a run is selected, select the
    // whole run. Pure add-only / delete-only runs keep fine-grained line selection.
    {
        let (mut o, mut n) = (old_ln, new_ln);
        let mut run: Vec<(bool, u32)> = Vec::new();
        let (mut had_del, mut had_add) = (false, false);
        for line in hunk.lines().skip(1) {
            match line.chars().next().unwrap_or(' ') {
                '-' => {
                    run.push((false, o));
                    had_del = true;
                    o += 1;
                }
                '+' => {
                    run.push((true, n));
                    had_add = true;
                    n += 1;
                }
                _ => {
                    if had_del && had_add && run.iter().any(|k| sel.contains(k)) {
                        sel.extend(run.iter().copied());
                    }
                    run.clear();
                    had_del = false;
                    had_add = false;
                    o += 1;
                    n += 1;
                }
            }
        }
        if had_del && had_add && run.iter().any(|k| sel.contains(k)) {
            sel.extend(run.iter().copied());
        }
    }
    let mut out = String::with_capacity(header.len() + hunk.len());
    out.push_str(&header);
    out.push_str(head);
    out.push('\n');
    for line in lines {
        match line.chars().next().unwrap_or(' ') {
            '-' => {
                let keep = sel.contains(&(false, old_ln));
                old_ln += 1;
                if keep {
                    out.push_str(line);
                    out.push('\n');
                } else if !reverse {
                    // forward apply: deletion stays in the pre-image as context
                    out.push(' ');
                    out.push_str(&line[1..]);
                    out.push('\n');
                }
            }
            '+' => {
                let keep = sel.contains(&(true, new_ln));
                new_ln += 1;
                if keep {
                    out.push_str(line);
                    out.push('\n');
                } else if reverse {
                    // reverse apply: addition is present in the post-image as context
                    out.push(' ');
                    out.push_str(&line[1..]);
                    out.push('\n');
                }
            }
            _ => {
                out.push_str(line);
                out.push('\n');
                old_ln += 1;
                new_ln += 1;
            }
        }
    }
    run_git_stdin(dir, apply_args, &out)?;
    Ok(())
}

// --- git file actions ---

/// Append a pattern to .gitignore, creating it if needed. Idempotent.
pub fn ignore_path(repo: &Repository, pattern: &str) -> AppResult<()> {
    let gi = workdir(repo)?.join(".gitignore");
    let mut content = std::fs::read_to_string(&gi).unwrap_or_default();
    if content.lines().any(|l| l.trim() == pattern) {
        return Ok(());
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(pattern);
    content.push('\n');
    std::fs::write(&gi, content)?;
    Ok(())
}

/// Stash one file. `--include-untracked` lets new (untracked) files be stashed
/// too; the pathspec keeps it scoped to just this file, so other untracked files
/// are left alone.
pub fn stash_file(repo: &Repository, path: &str) -> AppResult<String> {
    run_git(workdir(repo)?, &["stash", "push", "--include-untracked", "--", &literal(path)])
}

/// Every tracked file in the working tree (repo-relative paths), for quick-open.
/// `-z` gives NUL-separated, verbatim paths (no core.quotePath escaping and safe
/// for names containing newlines).
pub fn list_tracked(repo: &Repository) -> AppResult<Vec<String>> {
    let raw = run_git(workdir(repo)?, &["ls-files", "-z"])?;
    Ok(raw.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

/// Write a unified diff for one file (staged + unstaged vs HEAD) to `dest`.
pub fn save_patch(repo: &Repository, path: &str, dest: &str) -> AppResult<()> {
    let patch = run_git(workdir(repo)?, &["diff", "HEAD", "--", &literal(path)])?;
    std::fs::write(dest, patch)?;
    Ok(())
}

/// Delete a working-tree file but keep a copy in `.git/gitchef-trash/` (outside
/// the work tree, so it never shows up as a change) so it can be restored.
/// Returns the backup path. Copies older than a week are pruned on each call.
pub fn delete_file_with_backup(repo: &Repository, path: &str) -> AppResult<String> {
    let src = workdir(repo)?.join(path);
    let trash = repo.path().join("gitchef-trash");
    std::fs::create_dir_all(&trash)?;
    prune_trash(&trash);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dest = trash.join(format!("{nanos}-{}", path.replace(['/', '\\'], "_")));
    std::fs::copy(&src, &dest)?;
    std::fs::remove_file(&src)?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Put a file deleted by `delete_file_with_backup` back. Refuses to overwrite an
/// existing file and to read from anywhere but this repo's trash directory.
pub fn restore_deleted_file(repo: &Repository, path: &str, backup: &str) -> AppResult<()> {
    let target = workdir(repo)?.join(path);
    if target.exists() {
        return Err(AppError::Msg(format!("{path} already exists; not overwriting it")));
    }
    let trash = repo.path().join("gitchef-trash").canonicalize()?;
    let src = Path::new(backup).canonicalize()?;
    if !src.starts_with(&trash) {
        return Err(AppError::Msg("backup is not in this repository's trash".into()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(&src, &target)?;
    std::fs::remove_file(&src).ok();
    Ok(())
}

fn prune_trash(trash: &Path) {
    let week = std::time::Duration::from_secs(7 * 24 * 3600);
    if let Ok(entries) = std::fs::read_dir(trash) {
        for e in entries.flatten() {
            let old = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map(|age| age > week)
                .unwrap_or(false);
            if old {
                std::fs::remove_file(e.path()).ok();
            }
        }
    }
}

/// Copy a working-tree file into `.git/gitchef-trash/` before a partial (hunk or
/// line) discard. Pair with `finish_snapshot` after the discard and
/// `restore_file_snapshot` to undo it. Returns the backup path.
pub fn snapshot_file(repo: &Repository, path: &str) -> AppResult<String> {
    let src = workdir(repo)?.join(path);
    let trash = repo.path().join("gitchef-trash");
    std::fs::create_dir_all(&trash)?;
    prune_trash(&trash);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dest = trash.join(format!("{nanos}-snap-{}", path.replace(['/', '\\'], "_")));
    std::fs::copy(&src, &dest)?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Record the file as it is right after the discard (`<backup>.after`), so a later
/// restore can tell whether the file has been edited since.
pub fn finish_snapshot(repo: &Repository, path: &str, backup: &str) -> AppResult<()> {
    let src = workdir(repo)?.join(path);
    std::fs::copy(src, format!("{backup}.after"))?;
    Ok(())
}

/// Put back the file as it was before the discard. Refuses when the file changed
/// since the discard (that would silently throw away newer edits) and when the
/// backup is outside this repo's trash directory.
pub fn restore_file_snapshot(repo: &Repository, path: &str, backup: &str) -> AppResult<()> {
    let target = workdir(repo)?.join(path);
    let trash = repo.path().join("gitchef-trash").canonicalize()?;
    let before = Path::new(backup).canonicalize()?;
    if !before.starts_with(&trash) {
        return Err(AppError::Msg("backup is not in this repository's trash".into()));
    }
    let after = format!("{backup}.after");
    if std::fs::read(&target)? != std::fs::read(&after)? {
        return Err(AppError::Msg(format!(
            "{path} changed since the discard; not restoring over newer edits"
        )));
    }
    std::fs::copy(&before, &target)?;
    std::fs::remove_file(&before).ok();
    std::fs::remove_file(&after).ok();
    Ok(())
}

pub fn delete_file(repo: &Repository, path: &str) -> AppResult<()> {
    std::fs::remove_file(abs(repo, path)?)?;
    Ok(())
}

// --- OS integration (per-platform) ---

/// Put text on the system clipboard (pbcopy on macOS, clip on Windows, xclip on
/// other unixes).
pub fn copy_text(text: &str) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("pbcopy");
    #[cfg(target_os = "windows")]
    let mut cmd = Command::new("clip");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xclip");
        c.args(["-selection", "clipboard"]);
        c
    };

    let mut child = cmd.stdin(Stdio::piped()).spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes())?;
    }
    child.wait()?;
    Ok(())
}

/// Reveal a file in the OS file manager (selecting it where supported).
pub fn reveal_in_finder(repo: &Repository, path: &str) -> AppResult<()> {
    let target = abs(repo, path)?;
    // The working-tree file may be gone (revealing a file from an old commit);
    // fall back to the nearest existing folder so Finder still opens.
    let exists = Path::new(&target).exists();
    let reveal = nearest_existing(&target);
    #[cfg(target_os = "macos")]
    {
        // `-R` selects the file; without it we just open the folder.
        if exists {
            Command::new("open").arg("-R").arg(&reveal).spawn()?;
        } else {
            Command::new("open").arg(&reveal).spawn()?;
        }
    }
    #[cfg(target_os = "windows")]
    {
        if exists {
            Command::new("explorer").arg(format!("/select,{}", reveal.display())).spawn()?;
        } else {
            Command::new("explorer").arg(&reveal).spawn()?;
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if exists {
            reveal.parent().map(|p| p.to_path_buf()).unwrap_or(reveal.clone())
        } else {
            reveal.clone()
        };
        Command::new("xdg-open").arg(dir).spawn()?;
    }
    Ok(())
}

/// Reveal an arbitrary path (e.g. a repo's own folder) in the OS file manager.
/// Unlike `reveal_in_finder`, the path is absolute and not resolved through a
/// repo, so it works for tabs/recents even if the folder isn't a valid repo.
pub fn reveal_path(path: &str) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    Command::new("open").arg("-R").arg(path).spawn()?;
    #[cfg(target_os = "windows")]
    Command::new("explorer").arg(format!("/select,{path}")).spawn()?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open").arg(path).spawn()?;
    Ok(())
}

/// Open an OS terminal at `path` (a repo folder). Best-effort per platform.
pub fn open_terminal(path: &str) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    Command::new("open").args(["-a", "Terminal"]).arg(path).spawn()?;
    // Pass the directory via current_dir, not as a shell arg: a repo path with
    // cmd metacharacters (& | etc.) would otherwise be a command-injection vector.
    // `start cmd` opens a fresh terminal window inheriting that working directory.
    #[cfg(target_os = "windows")]
    Command::new("cmd").args(["/C", "start", "cmd"]).current_dir(path).spawn()?;
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let launched = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]
            .iter()
            .any(|t| Command::new(t).current_dir(path).spawn().is_ok());
        if !launched {
            return Err(AppError::Msg("no terminal emulator found".into()));
        }
    }
    Ok(())
}

/// Hand `arg` (a file path or a URL) to the OS default handler - Finder/Explorer
/// open a file, the browser opens a URL. Args go straight to the launcher's argv
/// (no shell) on macOS/Linux; on Windows `start` runs via cmd, so callers pass
/// pre-encoded URLs so a metacharacter can't leak through.
fn os_open(arg: &std::ffi::OsStr) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    Command::new("open").arg(arg).spawn()?;
    #[cfg(target_os = "windows")]
    Command::new("cmd").args(["/C", "start", ""]).arg(arg).spawn()?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open").arg(arg).spawn()?;
    Ok(())
}

/// Open a file with the OS default application.
pub fn open_default(repo: &Repository, path: &str) -> AppResult<()> {
    let target = abs(repo, path)?;
    os_open(target.as_ref())
}

/// Open a URL in the default browser.
pub fn open_url(url: &str) -> AppResult<()> {
    os_open(url.as_ref())
}

/// Open the file in the user's configured editor (git core.editor, else $VISUAL
/// / $EDITOR). Spawned detached so GUI editors don't block the app.
/// Resolve the user's editor and open `target` (absolute path) with it,
/// falling back to the OS default text editor when none is configured.
fn open_path_in_editor(dir: &Path, target: &str) -> AppResult<()> {
    let editor = run_git(dir, &["config", "core.editor"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("VISUAL").ok())
        .or_else(|| std::env::var("EDITOR").ok())
        .filter(|s| !s.trim().is_empty());

    match editor {
        Some(editor) => {
            // Split "code --wait" into program + args and pass the file as a
            // separate arg - never interpolate the path into a shell string.
            let mut parts = editor.split_whitespace();
            let program = parts
                .next()
                .ok_or_else(|| AppError::Msg("empty editor configuration".into()))?;
            Command::new(program).args(parts).arg(target).current_dir(dir).spawn()?;
        }
        // GUI apps don't inherit the shell's $EDITOR and many users never set
        // git core.editor, so fall back to the OS default text editor rather
        // than failing outright.
        None => {
            #[cfg(target_os = "macos")]
            Command::new("open").arg("-t").arg(target).spawn()?;
            #[cfg(target_os = "windows")]
            Command::new("cmd").args(["/C", "start", ""]).arg(target).spawn()?;
            #[cfg(all(unix, not(target_os = "macos")))]
            Command::new("xdg-open").arg(target).spawn()?;
        }
    }
    Ok(())
}

/// Open the working-tree file in the user's editor.
pub fn open_in_editor(repo: &Repository, path: &str) -> AppResult<()> {
    open_path_in_editor(workdir(repo)?, &abs(repo, path)?)
}

/// Open a file as it existed in commit `sha`. If the working-tree file is still
/// present, open that (editable); otherwise extract the commit's blob to a temp
/// file and open that snapshot - so a file renamed or deleted since the commit
/// can still be inspected instead of erroring with "does not exist".
pub fn open_commit_file_in_editor(repo: &Repository, sha: &str, path: &str) -> AppResult<()> {
    let dir = workdir(repo)?;
    let wt = abs(repo, path)?;
    let target = if Path::new(&wt).exists() {
        wt
    } else {
        extract_commit_blob(repo, sha, path)?
    };
    open_path_in_editor(dir, &target)
}

/// Write a commit's version of `path` to a temp file and return its path.
fn extract_commit_blob(repo: &Repository, sha: &str, path: &str) -> AppResult<String> {
    let commit = repo.find_commit(git2::Oid::from_str(sha)?)?;
    let entry = commit.tree()?.get_path(Path::new(path))?;
    let object = entry.to_object(repo)?;
    let blob = object
        .as_blob()
        .ok_or_else(|| AppError::Msg("that path is not a file in the commit".into()))?;
    // <tmp>/gitchef/<sha7>/<rel/path> keeps the real filename so the editor
    // shows the right name and syntax highlighting.
    let dest = std::env::temp_dir()
        .join("gitchef")
        .join(&sha[..sha.len().min(7)])
        .join(path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&dest, blob.content())?;
    Ok(dest.to_string_lossy().into_owned())
}

pub fn open_difftool(repo: &Repository, path: &str) -> AppResult<()> {
    Command::new("git")
        .current_dir(workdir(repo)?)
        .args(["difftool", "--no-prompt", "--", &literal(path)])
        .spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{apply_hunk, apply_lines, discard_paths, discard_paths_with_backup, delete_file_with_backup, finish_snapshot, restore_deleted_file, restore_file_snapshot, snapshot_file, list_tracked, stage_paths, stash_file, unstage_paths};
    use crate::git::{diff, run_git};
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

    /// 30 unambiguous lines, so a change in one region never collides with text
    /// elsewhere (e.g. "line03" must not be a substring of "line30").
    fn base() -> String {
        (1..=30).map(|i| format!("line{i:02}")).collect::<Vec<_>>().join("\n") + "\n"
    }

    /// Set up a repo whose working tree differs from HEAD in two separate
    /// regions (lines 03 and 25) - i.e. two hunks.
    fn two_hunk_repo(dir: &Path) {
        Repository::init(dir).unwrap();
        run_git(dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("f.txt"), base()).unwrap();
        run_git(dir, &["add", "f.txt"]).unwrap();
        run_git(dir, &["commit", "-m", "init"]).unwrap();
        let modified = base().replace("line03\n", "line03_X\n").replace("line25\n", "line25_X\n");
        std::fs::write(dir.join("f.txt"), modified).unwrap();
    }

    // The real backend is stateless - every command opens a fresh Repository - so
    // tests must too, or libgit2's cached index hides changes the git CLI made.
    fn fresh(dir: &Path) -> Repository {
        Repository::open(dir).unwrap()
    }
    fn fdiff(dir: &Path, staged: bool) -> diff::FileDiff {
        diff::file_diff(&fresh(dir), "f.txt", staged, false).unwrap()
    }

    fn changed(fd: &diff::FileDiff) -> Vec<String> {
        fd.hunks
            .iter()
            .flat_map(|h| h.lines.iter())
            .filter(|l| l.origin == "+" || l.origin == "-")
            .map(|l| format!("{}{}", l.origin, l.content))
            .collect()
    }

    #[test]
    fn stage_single_hunk_leaves_the_other_unstaged() {
        let dir = tmp("stage");
        two_hunk_repo(&dir);
        let unstaged = fdiff(&dir, false);
        assert_eq!(unstaged.hunks.len(), 2, "fixture should produce two hunks");
        // Header here is libgit2's; apply_hunk must match it against git's CLI patch.
        let hunk2 = unstaged.hunks[1].header.clone();

        apply_hunk(&fresh(&dir), "f.txt", "stage", &hunk2).unwrap();

        let staged = changed(&fdiff(&dir, true));
        let still = changed(&fdiff(&dir, false));
        assert!(staged.contains(&"+line25_X".into()), "hunk2 staged: {staged:?}");
        assert!(!staged.contains(&"+line03_X".into()), "hunk1 NOT staged: {staged:?}");
        assert!(still.contains(&"+line03_X".into()), "hunk1 still unstaged: {still:?}");
        assert!(!still.contains(&"+line25_X".into()), "hunk2 left unstaged set: {still:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A user gitconfig must not reach the hunk pipeline. `diff.context` shifts
    /// the CLI's hunk headers away from libgit2's and `diff.noprefix` strips the
    /// a//b/ prefixes `git apply -p1` needs - either one broke every hunk stage
    /// with a misleading "hunk no longer matches" error. `diff.algorithm` and
    /// `diff.indentHeuristic` are pinned for the same reason (libgit2 uses Myers
    /// with no heuristic); they don't shift the header in this fixture, but the
    /// flags keep the CLI on libgit2's footing whatever the user has set.
    #[test]
    fn stage_single_hunk_ignores_user_diff_config() {
        let dir = tmp("stage-cfg");
        two_hunk_repo(&dir);
        run_git(&dir, &["config", "diff.context", "5"]).unwrap();
        run_git(&dir, &["config", "diff.noprefix", "true"]).unwrap();
        run_git(&dir, &["config", "diff.algorithm", "histogram"]).unwrap();
        run_git(&dir, &["config", "diff.indentHeuristic", "true"]).unwrap();
        let hunk2 = fdiff(&dir, false).hunks[1].header.clone();

        apply_hunk(&fresh(&dir), "f.txt", "stage", &hunk2).unwrap();

        let staged = changed(&fdiff(&dir, true));
        assert!(staged.contains(&"+line25_X".into()), "hunk2 staged: {staged:?}");
        assert!(!staged.contains(&"+line03_X".into()), "hunk1 NOT staged: {staged:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A dangling symlink reads as "gone" to `Path::exists`, which made
    /// `stage_paths` take the deletion branch and fail the WHOLE batch.
    #[test]
    #[cfg(unix)]
    fn stage_paths_handles_a_broken_symlink_without_failing_the_batch() {
        let dir = tmp("stage-symlink");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("real.txt"), "a\n").unwrap();
        std::os::unix::fs::symlink("/nonexistent/target", dir.join("broken.link")).unwrap();

        stage_paths(&fresh(&dir), vec!["broken.link".into(), "real.txt".into()]).unwrap();

        let staged = run_git(&dir, &["diff", "--cached", "--name-only"]).unwrap();
        assert!(staged.contains("real.txt"), "the rest of the batch still stages: {staged:?}");
        assert!(staged.contains("broken.link"), "the dangling symlink itself stages: {staged:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Everything after `--` is a PATHSPEC. A real file named `foo[1].txt` also
    /// matches `foo1.txt` as a glob, so without `:(literal)` stashing one file
    /// silently stashed its neighbour away too.
    #[test]
    fn a_glob_metacharacter_filename_only_affects_itself() {
        let dir = tmp("glob-path");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("foo1.txt"), "neighbour\n").unwrap();
        std::fs::write(dir.join("foo[1].txt"), "target\n").unwrap();
        run_git(&dir, &["add", "-A"]).unwrap();
        run_git(&dir, &["commit", "-m", "init"]).unwrap();
        std::fs::write(dir.join("foo1.txt"), "neighbour edited\n").unwrap();
        std::fs::write(dir.join("foo[1].txt"), "target edited\n").unwrap();

        stash_file(&fresh(&dir), "foo[1].txt").unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.join("foo1.txt")).unwrap(),
            "neighbour edited\n",
            "the glob-matching neighbour must be left untouched"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("foo[1].txt")).unwrap(),
            "target\n",
            "the named file itself is stashed back to HEAD"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discard_single_hunk_reverts_only_that_region() {
        let dir = tmp("discard");
        two_hunk_repo(&dir);
        let hunk1 = fdiff(&dir, false).hunks[0].header.clone();

        apply_hunk(&fresh(&dir), "f.txt", "discard", &hunk1).unwrap();

        let wt = std::fs::read_to_string(dir.join("f.txt")).unwrap();
        assert!(!wt.contains("line03_X"), "hunk1 reverted in worktree");
        assert!(wt.contains("line25_X"), "hunk2 kept in worktree");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unstage_single_hunk_returns_it_to_the_working_tree() {
        let dir = tmp("unstage");
        two_hunk_repo(&dir);
        run_git(&dir, &["add", "f.txt"]).unwrap(); // stage both hunks
        let staged = fdiff(&dir, true);
        assert_eq!(staged.hunks.len(), 2);
        let hunk1 = staged.hunks[0].header.clone();

        apply_hunk(&fresh(&dir), "f.txt", "unstage", &hunk1).unwrap();

        let still_staged = changed(&fdiff(&dir, true));
        let unstaged = changed(&fdiff(&dir, false));
        assert!(still_staged.contains(&"+line25_X".into()), "hunk2 still staged: {still_staged:?}");
        assert!(!still_staged.contains(&"+line03_X".into()), "hunk1 unstaged: {still_staged:?}");
        assert!(unstaged.contains(&"+line03_X".into()), "hunk1 back in worktree diff: {unstaged:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stash_file_includes_untracked_and_scopes_to_one_path() {
        let dir = tmp("stashfile");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("tracked.txt"), "a\n").unwrap();
        run_git(&dir, &["add", "."]).unwrap();
        run_git(&dir, &["commit", "-m", "init"]).unwrap();
        std::fs::write(dir.join("new.txt"), "new\n").unwrap();
        std::fs::write(dir.join("other.txt"), "other\n").unwrap();

        // The old `stash push -- <path>` errored on untracked files; this must not.
        stash_file(&fresh(&dir), "new.txt").unwrap();

        assert!(!dir.join("new.txt").exists(), "the untracked file should be stashed away");
        assert!(dir.join("other.txt").exists(), "other untracked files must be left alone");
        run_git(&dir, &["stash", "pop"]).unwrap();
        assert!(dir.join("new.txt").exists(), "pop restores the stashed untracked file");
        std::fs::remove_dir_all(&dir).ok();
    }

    // A file whose working tree differs from HEAD in two regions PLUS a pure
    // addition - all inside one hunk, so line-level selection is meaningful.
    fn multi_change_repo(dir: &Path) {
        Repository::init(dir).unwrap();
        run_git(dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(dir, &["config", "user.name", "t"]).unwrap();
        let base: String = (1..=6).map(|i| format!("L{i:02}\n")).collect();
        std::fs::write(dir.join("f.txt"), base).unwrap();
        run_git(dir, &["add", "f.txt"]).unwrap();
        run_git(dir, &["commit", "-m", "init"]).unwrap();
        std::fs::write(dir.join("f.txt"), "L01\nL02_X\nL03\nL04_X\nL05\nL05b\nL06\n").unwrap();
    }

    // Build the apply_lines key ("+<new>"/"-<old>") for the diff line whose
    // content matches `text`, exactly as the diff view does from libgit2 data.
    fn key_for(fd: &diff::FileDiff, text: &str) -> String {
        let l = fd.hunks.iter().flat_map(|h| &h.lines).find(|l| l.content == text).unwrap();
        if l.origin == "+" {
            format!("+{}", l.new_lineno.unwrap())
        } else {
            format!("-{}", l.old_lineno.unwrap())
        }
    }

    #[test]
    fn stage_selected_lines_only() {
        let dir = tmp("stagelines");
        multi_change_repo(&dir);
        let fd = fdiff(&dir, false);
        let header = fd.hunks[0].header.clone();
        // Stage just the L02 change, leaving L04 and the new line untouched.
        let keys = vec![key_for(&fd, "L02"), key_for(&fd, "L02_X")];
        apply_lines(&fresh(&dir), "f.txt", "stage", &header, keys).unwrap();

        let staged = changed(&fdiff(&dir, true));
        let unstaged = changed(&fdiff(&dir, false));
        assert!(staged.contains(&"+L02_X".into()) && staged.contains(&"-L02".into()), "{staged:?}");
        assert!(!staged.contains(&"+L04_X".into()) && !staged.contains(&"+L05b".into()), "{staged:?}");
        assert!(unstaged.contains(&"+L04_X".into()) && unstaged.contains(&"+L05b".into()), "{unstaged:?}");
        assert!(!unstaged.contains(&"+L02_X".into()), "{unstaged:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discard_selected_lines_only() {
        let dir = tmp("discardlines");
        multi_change_repo(&dir);
        let fd = fdiff(&dir, false);
        let header = fd.hunks[0].header.clone();
        // Discard only the brand-new line; both edits stay in the working tree.
        apply_lines(&fresh(&dir), "f.txt", "discard", &header, vec![key_for(&fd, "L05b")]).unwrap();

        let wt = std::fs::read_to_string(dir.join("f.txt")).unwrap();
        assert!(!wt.contains("L05b"), "new line discarded: {wt:?}");
        assert!(wt.contains("L02_X") && wt.contains("L04_X"), "edits kept: {wt:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn apply_lines_expands_half_selected_replacement() {
        let dir = tmp("expandlines");
        multi_change_repo(&dir);
        let fd = fdiff(&dir, false);
        let header = fd.hunks[0].header.clone();
        // Select ONLY the "+" side of the L02 replacement (-L02 / +L02_X).
        apply_lines(&fresh(&dir), "f.txt", "stage", &header, vec![key_for(&fd, "L02_X")]).unwrap();

        // The whole replacement is staged - old removed AND new added - not a
        // half-state that would keep L02 and also add L02_X.
        let staged = changed(&fdiff(&dir, true));
        assert!(staged.contains(&"+L02_X".into()) && staged.contains(&"-L02".into()), "{staged:?}");
        assert!(!staged.contains(&"+L04_X".into()) && !staged.contains(&"+L05b".into()), "{staged:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn apply_lines_refuses_no_trailing_newline_hunk() {
        let dir = tmp("nonl");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("f.txt"), "A\nB\nC").unwrap(); // no trailing newline
        run_git(&dir, &["add", "f.txt"]).unwrap();
        run_git(&dir, &["commit", "-m", "init"]).unwrap();
        std::fs::write(dir.join("f.txt"), "A\nB_X\nC_X").unwrap();
        let fd = fdiff(&dir, false);
        let header = fd.hunks[0].header.clone();

        // Partial staging must refuse (not corrupt) and leave the index untouched.
        let err = apply_lines(&fresh(&dir), "f.txt", "stage", &header, vec![key_for(&fd, "B_X")]);
        assert!(err.is_err(), "no-newline partial staging must be refused");
        assert!(fdiff(&dir, true).hunks.is_empty(), "index must be untouched");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stage_paths_batches_modify_delete_add() {
        let dir = tmp("stagepaths");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        std::fs::write(dir.join("b.txt"), "b\n").unwrap();
        run_git(&dir, &["add", "."]).unwrap();
        run_git(&dir, &["commit", "-m", "init"]).unwrap();
        // a modified, b deleted from disk, c brand new - one batched index write.
        std::fs::write(dir.join("a.txt"), "a2\n").unwrap();
        std::fs::remove_file(dir.join("b.txt")).unwrap();
        std::fs::write(dir.join("c.txt"), "c\n").unwrap();

        stage_paths(&fresh(&dir), vec!["a.txt".into(), "b.txt".into(), "c.txt".into()]).unwrap();

        let staged = run_git(&dir, &["diff", "--cached", "--name-status"]).unwrap();
        assert!(staged.contains("M\ta.txt"), "a modified staged: {staged}");
        assert!(staged.contains("D\tb.txt"), "b deletion staged: {staged}");
        assert!(staged.contains("A\tc.txt"), "c addition staged: {staged}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unstage_paths_batches() {
        let dir = tmp("unstagepaths");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        std::fs::write(dir.join("b.txt"), "b\n").unwrap();
        run_git(&dir, &["add", "."]).unwrap();
        run_git(&dir, &["commit", "-m", "init"]).unwrap();
        std::fs::write(dir.join("a.txt"), "a2\n").unwrap();
        std::fs::write(dir.join("b.txt"), "b2\n").unwrap();
        run_git(&dir, &["add", "."]).unwrap(); // stage both

        unstage_paths(&fresh(&dir), vec!["a.txt".into(), "b.txt".into()]).unwrap();

        assert!(
            run_git(&dir, &["diff", "--cached", "--name-only"]).unwrap().trim().is_empty(),
            "nothing left staged"
        );
        let wt = run_git(&dir, &["diff", "--name-only"]).unwrap();
        assert!(wt.contains("a.txt") && wt.contains("b.txt"), "both back in the working tree: {wt}");
        std::fs::remove_dir_all(&dir).ok();
    }

    // Data-loss guard: discarding ONLY untracked paths must never reach
    // checkout_head (an empty pathspec + force would wipe the whole tree), so a
    // tracked file's uncommitted edits must survive untouched.
    #[test]
    fn discard_paths_untracked_only_preserves_tracked_edits() {
        let dir = tmp("discarduntracked");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("tracked.txt"), "v1\n").unwrap();
        run_git(&dir, &["add", "."]).unwrap();
        run_git(&dir, &["commit", "-m", "init"]).unwrap();
        std::fs::write(dir.join("tracked.txt"), "v2\n").unwrap(); // uncommitted edit
        std::fs::write(dir.join("untracked.txt"), "new\n").unwrap();

        discard_paths(&fresh(&dir), vec!["untracked.txt".into()]).unwrap();

        assert!(!dir.join("untracked.txt").exists(), "untracked file discarded");
        assert_eq!(
            std::fs::read_to_string(dir.join("tracked.txt")).unwrap(),
            "v2\n",
            "tracked file's uncommitted edit must survive (no errant checkout_head)"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discard_paths_reverts_tracked_and_deletes_untracked() {
        let dir = tmp("discardmixed");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("a.txt"), "a1\n").unwrap();
        std::fs::write(dir.join("b.txt"), "b1\n").unwrap();
        run_git(&dir, &["add", "."]).unwrap();
        run_git(&dir, &["commit", "-m", "init"]).unwrap();
        std::fs::write(dir.join("a.txt"), "a2\n").unwrap(); // tracked edit
        std::fs::write(dir.join("b.txt"), "b2\n").unwrap(); // tracked edit
        std::fs::write(dir.join("u.txt"), "u\n").unwrap(); // untracked

        discard_paths(&fresh(&dir), vec!["a.txt".into(), "b.txt".into(), "u.txt".into()]).unwrap();

        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "a1\n", "a reverted to HEAD");
        assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "b1\n", "b reverted to HEAD");
        assert!(!dir.join("u.txt").exists(), "untracked file deleted");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discard_with_backup_removes_changes_and_keeps_a_restorable_stash() {
        let dir = tmp("discardbackup");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("a.txt"), "a1\n").unwrap();
        run_git(&dir, &["add", "."]).unwrap();
        run_git(&dir, &["commit", "-m", "init"]).unwrap();
        std::fs::write(dir.join("a.txt"), "a2\n").unwrap(); // tracked edit
        std::fs::write(dir.join("u.txt"), "u\n").unwrap(); // untracked

        let sha = discard_paths_with_backup(&fresh(&dir), vec!["a.txt".into(), "u.txt".into()], "gitchef: test")
            .unwrap()
            .expect("a stash is created");

        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "a1\n", "a reverted");
        assert!(!dir.join("u.txt").exists(), "untracked removed");
        let stashed = run_git(&dir, &["rev-parse", "stash@{0}"]).unwrap();
        assert_eq!(stashed.trim(), sha, "returned sha is the new stash");

        run_git(&dir, &["stash", "pop"]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "a2\n", "edit restored");
        assert_eq!(std::fs::read_to_string(dir.join("u.txt")).unwrap(), "u\n", "untracked restored");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discard_with_backup_falls_back_when_nothing_to_stash() {
        let dir = tmp("discardbackupnone");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("a.txt"), "a1\n").unwrap();
        run_git(&dir, &["add", "."]).unwrap();
        run_git(&dir, &["commit", "-m", "init"]).unwrap();
        let out = discard_paths_with_backup(&fresh(&dir), vec!["a.txt".into()], "gitchef: test").unwrap();
        assert!(out.is_none(), "no stash when the tree is clean");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_with_backup_can_be_restored_and_never_overwrites() {
        let dir = tmp("deletebackup");
        Repository::init(&dir).unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/f.txt"), "keep me\n").unwrap();
        let repo = fresh(&dir);

        let backup = delete_file_with_backup(&repo, "sub/f.txt").unwrap();
        assert!(!dir.join("sub/f.txt").exists(), "file deleted");

        restore_deleted_file(&repo, "sub/f.txt", &backup).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("sub/f.txt")).unwrap(), "keep me\n");

        // a second restore must not clobber the file that is now back
        assert!(restore_deleted_file(&repo, "sub/f.txt", &backup).is_err());
        // and a path outside the trash is rejected
        std::fs::write(dir.join("other.txt"), "x").unwrap();
        std::fs::remove_file(dir.join("sub/f.txt")).unwrap();
        assert!(restore_deleted_file(&repo, "sub/f.txt", dir.join("other.txt").to_str().unwrap()).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_snapshot_restores_a_partial_discard_but_not_over_newer_edits() {
        let dir = tmp("snapshot");
        Repository::init(&dir).unwrap();
        std::fs::write(dir.join("f.txt"), "one\ntwo\n").unwrap();
        let repo = fresh(&dir);

        let bk = snapshot_file(&repo, "f.txt").unwrap();
        std::fs::write(dir.join("f.txt"), "one\n").unwrap(); // the "discard"
        finish_snapshot(&repo, "f.txt", &bk).unwrap();
        restore_file_snapshot(&repo, "f.txt", &bk).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("f.txt")).unwrap(), "one\ntwo\n", "restored");

        // second round: an edit after the discard blocks the restore
        let bk = snapshot_file(&repo, "f.txt").unwrap();
        std::fs::write(dir.join("f.txt"), "one\n").unwrap();
        finish_snapshot(&repo, "f.txt", &bk).unwrap();
        std::fs::write(dir.join("f.txt"), "one\nnew work\n").unwrap();
        assert!(restore_file_snapshot(&repo, "f.txt", &bk).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("f.txt")).unwrap(), "one\nnew work\n", "newer edit kept");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn list_tracked_lists_committed_files_not_untracked() {
        let dir = tmp("lsfiles");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        std::fs::write(dir.join("sub/b.txt"), "y").unwrap();
        run_git(&dir, &["add", "."]).unwrap();
        run_git(&dir, &["commit", "-m", "init"]).unwrap();
        std::fs::write(dir.join("c.txt"), "z").unwrap(); // untracked, must be excluded
        let files = list_tracked(&Repository::open(&dir).unwrap()).unwrap();
        assert!(files.contains(&"a.txt".to_string()));
        assert!(files.contains(&"sub/b.txt".to_string()));
        assert!(!files.iter().any(|f| f == "c.txt"));
    }
}
