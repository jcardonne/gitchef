use super::run_git;
use crate::error::{AppError, AppResult};
use git2::{build::CheckoutBuilder, IndexAddOption, ObjectType, Repository};
use std::path::Path;

fn workdir(repo: &Repository) -> AppResult<&Path> {
    repo.workdir()
        .ok_or_else(|| AppError::Msg("bare repository has no working directory".into()))
}

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

pub fn stage_all(repo: &Repository) -> AppResult<()> {
    let mut index = repo.index()?;
    index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None)?; // new + modified
    index.update_all(["*"].iter(), None)?; // picks up deletions of tracked files
    index.write()?;
    Ok(())
}

pub fn unstage_all(repo: &Repository) -> AppResult<()> {
    if let Some(head) = repo.head().ok().and_then(|h| h.peel(ObjectType::Commit).ok()) {
        repo.reset_default(Some(&head), ["*"])?;
    }
    Ok(())
}

/// Discard working-tree changes for a tracked path (force checkout from HEAD).
pub fn discard(repo: &Repository, path: &str) -> AppResult<()> {
    let mut cob = CheckoutBuilder::new();
    cob.path(path).force();
    repo.checkout_head(Some(&mut cob))?;
    Ok(())
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
            None => vec![], // first commit in the repo
        };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)?;
    Ok(oid.to_string())
}

// Network + merge operations go through the git CLI (credentials, hooks, refs).
pub fn push(repo: &Repository) -> AppResult<String> {
    run_git(workdir(repo)?, &["push"])
}
pub fn pull(repo: &Repository) -> AppResult<String> {
    run_git(workdir(repo)?, &["pull", "--ff-only"])
}
pub fn fetch(repo: &Repository) -> AppResult<String> {
    run_git(workdir(repo)?, &["fetch", "--all", "--prune"])
}
pub fn merge(repo: &Repository, branch: &str) -> AppResult<String> {
    run_git(workdir(repo)?, &["merge", branch])
}
