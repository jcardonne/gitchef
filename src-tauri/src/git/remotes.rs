use crate::error::AppResult;
use git2::Repository;
use serde::Serialize;

#[derive(Serialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

/// List every named remote with its fetch URL.
pub fn list(repo: &Repository) -> AppResult<Vec<RemoteInfo>> {
    let names = repo.remotes()?;
    let mut out = Vec::new();
    for name in names.iter().flatten() {
        let remote = repo.find_remote(name)?;
        out.push(RemoteInfo {
            name: name.to_string(),
            url: remote.url().unwrap_or_default().to_string(),
        });
    }
    Ok(out)
}

/// Add a remote (installs the default fetch refspec). Config-only, no transport.
pub fn add(repo: &Repository, name: &str, url: &str) -> AppResult<()> {
    repo.remote(name, url)?;
    Ok(())
}

/// Remove a remote and its config.
pub fn remove(repo: &Repository, name: &str) -> AppResult<()> {
    repo.remote_delete(name)?;
    Ok(())
}

/// Rename a remote. The returned `StringArray` of non-default refspecs libgit2
/// could not move is intentionally ignored.
pub fn rename(repo: &Repository, old: &str, new: &str) -> AppResult<()> {
    repo.remote_rename(old, new)?;
    Ok(())
}

/// Set a remote's fetch URL.
pub fn set_url(repo: &Repository, name: &str, url: &str) -> AppResult<()> {
    repo.remote_set_url(name, url)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{add, list, remove, rename, set_url};
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

    #[test]
    fn add_rename_set_url_remove_roundtrip() {
        let dir = tmp("remotes");
        let repo = init(&dir);

        add(&repo, "up", "https://example.com/x.git").unwrap();
        let remotes = list(&repo).unwrap();
        assert!(remotes.iter().any(|r| r.name == "up" && r.url == "https://example.com/x.git"));

        rename(&repo, "up", "upstream").unwrap();
        assert!(list(&repo).unwrap().iter().any(|r| r.name == "upstream"));
        assert!(!list(&repo).unwrap().iter().any(|r| r.name == "up"));

        set_url(&repo, "upstream", "https://example.com/y.git").unwrap();
        assert!(list(&repo)
            .unwrap()
            .iter()
            .any(|r| r.name == "upstream" && r.url == "https://example.com/y.git"));

        remove(&repo, "upstream").unwrap();
        assert!(list(&repo).unwrap().is_empty());
    }
}
