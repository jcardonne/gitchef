use super::{run_git, workdir};
use crate::error::{AppError, AppResult};
use git2::{BranchType, Oid, Repository};
use serde::Serialize;

#[derive(Serialize)]
pub struct TagInfo {
    pub name: String,
    /// SHA of the commit the tag ultimately points at (annotated tags peeled).
    pub target: String,
}

#[derive(Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub target: Option<String>,
}

pub fn list_branches(repo: &Repository) -> AppResult<Vec<BranchInfo>> {
    let mut out = Vec::new();
    for item in repo.branches(None)? {
        let (branch, btype) = item?;
        let name = branch.name()?.unwrap_or_default().to_string();
        if name.is_empty() {
            continue;
        }
        let target = branch.get().target().map(|o| o.to_string());
        let mut upstream = None;
        let (mut ahead, mut behind) = (0, 0);
        if btype == BranchType::Local {
            if let Ok(up) = branch.upstream() {
                upstream = up.name().ok().flatten().map(|s| s.to_string());
                if let (Some(local), Some(remote)) =
                    (branch.get().target(), up.get().target())
                {
                    if let Ok((a, b)) = repo.graph_ahead_behind(local, remote) {
                        ahead = a;
                        behind = b;
                    }
                }
            }
        }
        out.push(BranchInfo {
            name,
            is_head: branch.is_head(),
            is_remote: btype == BranchType::Remote,
            upstream,
            ahead,
            behind,
            target,
        });
    }
    Ok(out)
}

pub fn list_tags(repo: &Repository) -> AppResult<Vec<TagInfo>> {
    let mut out = Vec::new();
    for name in repo.tag_names(None)?.iter().flatten() {
        if let Ok(obj) = repo.revparse_single(&format!("refs/tags/{name}")) {
            // Lightweight tags resolve straight to a commit; annotated tags peel.
            let target = obj
                .peel(git2::ObjectType::Commit)
                .ok()
                .and_then(|o| o.into_commit().ok())
                .map(|c| c.id())
                .unwrap_or_else(|| obj.id());
            out.push(TagInfo { name: name.to_string(), target: target.to_string() });
        }
    }
    Ok(out)
}

/// Switch branches via the git CLI so all of git's working-tree safety checks
/// (dirty tree, conflicts) apply rather than us reimplementing them.
pub fn checkout(repo: &Repository, name: &str) -> AppResult<()> {
    run_git(workdir(repo)?, &["checkout", name])?;
    Ok(())
}

pub fn create_branch(repo: &Repository, name: &str, checkout_it: bool) -> AppResult<()> {
    let head = repo.head()?.peel_to_commit()?;
    repo.branch(name, &head, false)?;
    if checkout_it {
        run_git(workdir(repo)?, &["checkout", name])?;
    }
    Ok(())
}

fn parse_oid(sha: &str) -> AppResult<Oid> {
    Oid::from_str(sha).map_err(|e| AppError::Msg(format!("invalid commit id: {e}")))
}

/// Create a branch at a specific commit, optionally checking it out.
pub fn create_branch_at(
    repo: &Repository,
    name: &str,
    sha: &str,
    checkout_it: bool,
) -> AppResult<()> {
    let commit = repo.find_commit(parse_oid(sha)?)?;
    repo.branch(name, &commit, false)?;
    if checkout_it {
        run_git(workdir(repo)?, &["checkout", name])?;
    }
    Ok(())
}

/// Create a tag (lightweight or annotated) at a specific commit.
pub fn create_tag_at(
    repo: &Repository,
    name: &str,
    sha: &str,
    annotated: bool,
    message: Option<String>,
) -> AppResult<()> {
    let obj = repo.find_object(parse_oid(sha)?, None)?;
    if annotated {
        let sig = repo
            .signature()
            .map_err(|_| AppError::Msg("set git user.name and user.email first".into()))?;
        repo.tag(name, &obj, &sig, message.as_deref().unwrap_or(name), false)?;
    } else {
        repo.tag_lightweight(name, &obj, false)?;
    }
    Ok(())
}
