use super::{run_git, workdir};
use crate::error::{AppError, AppResult};
use git2::{build::CheckoutBuilder, BranchType, ObjectType, Repository};
use std::path::Path;

/// Stage one path. Handles deletions (path gone from disk -> remove from index).
pub fn stage(repo: &Repository, path: &str) -> AppResult<()> {
    let mut index = repo.index()?;
    if workdir(repo)?.join(path).exists() {
        index.add_path(Path::new(path))?;
    } else {
        index.remove_path(Path::new(path))?;
    }
    index.write()?;
    Ok(())
}

/// Unstage one path by resetting its index entry back to HEAD.
pub fn unstage(repo: &Repository, path: &str) -> AppResult<()> {
    match repo.head().ok().and_then(|h| h.peel(ObjectType::Commit).ok()) {
        Some(head) => repo.reset_default(Some(&head), [path])?,
        None => {
            // No commits yet: nothing in HEAD to reset to, just drop from index.
            let mut index = repo.index()?;
            index.remove_path(Path::new(path))?;
            index.write()?;
        }
    }
    Ok(())
}

/// Discard working-tree changes for a path. Tracked files are force-checked-out
/// from HEAD; untracked (new) files aren't in HEAD - the only way to discard
/// them is to delete them from disk.
pub fn discard(repo: &Repository, path: &str) -> AppResult<()> {
    if is_tracked(repo, path) {
        let mut cob = CheckoutBuilder::new();
        cob.path(path).force();
        repo.checkout_head(Some(&mut cob))?;
    } else {
        let full = workdir(repo)?.join(path);
        if full.exists() {
            std::fs::remove_file(full)?;
        }
    }
    Ok(())
}

/// Whether `path` exists in the HEAD tree (i.e. it's a tracked file).
fn is_tracked(repo: &Repository, path: &str) -> bool {
    repo.head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok())
        .map(|t| t.get_path(Path::new(path)).is_ok())
        .unwrap_or(false)
}

pub fn commit(repo: &Repository, message: &str) -> AppResult<String> {
    if message.trim().is_empty() {
        return Err(AppError::Msg("commit message is empty".into()));
    }
    let mut index = repo.index()?;
    let tree = repo.find_tree(index.write_tree()?)?;
    let sig = repo
        .signature()
        .map_err(|_| AppError::Msg("set git user.name and user.email before committing".into()))?;
    let parents: Vec<git2::Commit> =
        match repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
            Some(c) => vec![c],
            None => vec![],
        };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)?;
    Ok(oid.to_string())
}

// Network + merge operations go through the git CLI (credentials, hooks, refs).

/// Push the current branch. On its first push (no upstream tracking ref yet)
/// fall back to `push -u origin <branch>` so the branch gets published instead
/// of git erroring with "has no upstream branch".
pub fn push(repo: &Repository) -> AppResult<String> {
    let dir = workdir(repo)?;
    let head = repo.head()?;
    if !head.is_branch() {
        return run_git(dir, &["push"]); // detached HEAD: let git decide
    }
    let branch_name = head.shorthand().unwrap_or("HEAD").to_string();
    let has_upstream = repo
        .find_branch(&branch_name, BranchType::Local)
        .ok()
        .and_then(|b| b.upstream().ok())
        .is_some();
    if has_upstream {
        run_git(dir, &["push"])
    } else {
        run_git(dir, &["push", "-u", "origin", &branch_name])
    }
}
pub fn pull(repo: &Repository, mode: &str) -> AppResult<String> {
    let arg = match mode {
        "ff-only" => "--ff-only",
        "rebase" => "--rebase",
        _ => "--ff",
    };
    run_git(workdir(repo)?, &["pull", arg])
}
pub fn fetch(repo: &Repository) -> AppResult<String> {
    run_git(workdir(repo)?, &["fetch", "--all", "--prune"])
}
pub fn merge(repo: &Repository, branch: &str) -> AppResult<String> {
    run_git(workdir(repo)?, &["merge", branch])
}

// --- commit-centric operations (via git CLI for conflict/working-tree safety) ---

pub fn cherry_pick(repo: &Repository, sha: &str) -> AppResult<String> {
    run_git(workdir(repo)?, &["cherry-pick", sha])
}

pub fn revert_commit(repo: &Repository, sha: &str) -> AppResult<String> {
    run_git(workdir(repo)?, &["revert", "--no-edit", sha])
}

pub fn reset_to(repo: &Repository, sha: &str, mode: &str) -> AppResult<String> {
    let flag = match mode {
        "soft" => "--soft",
        "hard" => "--hard",
        _ => "--mixed",
    };
    run_git(workdir(repo)?, &["reset", flag, sha])
}

/// Write the commit as a mailbox patch (`git format-patch -1`) to `dest`.
pub fn save_commit_patch(repo: &Repository, sha: &str, dest: &str) -> AppResult<()> {
    let patch = run_git(workdir(repo)?, &["format-patch", "-1", "--stdout", sha])?;
    std::fs::write(dest, patch)?;
    Ok(())
}
