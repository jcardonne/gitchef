use crate::error::AppResult;
use git2::{DiffOptions, Repository, Status, StatusOptions};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum RemoteProvider {
    Github,
    Gitlab,
}

#[derive(Serialize)]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub head: Option<String>,
    /// True when the current branch tracks a same-name remote branch. Drives the
    /// toolbar's "Push" vs "Publish" affordance.
    pub has_upstream: bool,
    /// Host of the primary remote (origin, else the first remote), lowercased -
    /// e.g. "github.com", "gitlab.com", "gitlab.example.com". None when the repo
    /// has no remote. Lets the UI build the GitLab avatar-API host.
    pub remote_host: Option<String>,
    /// Provider inferred from `remote_host` so the UI can pick an avatar source;
    /// None for self-hosted / unknown hosts (the UI then falls back to Gravatar).
    pub provider: Option<RemoteProvider>,
}

/// Whether the current branch has an upstream of the *same name* on a remote.
/// No upstream, or one pointing at a differently-named branch, both return false
/// - those are exactly the cases where push must `-u origin HEAD` to publish.
fn same_name_upstream(repo: &Repository) -> bool {
    let head = match repo.head() {
        Ok(h) if h.is_branch() => h,
        _ => return false,
    };
    let name = match head.shorthand() {
        Some(n) => n,
        None => return false,
    };
    repo.find_branch(name, git2::BranchType::Local)
        .ok()
        .and_then(|b| b.upstream().ok())
        .and_then(|u| u.get().name().map(str::to_string))
        .and_then(|full| full.strip_prefix("refs/remotes/").map(str::to_string))
        .and_then(|short| short.split_once('/').map(|(_remote, b)| b.to_string()))
        .map(|up_branch| up_branch == name)
        .unwrap_or(false)
}

/// Serializes to the lowercase variant name, matching the TS `FileStatusKind`
/// union exactly - so adding a variant here forces a matching TS update.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum FileStatusKind {
    New,
    Modified,
    Deleted,
    Renamed,
    Typechange,
    Conflicted,
}

#[derive(Serialize)]
pub struct FileStatus {
    pub path: String,
    pub status: FileStatusKind,
    pub staged: bool,
}

#[derive(Serialize)]
pub struct StatusResult {
    pub staged: Vec<FileStatus>,
    pub unstaged: Vec<FileStatus>,
}

#[derive(Serialize)]
pub struct WorkStats {
    pub files: usize,
    pub insertions: usize,
    pub deletions: usize,
}

/// Line/file stats for everything uncommitted (working tree + index vs HEAD).
/// Drives the "uncommitted changes" node at the top of the graph.
pub fn work_stats(repo: &Repository) -> AppResult<WorkStats> {
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    let diff = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))?;
    let s = diff.stats()?;
    Ok(WorkStats {
        files: s.files_changed(),
        insertions: s.insertions(),
        deletions: s.deletions(),
    })
}

/// Host of a git remote URL, lowercased. Handles the three shapes git remotes
/// take: `scheme://[user@]host[:port]/path`, scp-like `[user@]host:path`, and
/// bare local paths (which have no host).
fn host_from_url(url: &str) -> Option<String> {
    let url = url.trim();
    if let Some((_, rest)) = url.split_once("://") {
        let authority = rest.split('/').next().unwrap_or(rest);
        let host_port = authority.rsplit('@').next().unwrap_or(authority);
        normalize_host(host_port.split(':').next().unwrap_or(host_port))
    } else if let Some((userhost, _)) = url.split_once(':') {
        // scp-like git URL: [user@]host:path. A dotted host or a userinfo '@'
        // tells it apart from a Windows drive path ("C:\\...").
        if !userhost.contains('@') && !userhost.contains('.') {
            return None;
        }
        normalize_host(userhost.rsplit('@').next().unwrap_or(userhost))
    } else {
        None
    }
}

