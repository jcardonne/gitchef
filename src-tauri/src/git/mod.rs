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
pub mod search;
pub mod sequencer;
pub mod submodule;
pub mod worktree;

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::Path;

#[derive(Clone, Serialize)]
pub struct GitOutputEvent {
    pub repo: String,
    pub stream: String,
    pub text: String,
}

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
/// Errs on a non-zero exit. Two sites build their own Command instead: the
/// sequencer (`sequencer::run_step`) needs env vars AND pause-tolerant exit
/// handling, and `search::content` reads `git grep`'s exit-1 (no matches).
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

/// Run a user-visible Git operation and emit stdout/stderr as lines while it runs.
/// This keeps hook diagnostics visible instead of reducing them to a final toast.
pub fn run_git_stream(
    app: &tauri::AppHandle,
    dir: &Path,
    args: &[&str],
) -> AppResult<String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use tauri::Emitter;

    let mut child = Command::new("git")
        .current_dir(dir)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::Msg("failed to open git stdout".into()))?;
    let stderr = child.stderr.take().ok_or_else(|| AppError::Msg("failed to open git stderr".into()))?;
    let repo = dir.to_string_lossy().into_owned();
    let (tx, rx) = mpsc::channel::<(&'static str, String)>();
    fn forward<R: std::io::Read + Send + 'static>(
        stream: &'static str,
        reader: R,
        tx: mpsc::Sender<(&'static str, String)>,
    ) {
        std::thread::spawn(move || {
            for line in BufReader::new(reader).lines() {
                match line {
                    Ok(text) => { let _ = tx.send((stream, format!("{text}\n"))); }
                    Err(_) => break,
                }
            }
        });
    }
    forward("stdout", stdout, tx.clone());
    forward("stderr", stderr, tx.clone());
    drop(tx);
    let mut output = String::new();
    let mut stderr_output = String::new();
    for (stream, text) in rx {
        output.push_str(&text);
        if stream == "stderr" {
            stderr_output.push_str(&text);
        }
        let _ = app.emit("git-output", GitOutputEvent {
            repo: repo.clone(),
            stream: stream.to_string(),
            text,
        });
    }
    let status = child.wait()?;
    if status.success() {
        Ok(output)
    } else {
        let detail = if stderr_output.trim().is_empty() { output.trim() } else { stderr_output.trim() };
        Err(AppError::Msg(format!("git {}: {detail}", args.join(" "))))
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
