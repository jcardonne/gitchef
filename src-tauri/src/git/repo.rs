use crate::error::AppResult;
use git2::{DiffDelta, DiffOptions, Repository, Status, StatusOptions};
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
    /// Provider inferred from the primary remote's host so the UI can pick an
    /// avatar source; None for self-hosted / unknown hosts (the UI then falls
    /// back to Gravatar).
    pub provider: Option<RemoteProvider>,
}

/// Whether the current branch has an upstream of the *same name* on a remote.
/// No upstream, or one pointing at a differently-named branch, both return false
/// - those are exactly the cases where push must `-u origin HEAD` to publish.
pub(crate) fn same_name_upstream(repo: &Repository) -> bool {
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
    /// Pre-rename path when `status` is `renamed` (else `None`). Lets the UI show
    /// "old -> new" and stage/unstage/discard both sides of the rename together.
    pub old_path: Option<String>,
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

/// Build the provider web URL for a `kind` (repo / commit / branch / file) of
/// `target`. GitHub uses `/commit|tree|blob`; GitLab inserts a `/-/` segment.
/// The `reference` (sha or branch) and file `path` are percent-encoded per
/// segment (keeping `/`), so a branch name with `&`/`#`/space can't corrupt the
/// URL or slip a metacharacter into the OS opener.
pub(crate) fn web_url(
    target: &RemoteTarget,
    kind: &str,
    reference: &str,
    path: &str,
) -> AppResult<String> {
    let enc = super::avatars::encode_path;
    // Encode the repo path too (host is DNS-safe): a self-hosted remote path with
    // a metachar mustn't leak into the OS opener. encode_path keeps '/', so
    // nested groups (group/sub/proj) stay intact.
    let base = format!("https://{}/{}", target.host, enc(&target.path));
    let seg = match target.provider {
        RemoteProvider::Github => "",
        RemoteProvider::Gitlab => "/-",
    };
    let url = match kind {
        "repo" => base,
        "commit" => format!("{base}{seg}/commit/{}", enc(reference)),
        "branch" => format!("{base}{seg}/tree/{}", enc(reference)),
        "file" => format!("{base}{seg}/blob/{}/{}", enc(reference), enc(path)),
        other => return Err(crate::error::AppError::Msg(format!("unknown web target: {other}"))),
    };
    Ok(url)
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
    let provider = primary_remote_url(repo)
        .as_deref()
        .and_then(host_from_url)
        .as_deref()
        .and_then(provider_for);
    Ok(RepoInfo { path, name, head, has_upstream, provider })
}

/// Working-tree status split into what's staged (index vs HEAD) and what's not
/// (working dir vs index). A file can appear in both lists if it has staged and
/// unstaged changes - exactly how GitKraken shows it.
pub fn status(repo: &Repository) -> AppResult<StatusResult> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    for entry in statuses.iter() {
        let s = entry.status();
        let path = entry.path().unwrap_or_default().to_string();

        if s.is_conflicted() {
            unstaged.push(FileStatus { path, old_path: None, status: FileStatusKind::Conflicted, staged: false });
            continue;
        }
        if s.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        ) {
            let kind = label_status(s, true);
            let (path, old_path) = side_paths(entry.head_to_index(), kind, &path);
            staged.push(FileStatus { path, old_path, status: kind, staged: true });
        }
        if s.intersects(
            Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE,
        ) {
            let kind = label_status(s, false);
            let (path, old_path) = side_paths(entry.index_to_workdir(), kind, &path);
            unstaged.push(FileStatus { path, old_path, status: kind, staged: false });
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

/// Resolve one status side (staged or unstaged) to (path, rename-source) from
/// THAT side's diff delta. The entry's own `path()` is unreliable for the new
/// name - libgit2 returns the OLD name whenever anything is staged - so read the
/// path from the delta's `new_file` (falling back to `old_file`, then the entry
/// path). `old_path` is set only for an actual rename.
fn side_paths(
    delta: Option<DiffDelta<'_>>,
    kind: FileStatusKind,
    fallback: &str,
) -> (String, Option<String>) {
    let Some(d) = delta else {
        return (fallback.to_string(), None);
    };
    let path = d
        .new_file()
        .path()
        .or_else(|| d.old_file().path())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| fallback.to_string());
    let old_path = matches!(kind, FileStatusKind::Renamed)
        .then(|| d.old_file().path().map(|p| p.to_string_lossy().into_owned()))
        .flatten();
    (path, old_path)
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
    #[test]
    fn builds_provider_web_urls() {
        let gh = RemoteTarget { host: "github.com".into(), provider: RemoteProvider::Github, path: "o/r".into() };
        assert_eq!(web_url(&gh, "repo", "", "").unwrap(), "https://github.com/o/r");
        assert_eq!(web_url(&gh, "commit", "abc123", "").unwrap(), "https://github.com/o/r/commit/abc123");
        assert_eq!(web_url(&gh, "branch", "feat/x", "").unwrap(), "https://github.com/o/r/tree/feat/x");
        // a branch name with a shell/URL metachar is encoded (keeps the slash)
        assert_eq!(web_url(&gh, "branch", "a&b/c", "").unwrap(), "https://github.com/o/r/tree/a%26b/c");
        // file path is percent-encoded (space), the ref is left as-is
        assert_eq!(
            web_url(&gh, "file", "main", "src/a b.rs").unwrap(),
            "https://github.com/o/r/blob/main/src/a%20b.rs"
        );
        // GitLab inserts the /-/ segment before commit/tree/blob
        let gl = RemoteTarget { host: "gitlab.com".into(), provider: RemoteProvider::Gitlab, path: "g/sub/p".into() };
        assert_eq!(web_url(&gl, "commit", "abc", "").unwrap(), "https://gitlab.com/g/sub/p/-/commit/abc");
        // the repo path itself is encoded (nested groups keep their slashes)
        let odd = RemoteTarget { host: "h".into(), provider: RemoteProvider::Github, path: "o/r&x".into() };
        assert_eq!(web_url(&odd, "repo", "", "").unwrap(), "https://h/o/r%26x");
        assert_eq!(web_url(&gl, "file", "main", "x.rs").unwrap(), "https://gitlab.com/g/sub/p/-/blob/main/x.rs");
        assert!(web_url(&gl, "bogus", "", "").is_err());
    }
    #[test]
    fn status_detects_staged_and_unstaged_renames() {
        let dir = std::env::temp_dir().join(format!(
            "gitchef-renstat-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| crate::git::run_git(&dir, args).unwrap();
        Repository::init(&dir).unwrap();
        git(&["config", "user.email", "t@t.t"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(dir.join("old.txt"), "alpha\nbeta\ngamma\ndelta\n").unwrap();
        git(&["add", "old.txt"]);
        git(&["commit", "-m", "init"]);

        // Unstaged rename: move on disk only; the new path is untracked.
        std::fs::rename(dir.join("old.txt"), dir.join("new.txt")).unwrap();
        let st = status(&Repository::open(&dir).unwrap()).unwrap();
        let r = st
            .unstaged
            .iter()
            .find(|f| matches!(f.status, FileStatusKind::Renamed))
            .expect("unstaged rename detected");
        assert_eq!(r.path, "new.txt");
        assert_eq!(r.old_path.as_deref(), Some("old.txt"));

        // Stage it -> the rename moves to the staged side.
        git(&["add", "-A"]);
        let st = status(&Repository::open(&dir).unwrap()).unwrap();
        let r = st
            .staged
            .iter()
            .find(|f| matches!(f.status, FileStatusKind::Renamed))
            .expect("staged rename detected");
        assert_eq!(r.path, "new.txt");
        assert_eq!(r.old_path.as_deref(), Some("old.txt"));

        // Rename staged, then edit the new file: the unstaged row must point at
        // the NEW path (libgit2's entry.path() returns the old name once
        // anything is staged), not resurrect the old one.
        std::fs::write(dir.join("new.txt"), "alpha\nBETA\ngamma\ndelta\n").unwrap();
        let st = status(&Repository::open(&dir).unwrap()).unwrap();
        let m = st
            .unstaged
            .iter()
            .find(|f| matches!(f.status, FileStatusKind::Modified))
            .expect("unstaged modify detected");
        assert_eq!(m.path, "new.txt", "modify must point at the new name");
        assert_eq!(m.old_path, None);

        std::fs::remove_dir_all(&dir).ok();
    }

}