fn normalize_host(host: &str) -> Option<String> {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// Provider for a remote host: github.com -> GitHub; gitlab.com and self-hosted
/// GitLab (host contains "gitlab") -> GitLab; anything else -> None.
fn provider_for(host: &str) -> Option<RemoteProvider> {
    if host == "github.com" || host.ends_with(".github.com") {
        Some(RemoteProvider::Github)
    } else if host.contains("gitlab") {
        Some(RemoteProvider::Gitlab)
    } else {
        None
    }
}

/// URL of `origin`, or the first remote if there is no `origin`.
fn primary_remote_url(repo: &Repository) -> Option<String> {
    if let Ok(remote) = repo.find_remote("origin") {
        if let Some(url) = remote.url() {
            return Some(url.to_string());
        }
    }
    let remotes = repo.remotes().ok()?;
    remotes
        .iter()
        .flatten()
        .find_map(|name| repo.find_remote(name).ok().and_then(|r| r.url().map(str::to_string)))
}

/// A repo's primary remote resolved to the pieces the avatar fetcher needs: the
/// host, the provider, and the project path (`owner/repo` for GitHub,
/// `group/.../project` for GitLab), with any trailing `.git` stripped.
pub(crate) struct RemoteTarget {
    pub host: String,
    pub provider: RemoteProvider,
    pub path: String,
}

/// Project path of a git remote URL - everything after the host, minus a
/// trailing `.git`: both `https://github.com/a/b.git` and `git@github.com:a/b.git`
/// resolve to `a/b`.
fn remote_path_from_url(url: &str) -> Option<String> {
    let url = url.trim().trim_end_matches('/');
    let after = if let Some((_, rest)) = url.split_once("://") {
        &rest[rest.find('/')? + 1..]
    } else if let Some((_, rest)) = url.split_once(':') {
        rest
    } else {
        return None;
    };
    let path = after.trim_start_matches('/').trim_end_matches(".git");
    (!path.is_empty()).then(|| path.to_string())
}

/// Resolve the primary remote (origin, else first) into host + provider + path,
/// or None when there's no remote or the host isn't a known provider.
pub(crate) fn remote_target(repo: &Repository) -> Option<RemoteTarget> {
    let url = primary_remote_url(repo)?;
    let host = host_from_url(&url)?;
    let provider = provider_for(&host)?;
    let path = remote_path_from_url(&url)?;
    Some(RemoteTarget { host, provider, path })
}

pub fn info(repo: &Repository) -> AppResult<RepoInfo> {
    let path = repo
        .workdir()
        .unwrap_or_else(|| repo.path())
        .to_string_lossy()
        .into_owned();
    let name = Path::new(path.trim_end_matches('/'))
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repository".into());
    let head = match repo.head() {
        Ok(h) if h.is_branch() => h.shorthand().map(|s| s.to_string()),
        Ok(h) => h.target().map(super::short_oid),
        Err(_) => None, // unborn branch (fresh repo, no commits yet)
    };
    let has_upstream = same_name_upstream(repo);
    let remote_host = primary_remote_url(repo).as_deref().and_then(host_from_url);
    let provider = remote_host.as_deref().and_then(provider_for);
    Ok(RepoInfo { path, name, head, has_upstream, remote_host, provider })
}

/// Working-tree status split into what's staged (index vs HEAD) and what's not
/// (working dir vs index). A file can appear in both lists if it has staged and
/// unstaged changes - exactly how GitKraken shows it.
pub fn status(repo: &Repository) -> AppResult<StatusResult> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    for entry in statuses.iter() {
        let s = entry.status();
        let path = entry.path().unwrap_or_default().to_string();

        if s.is_conflicted() {
            unstaged.push(FileStatus { path, status: FileStatusKind::Conflicted, staged: false });
            continue;
        }
        if s.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        ) {
            staged.push(FileStatus { path: path.clone(), status: label_status(s, true), staged: true });
        }
        if s.intersects(
            Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE,
        ) {
            unstaged.push(FileStatus { path, status: label_status(s, false), staged: false });
        }
    }
    Ok(StatusResult { staged, unstaged })
}

/// Map a status bitset to a kind, reading either the index (staged) side or the
/// working-tree side depending on `staged`.
fn label_status(s: Status, staged: bool) -> FileStatusKind {
    let (new, deleted, renamed, typechange) = if staged {
        (Status::INDEX_NEW, Status::INDEX_DELETED, Status::INDEX_RENAMED, Status::INDEX_TYPECHANGE)
    } else {
        (Status::WT_NEW, Status::WT_DELETED, Status::WT_RENAMED, Status::WT_TYPECHANGE)
    };
    if s.contains(new) {
        FileStatusKind::New
    } else if s.contains(deleted) {
        FileStatusKind::Deleted
    } else if s.contains(renamed) {
        FileStatusKind::Renamed
    } else if s.contains(typechange) {
        FileStatusKind::Typechange
    } else {
        FileStatusKind::Modified
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_hosts() {
        let cases = [
            ("https://github.com/owner/repo.git", Some("github.com")),
            ("git@github.com:owner/repo.git", Some("github.com")),
            ("ssh://git@gitlab.com/group/sub/repo.git", Some("gitlab.com")),
            ("https://user@gitlab.example.com:8443/g/r.git", Some("gitlab.example.com")),
            ("GIT@GitHub.com:Owner/Repo.git", Some("github.com")),
            ("/Users/me/repo", None),
            ("C:\\src\\repo", None),
        ];
        for (url, want) in cases {
            assert_eq!(host_from_url(url).as_deref(), want, "host_from_url({url})");
        }
    }

    #[test]
    fn detects_provider() {
        assert!(matches!(provider_for("github.com"), Some(RemoteProvider::Github)));
        assert!(matches!(provider_for("ghe.github.com"), Some(RemoteProvider::Github)));
        assert!(matches!(provider_for("gitlab.com"), Some(RemoteProvider::Gitlab)));
        assert!(matches!(provider_for("gitlab.example.com"), Some(RemoteProvider::Gitlab)));
        assert!(provider_for("bitbucket.org").is_none());
        assert!(provider_for("git.sr.ht").is_none());
    }

    #[test]
    fn parses_remote_paths() {
        let cases = [
            ("https://github.com/owner/repo.git", Some("owner/repo")),
            ("git@github.com:owner/repo.git", Some("owner/repo")),
            ("ssh://git@gitlab.com/group/sub/proj.git", Some("group/sub/proj")),
            (
                "git@gitlab.com:atyos/superscooper/superscooper-backend.git",
                Some("atyos/superscooper/superscooper-backend"),
            ),
            ("https://github.com/owner/repo", Some("owner/repo")),
            ("/Users/me/repo", None),
        ];
        for (url, want) in cases {
            assert_eq!(remote_path_from_url(url).as_deref(), want, "remote_path_from_url({url})");
        }
    }
}
