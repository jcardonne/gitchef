pub mod avatars;
pub mod branch;
pub mod conflict;
pub mod diff;
pub mod files;
pub mod forge;
pub mod graph;
pub mod history;
pub mod ops;
pub mod remotes;
pub mod rebase;
pub mod repo;
pub mod sequencer;
pub mod submodule;
pub mod worktree;

use crate::error::{AppError, AppResult};
use std::path::Path;

/// Working directory of a repo (errors for bare repos).
pub fn workdir(repo: &git2::Repository) -> AppResult<&Path> {
    repo.workdir()
        .ok_or_else(|| AppError::Msg("bare repository has no working directory".into()))
}

/// Wrap a repo-relative path so git treats it as a literal filename, not a
/// pathspec pattern. Everything after `--` is a PATHSPEC: a real file named
/// `foo[1].txt` or `report(*).md` otherwise also matches its neighbours, so
/// `checkout --ours -- <path>` overwrites them, `stash push -- <path>` stashes
/// them away, and a diff returns the wrong file's patch. Use this at every site
/// that passes a user-supplied path to the git CLI.
pub fn literal(path: &str) -> String {
    format!(":(literal){path}")
}

/// First 7 hex chars of an object id, for display.
pub fn short_oid(oid: git2::Oid) -> String {
    oid.to_string().chars().take(7).collect()
}

/// Run the system `git` binary inside `dir`. Used for operations where shelling
/// out is more robust than libgit2: network + auth (push/pull/fetch), merge,
/// and checkout (which mutates the working tree with all of git's safety rails).
/// Errs on a non-zero exit. The sequencer (`sequencer::run_step`) builds its own
/// Command instead because it needs env vars AND pause-tolerant exit handling.
pub fn run_git(dir: &Path, args: &[&str]) -> AppResult<String> {
    let out = std::process::Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = if err.trim().is_empty() {
            String::from_utf8_lossy(&out.stdout).into_owned()
        } else {
            err.into_owned()
        };
        Err(AppError::Msg(format!("git {}: {}", args.join(" "), msg.trim())))
    }
}

/// Like `run_git`, but pipes `input` into the command's stdin - used for
/// `git apply` (hunk staging) where the patch is fed on stdin.
pub fn run_git_stdin(dir: &Path, args: &[&str], input: &str) -> AppResult<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new("git")
        .current_dir(dir)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    // Write the patch, then close stdin so git sees EOF. Capture the write result
    // but always reap the child first: a broken pipe must not leave a zombie or
    // mask git's own error. Hunk patches are small (well under the pipe buffer),
    // so writing before reading output won't deadlock.
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Msg("failed to open git stdin".into()))?;
    let write_res = stdin.write_all(input.as_bytes());
    drop(stdin);
    let out = child.wait_with_output()?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = if err.trim().is_empty() {
            String::from_utf8_lossy(&out.stdout).into_owned()
        } else {
            err.into_owned()
        };
        return Err(AppError::Msg(format!("git {}: {}", args.join(" "), msg.trim())));
    }
    write_res?; // process succeeded - surface a write error only now
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}
