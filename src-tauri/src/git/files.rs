use super::{ops, run_git, workdir};
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

pub fn stash_file(repo: &Repository, path: &str) -> AppResult<String> {
    run_git(workdir(repo)?, &["stash", "push", "--", path])
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
