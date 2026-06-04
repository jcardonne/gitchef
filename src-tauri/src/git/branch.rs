use super::run_git;
use crate::error::{AppError, AppResult};
use git2::{BranchType, Repository};
use serde::Serialize;

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

fn workdir(repo: &Repository) -> AppResult<&std::path::Path> {
    repo.workdir()
        .ok_or_else(|| AppError::Msg("bare repository has no working directory".into()))
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
