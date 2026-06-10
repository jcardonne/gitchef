use super::{ops, run_git, run_git_stdin, workdir};
use crate::error::{AppError, AppResult};
use git2::Repository;
use std::io::Write;
use std::process::{Command, Stdio};

/// Absolute path of a repo-relative file.
fn abs(repo: &Repository, rel: &str) -> AppResult<String> {
    Ok(workdir(repo)?.join(rel).to_string_lossy().into_owned())
}

// --- bulk staging (multi-select) ---

pub fn stage_paths(repo: &Repository, paths: Vec<String>) -> AppResult<()> {
    paths.iter().try_for_each(|p| ops::stage(repo, p))
}

pub fn unstage_paths(repo: &Repository, paths: Vec<String>) -> AppResult<()> {
    paths.iter().try_for_each(|p| ops::unstage(repo, p))
}

pub fn discard_paths(repo: &Repository, paths: Vec<String>) -> AppResult<()> {
    paths.iter().try_for_each(|p| ops::discard(repo, p))
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

/// Stage, unstage, or discard a single hunk. Rather than reconstruct a patch
/// (fragile around "\ No newline" markers), carve the matching hunk out of git's
/// own `git diff` output and pipe it back through `git apply`:
///   stage   - worktree-vs-index diff, applied to the index
///   unstage - index-vs-HEAD diff, reverse-applied to the index
///   discard - worktree-vs-index diff, reverse-applied to the working tree
pub fn apply_hunk(repo: &Repository, path: &str, action: &str, hunk_header: &str) -> AppResult<()> {
    let dir = workdir(repo)?;
    let (diff_args, apply_args): (&[&str], &[&str]) = match action {
        "stage" => (&["diff", "--", path], &["apply", "--cached"]),
        "unstage" => (&["diff", "--cached", "--", path], &["apply", "--cached", "--reverse"]),
        "discard" => (&["diff", "--", path], &["apply", "--reverse"]),
        other => return Err(AppError::Msg(format!("unknown hunk action: {other}"))),
    };
    let target = hunk_key(hunk_header).ok_or_else(|| AppError::Msg("malformed hunk header".into()))?;
    let patch = run_git(dir, diff_args)?;
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
    let (diff_args, apply_args): (&[&str], &[&str]) = match action {
        "stage" => (&["diff", "--", path], &["apply", "--cached", "--recount"]),
        "unstage" => (
            &["diff", "--cached", "--", path],
            &["apply", "--cached", "--reverse", "--recount"],
        ),
        "discard" => (&["diff", "--", path], &["apply", "--reverse", "--recount"]),
        other => return Err(AppError::Msg(format!("unknown line action: {other}"))),
    };
    let target = hunk_key(hunk_header).ok_or_else(|| AppError::Msg("malformed hunk header".into()))?;
    let patch = run_git(dir, diff_args)?;
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
    run_git(workdir(repo)?, &["stash", "push", "--include-untracked", "--", path])
}

/// Write a unified diff for one file (staged + unstaged vs HEAD) to `dest`.
pub fn save_patch(repo: &Repository, path: &str, dest: &str) -> AppResult<()> {
    let patch = run_git(workdir(repo)?, &["diff", "HEAD", "--", path])?;
    std::fs::write(dest, patch)?;
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
    #[cfg(target_os = "macos")]
    Command::new("open").arg("-R").arg(&target).spawn()?;
    #[cfg(target_os = "windows")]
    Command::new("explorer").arg(format!("/select,{target}")).spawn()?;
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = std::path::Path::new(&target)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from(&target));
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

/// Open a file with the OS default application.
pub fn open_default(repo: &Repository, path: &str) -> AppResult<()> {
    let target = abs(repo, path)?;
    #[cfg(target_os = "macos")]
    Command::new("open").arg(&target).spawn()?;
    #[cfg(target_os = "windows")]
    Command::new("cmd").args(["/C", "start", ""]).arg(&target).spawn()?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open").arg(&target).spawn()?;
    Ok(())
}

/// Open the file in the user's configured editor (git core.editor, else $VISUAL
/// / $EDITOR). Spawned detached so GUI editors don't block the app.
pub fn open_in_editor(repo: &Repository, path: &str) -> AppResult<()> {
    let dir = workdir(repo)?;
    let editor = run_git(dir, &["config", "core.editor"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("VISUAL").ok())
        .or_else(|| std::env::var("EDITOR").ok())
        .ok_or_else(|| {
            AppError::Msg("no editor configured (set git core.editor or $EDITOR)".into())
        })?;
    // Split "code --wait" into program + args and pass the file as a separate
    // arg - never interpolate the path into a shell string (injection).
    let mut parts = editor.split_whitespace();
    let program = parts
        .next()
        .ok_or_else(|| AppError::Msg("empty editor configuration".into()))?;
    Command::new(program)
        .args(parts)
        .arg(abs(repo, path)?)
        .current_dir(dir)
        .spawn()?;
    Ok(())
}

pub fn open_difftool(repo: &Repository, path: &str) -> AppResult<()> {
    Command::new("git")
        .current_dir(workdir(repo)?)
        .args(["difftool", "--no-prompt", "--", path])
        .spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{apply_hunk, apply_lines, stash_file};
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
}
