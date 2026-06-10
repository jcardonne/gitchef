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

pub fn rename_branch(repo: &Repository, old_name: &str, new_name: &str) -> AppResult<String> {
    run_git(workdir(repo)?, &["branch", "-m", old_name, new_name])
}

pub fn delete_branch(repo: &Repository, name: &str, is_remote: bool, force: bool) -> AppResult<String> {
    // Remote-tracking refs delete unconditionally (-r); for a local branch -d
    // refuses unmerged work unless the caller forces it with -D.
    let flag = if is_remote {
        "-dr"
    } else if force {
        "-D"
    } else {
        "-d"
    };
    run_git(workdir(repo)?, &["branch", flag, name])
}

pub fn set_upstream(repo: &Repository, local: &str, upstream: &str) -> AppResult<String> {
    run_git(workdir(repo)?, &["branch", "--set-upstream-to", upstream, local])
}

/// Create a tag (lightweight or annotated) at a specific commit.
pub fn create_tag_at(
    repo: &Repository,
    name: &str,
    sha: &str,
    annotated: bool,
    message: Option<String>,
) -> AppResult<()> {
    // revparse_single resolves a sha OR a refname like "HEAD"; peel to the commit.
    let obj = repo.revparse_single(sha)?.peel(git2::ObjectType::Commit)?;
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

/// Delete a local tag. Lightweight + annotated tags both go through `tag -d`.
pub fn delete_tag(repo: &Repository, name: &str) -> AppResult<String> {
    run_git(workdir(repo)?, &["tag", "-d", name])
}

#[cfg(test)]
mod tests {
    use super::{create_branch_at, create_tag_at, delete_branch, delete_tag, rename_branch, set_upstream};
    use crate::git::run_git;
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

    fn init(dir: &Path) -> Repository {
        let repo = Repository::init(dir).unwrap();
        run_git(dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("f.txt"), "base\n").unwrap();
        run_git(dir, &["add", "f.txt"]).unwrap();
        run_git(dir, &["commit", "-m", "init"]).unwrap();
        repo
    }

    fn head_sha(dir: &Path) -> String {
        run_git(dir, &["rev-parse", "HEAD"]).unwrap().trim().to_string()
    }

    #[test]
    fn delete_tag_removes_lightweight_and_annotated() {
        let dir = tmp("deltag");
        let repo = Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("f.txt"), "a\n").unwrap();
        run_git(&dir, &["add", "f.txt"]).unwrap();
        run_git(&dir, &["commit", "-m", "init"]).unwrap();
        let sha = run_git(&dir, &["rev-parse", "HEAD"]).unwrap().trim().to_string();

        create_tag_at(&repo, "v1", &sha, false, None).unwrap();
        create_tag_at(&repo, "v2", &sha, true, Some("annotated".into())).unwrap();
        let listed = run_git(&dir, &["tag", "-l"]).unwrap();
        assert!(listed.contains("v1") && listed.contains("v2"), "tags created: {listed}");

        delete_tag(&Repository::open(&dir).unwrap(), "v1").unwrap();
        delete_tag(&Repository::open(&dir).unwrap(), "v2").unwrap();
        assert!(run_git(&dir, &["tag", "-l"]).unwrap().trim().is_empty(), "both tags removed");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn create_branch_at_optionally_checks_out() {
        let dir = tmp("createbr");
        let repo = init(&dir);
        let head = head_sha(&dir);
        create_branch_at(&repo, "feature", &head, false).unwrap();
        assert!(run_git(&dir, &["branch", "--list", "feature"]).unwrap().contains("feature"));
        assert_ne!(run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim(), "feature");

        create_branch_at(&Repository::open(&dir).unwrap(), "feature2", &head, true).unwrap();
        assert_eq!(run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim(), "feature2");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rename_branch_replaces_the_old_name() {
        let dir = tmp("renamebr");
        let repo = init(&dir);
        create_branch_at(&repo, "old", &head_sha(&dir), false).unwrap();
        rename_branch(&Repository::open(&dir).unwrap(), "old", "new").unwrap();
        let list = run_git(&dir, &["branch", "--list"]).unwrap();
        assert!(list.contains("new") && !list.contains("old"), "{list}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_branch_refuses_unmerged_then_forces() {
        let dir = tmp("delbr");
        let repo = init(&dir);
        create_branch_at(&repo, "feature", &head_sha(&dir), true).unwrap();
        std::fs::write(dir.join("f.txt"), "base\nunmerged\n").unwrap();
        run_git(&dir, &["commit", "-am", "unmerged work"]).unwrap();
        run_git(&dir, &["checkout", "-"]).unwrap(); // back to the default branch

        // `-d` refuses an unmerged branch; `-D` (force) deletes it.
        assert!(delete_branch(&Repository::open(&dir).unwrap(), "feature", false, false).is_err());
        delete_branch(&Repository::open(&dir).unwrap(), "feature", false, true).unwrap();
        assert!(!run_git(&dir, &["branch", "--list", "feature"]).unwrap().contains("feature"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn set_upstream_links_a_tracking_ref() {
        let dir = tmp("upstream");
        let repo = init(&dir);
        create_branch_at(&repo, "feature", &head_sha(&dir), false).unwrap();
        let cur = run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim().to_string();
        set_upstream(&Repository::open(&dir).unwrap(), &cur, "feature").unwrap();
        let up = run_git(&dir, &["rev-parse", "--abbrev-ref", &format!("{cur}@{{upstream}}")]).unwrap();
        assert_eq!(up.trim(), "feature");
        std::fs::remove_dir_all(&dir).ok();
    }
}
