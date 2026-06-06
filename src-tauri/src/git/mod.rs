pub mod branch;
pub mod diff;
pub mod files;
pub mod graph;
pub mod ops;
pub mod repo;

use crate::error::{AppError, AppResult};
use std::path::Path;

/// Working directory of a repo (errors for bare repos).
pub fn workdir(repo: &git2::Repository) -> AppResult<&Path> {
    repo.workdir()
        .ok_or_else(|| AppError::Msg("bare repository has no working directory".into()))
}

/// First 7 hex chars of an object id, for display.
pub fn short_oid(oid: git2::Oid) -> String {
    oid.to_string().chars().take(7).collect()
}

/// Run the system `git` binary inside `dir`. Used for operations where shelling
/// out is more robust than libgit2: network + auth (push/pull/fetch), merge,
/// and checkout (which mutates the working tree with all of git's safety rails).
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
