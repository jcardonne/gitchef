//! Provider account avatars for commit authors.
//!
//! Email -> avatar can't be derived for committers who use a real (non-no-reply)
//! email: only the hosting provider knows which account an email belongs to. We
//! recover the mapping from the per-repo *commits* API, which links each commit
//! to its account server-side (so it works even for private commit emails):
//!   - GitHub: REST `/repos/{owner}/{repo}/commits` -> `author.avatar_url`.
//!   - GitLab: GraphQL `project.repository.commits` -> `author { avatarUrl }`
//!     (the REST commits list carries no avatar).
//!
//! Results are cached on disk with a long TTL and filled incrementally, so the
//! 60/hr unauthenticated GitHub budget is plenty; tokens (auto-read from the
//! user's `gh`/`glab` CLI or env) lift the ceiling and unlock private repos.

use crate::error::{AppError, AppResult};
use crate::git::repo::{self, RemoteProvider, RemoteTarget};
use git2::Repository;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/// The avatar disc in the graph is small; 64px covers retina.
const AVATAR_SIZE: u32 = 64;
/// A resolved provider avatar is stable, so keep it for a month.
const TTL_SECS: u64 = 30 * 24 * 60 * 60;
/// A *miss* (email with no provider account) is re-checked the next day rather
/// than refetched on every repo open.
const NEG_TTL_SECS: u64 = 24 * 60 * 60;
/// Safety cap on API pagination: 12 * 100 = up to 1200 commits scanned per call.
const MAX_PAGES: usize = 12;

#[derive(Serialize, Deserialize, Clone)]
struct CacheEntry {
    /// Empty string = negative entry (tried, no provider avatar for this email).
    url: String,
    fetched_at: u64,
}

struct CacheState {
    map: HashMap<String, CacheEntry>,
    /// Path the in-memory map was loaded from, so disk is read once per file.
    loaded_from: Option<PathBuf>,
}

/// Process-wide so concurrent tab commands don't race the read-modify-write.
static CACHE: LazyLock<Mutex<CacheState>> =
    LazyLock::new(|| Mutex::new(CacheState { map: HashMap::new(), loaded_from: None }));

/// Resolve GitHub/GitLab account avatars for `emails`, keyed by lowercased email.
/// Returns only emails that map to a real provider account; the frontend falls
/// back to no-reply derivation / Gravatar for the rest. Never hard-errors on a
/// flaky network or a private repo without a token - it degrades to the cache.
pub fn resolve(
    app: &AppHandle,
    repo_path: &str,
    emails: Vec<String>,
) -> AppResult<HashMap<String, String>> {
    let wanted: HashSet<String> = emails
        .into_iter()
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty())
        .collect();
    if wanted.is_empty() {
        return Ok(HashMap::new());
    }

    let path = cache_path(app)?;
    let now = now_secs();
    let mut out: HashMap<String, String> = HashMap::new();
    let mut missing: HashSet<String> = HashSet::new();

    // Fast path: serve fresh cache entries, collect the rest as misses.
    {
        let mut st = CACHE.lock();
        if st.loaded_from.as_deref() != Some(path.as_path()) {
            st.map = load_cache(&path);
            st.loaded_from = Some(path.clone());
        }
        for email in wanted {
            match st.map.get(&email) {
                Some(e) if fresh(e, now) => {
                    if !e.url.is_empty() {
                        out.insert(email, e.url.clone());
                    }
                }
                _ => {
                    missing.insert(email);
                }
            }
        }
    }
    if missing.is_empty() {
        return Ok(out);
    }

    // Need the remote to know which API to hit; no remote / unknown host means
    // there's nothing to fetch, so return whatever the cache had.
    let repo = match Repository::open(repo_path) {
        Ok(r) => r,
        Err(_) => return Ok(out),
    };
    let target = match repo::remote_target(&repo) {
        Some(t) => t,
        None => return Ok(out),
    };
    let head = repo.head().ok().and_then(|h| h.shorthand().map(str::to_string));

    let fetched = match target.provider {
        RemoteProvider::Github => fetch_github(&target, head.as_deref(), &missing),
        RemoteProvider::Gitlab => fetch_gitlab(&target, head.as_deref(), &missing),
    };

    // Only write the cache when the fetch completed: on a transient error keep
    // the cached positives and retry next time (don't poison with negatives).
    if let Ok((found, backoff)) = fetched {
        if let Some(secs) = backoff {
            // Header-exact: tell the UI precisely how long to pause background fetch.
            let _ = app.emit("rate-limited", secs);
        }
        let mut st = CACHE.lock();
        for email in &missing {
            match found.get(email).filter(|u| !u.is_empty()) {
                Some(url) => {
                    out.insert(email.clone(), url.clone());
                    st.map.insert(email.clone(), CacheEntry { url: url.clone(), fetched_at: now });
                }
                // Negative-cache a real miss only when the scan completed; a
                // rate-limit cut it short, so don't mark un-scanned authors as
                // "no avatar" (which would show Gravatar for the whole NEG TTL).
                None if backoff.is_none() => {
                    st.map.insert(email.clone(), CacheEntry { url: String::new(), fetched_at: now });
                }
                None => {}
            }
        }
        save_cache(&path, &st.map);
    }
    Ok(out)
}

fn fresh(e: &CacheEntry, now: u64) -> bool {
    let ttl = if e.url.is_empty() { NEG_TTL_SECS } else { TTL_SECS };
    now.saturating_sub(e.fetched_at) < ttl
}

/// Record `email -> avatar` into `out` if the email is still wanted and not yet
/// resolved, decrementing how many we still need so paging can stop early.
fn take(
    out: &mut HashMap<String, String>,
    remaining: &mut usize,
    wanted: &HashSet<String>,
    email: Option<String>,
    avatar: Option<String>,
) {
    let (email, avatar) = match (email, avatar) {
        (Some(e), Some(a)) if !a.is_empty() => (e.trim().to_lowercase(), a),
        _ => return,
    };
    if !wanted.contains(&email) || out.contains_key(&email) {
        return;
    }
    out.insert(email, avatar);
    *remaining = remaining.saturating_sub(1);
}

// --- GitHub (REST) ---

#[derive(Deserialize)]
struct GhCommit {
    commit: GhMeta,
    author: Option<GhUser>,
    committer: Option<GhUser>,
}
#[derive(Deserialize)]
struct GhMeta {
    author: GhSig,
    committer: GhSig,
}
#[derive(Deserialize)]
struct GhSig {
    email: Option<String>,
}
#[derive(Deserialize)]
struct GhUser {
    avatar_url: String,
}

/// Percent-encode each segment of a repo path for use in a URL path, keeping '/'
/// as the separator. Owner/repo names are normally URL-safe; this stops a
/// hand-crafted remote from smuggling query/path characters into the API call.
pub(crate) fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|seg| {
            seg.bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                        (b as char).to_string()
                    }
                    _ => format!("%{b:02X}"),
                })
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Seconds to pause background network after a rate-limit response. An explicit
/// `Retry-After` (seconds) wins; else the `*-RateLimit-Reset` epoch minus now;
/// clamped to 30s..1h; else a 15-min fallback that matches the frontend default.
fn backoff_secs(retry_after: Option<&str>, reset: Option<&str>, now: u64) -> u64 {
    if let Some(ra) = retry_after.and_then(|v| v.trim().parse::<u64>().ok()) {
        return ra.clamp(30, 3600);
    }
    if let Some(reset) = reset.and_then(|v| v.trim().parse::<u64>().ok()) {
        if reset > now {
            return (reset - now).clamp(30, 3600);
        }
    }
    900
}

/// Pull the backoff window out of a rate-limited response's headers.
fn resp_backoff(resp: &ureq::Response) -> u64 {
    backoff_secs(
        resp.header("retry-after"),
        resp.header("x-ratelimit-reset").or_else(|| resp.header("ratelimit-reset")),
        now_secs(),
    )
}

/// Returns the resolved avatars plus, when the API rate-limited us mid-scan, the
/// seconds to back off (so `resolve` can tell the UI exactly how long to pause).
fn fetch_github(
    target: &RemoteTarget,
    head: Option<&str>,
    wanted: &HashSet<String>,
) -> AppResult<(HashMap<String, String>, Option<u64>)> {
    let token = provider_token("github", &target.host);
    let path = encode_path(&target.path);
    let mut out = HashMap::new();
    let mut remaining = wanted.len();

    // Scan the current branch first: its commit list includes the base branch's
    // history, so one pass covers both the branch's own authors and the shared
    // history - resolving authors that only appear on a feature branch, which a
    // default-branch-only scan misses. Then fall back to the default branch (no
    // `sha`) for any stragglers, which ALSO covers the "HEAD isn't on the remote"
    // case: an unpushed branch 404s and adds nothing, and the default scan stands.
    //
    // Error semantics differ on purpose: a Status error (404 unpushed ref, or a
    // rate-limit) makes scan_commits `break` and return Ok, so the default scan
    // still runs. A transport error propagates via `?` and aborts the WHOLE fetch
    // so resolve() caches nothing and retries next time - deliberately NOT falling
    // through to cache a partial result, which would negative-cache feature-branch
    // authors the aborted head scan never got to.
    let mut backoff = None;
    if let Some(h) = head {
        backoff = scan_commits(&path, Some(&encode_path(h)), token.as_deref(), wanted, &mut out, &mut remaining)?;
    }
    // A rate-limited head scan means the default scan would hit the same wall.
    if remaining > 0 && backoff.is_none() {
        backoff = scan_commits(&path, None, token.as_deref(), wanted, &mut out, &mut remaining)?;
    }
    Ok((out, backoff))
}

/// Page through a repo's commits (optionally pinned to `sha` = a branch/ref),
/// taking avatars for still-wanted emails. Stops on the last page, once nothing
/// is left to resolve, or on a Status error (rate-limit / missing ref) - keeping
/// what it already has rather than failing the whole resolve.
fn scan_commits(
    path: &str,
    sha: Option<&str>,
    token: Option<&str>,
    wanted: &HashSet<String>,
    out: &mut HashMap<String, String>,
    remaining: &mut usize,
) -> AppResult<Option<u64>> {
    for page in 1..=MAX_PAGES {
        if *remaining == 0 {
            break;
        }
        let mut url = format!("https://api.github.com/repos/{path}/commits?per_page=100&page={page}");
        if let Some(s) = sha {
            url.push_str("&sha=");
            url.push_str(s);
        }
        let mut req = ureq::get(&url)
            .set("Accept", "application/vnd.github+json")
            .set("User-Agent", "GitChef")
            .set("X-GitHub-Api-Version", "2022-11-28");
        if let Some(t) = token {
            req = req.set("Authorization", &format!("Bearer {t}"));
        }
        let commits: Vec<GhCommit> = match req.call() {
            Ok(r) => r.into_json()?,
            // 403/429 = rate-limited: surface the reset so the UI backs off exactly.
            // Any other Status (e.g. 404 unpushed ref) just ends the scan with what
            // we have.
            Err(ureq::Error::Status(code, resp)) => {
                return Ok((code == 403 || code == 429).then(|| resp_backoff(&resp)));
            }
            Err(ureq::Error::Transport(_)) => return Err(AppError::Msg("github request failed".into())),
        };
        let n = commits.len();
        for c in commits {
            take(out, remaining, wanted, c.commit.author.email, c.author.map(|u| sized_github(&u.avatar_url)));
            take(out, remaining, wanted, c.commit.committer.email, c.committer.map(|u| sized_github(&u.avatar_url)));
        }
        if n < 100 {
            break; // last page
        }
    }
    Ok(None)
}

fn sized_github(url: &str) -> String {
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}s={AVATAR_SIZE}")
}

// --- GitLab (GraphQL; the REST commits list carries no avatar) ---

const GITLAB_QUERY: &str = "query($p: ID!, $ref: String!, $after: String) { project(fullPath: $p) { repository { commits(ref: $ref, first: 100, after: $after) { nodes { authorEmail author { avatarUrl } } pageInfo { hasNextPage endCursor } } } } }";

#[derive(Deserialize)]
struct GlResponse {
    data: Option<GlData>,
}
#[derive(Deserialize)]
struct GlData {
    project: Option<GlProject>,
}
#[derive(Deserialize)]
struct GlProject {
    repository: Option<GlRepo>,
}
#[derive(Deserialize)]
struct GlRepo {
    commits: Option<GlCommits>,
}
#[derive(Deserialize)]
struct GlCommits {
    nodes: Vec<GlNode>,
    #[serde(rename = "pageInfo")]
    page_info: GlPageInfo,
}
#[derive(Deserialize)]
struct GlNode {
    #[serde(rename = "authorEmail")]
    author_email: Option<String>,
    author: Option<GlUser>,
}
#[derive(Deserialize)]
struct GlUser {
    #[serde(rename = "avatarUrl")]
    avatar_url: Option<String>,
}
#[derive(Deserialize)]
struct GlPageInfo {
    #[serde(rename = "hasNextPage")]
    has_next_page: bool,
    #[serde(rename = "endCursor")]
    end_cursor: Option<String>,
}

fn fetch_gitlab(
    target: &RemoteTarget,
    head: Option<&str>,
    wanted: &HashSet<String>,
) -> AppResult<(HashMap<String, String>, Option<u64>)> {
    // Private repos (the common case) require auth; with no token there's nothing
    // to resolve, so bail to Gravatar instead of erroring.
    let token = match provider_token("gitlab", &target.host) {
        Some(t) => t,
        None => return Ok((HashMap::new(), None)),
    };
    let refname = head.unwrap_or("HEAD");
    let endpoint = format!("https://{}/api/graphql", target.host);
    let mut out = HashMap::new();
    let mut remaining = wanted.len();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        if remaining == 0 {
            break;
        }
        let body = serde_json::json!({
            "query": GITLAB_QUERY,
            "variables": { "p": target.path, "ref": refname, "after": cursor },
        });
        let resp: GlResponse = match ureq::post(&endpoint)
            .set("Authorization", &format!("Bearer {token}"))
            .send_json(body)
        {
            Ok(r) => r.into_json()?,
            Err(ureq::Error::Status(code, resp)) => {
                if code == 403 || code == 429 {
                    return Ok((out, Some(resp_backoff(&resp))));
                }
                break; // other Status (bad ref / no access): keep the partial result
            }
            Err(ureq::Error::Transport(_)) => return Err(AppError::Msg("gitlab request failed".into())),
        };
        let commits = match resp
            .data
            .and_then(|d| d.project)
            .and_then(|p| p.repository)
            .and_then(|r| r.commits)
        {
            Some(c) => c,
            None => break, // bad ref / no access
        };
        for n in commits.nodes {
            let host = &target.host;
            take(&mut out, &mut remaining, wanted, n.author_email, n.author.and_then(|u| u.avatar_url).map(|a| sized_gitlab(host, &a)));
        }
        if !commits.page_info.has_next_page {
            break;
        }
        match commits.page_info.end_cursor {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    Ok((out, None))
}

/// GitLab `avatarUrl` is instance-relative (`/uploads/.../avatar.png`); make it
/// absolute and request our size.
fn sized_gitlab(host: &str, url: &str) -> String {
    let abs = if url.starts_with("http") {
        url.to_string()
    } else {
        format!("https://{host}{url}")
    };
    let sep = if abs.contains('?') { '&' } else { '?' };
    format!("{abs}{sep}width={AVATAR_SIZE}")
}

// --- tokens ---

/// Token for a provider host: explicit env override first, else the user's
/// already-authenticated `gh`/`glab` CLI. None -> unauthenticated.
fn provider_token(provider: &str, host: &str) -> Option<String> {
    let env_keys: &[&str] = if provider == "github" {
        &["GITHUB_TOKEN", "GH_TOKEN"]
    } else {
        &["GITLAB_TOKEN", "GL_TOKEN"]
    };
    for key in env_keys {
        if let Ok(v) = std::env::var(key) {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    let args: &[&str] = if provider == "github" {
        &["gh", "auth", "token", "--hostname", host]
    } else {
        &["glab", "config", "get", "token", "--host", host]
    };
    run_capture(args)
}

fn run_capture(args: &[&str]) -> Option<String> {
    let (bin, rest) = args.split_first()?;
    // GUI apps launch with a minimal PATH; prepend the usual install dirs so the
    // CLIs resolve when the app wasn't started from a shell.
    let base = std::env::var("PATH").unwrap_or_default();
    let path = format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{base}");
    let out = std::process::Command::new(bin)
        .args(rest)
        .env("PATH", path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!token.is_empty()).then_some(token)
}

// --- cache I/O ---

fn cache_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Msg(format!("no app cache dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("avatars.json"))
}

fn load_cache(path: &Path) -> HashMap<String, CacheEntry> {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_cache(path: &Path, map: &HashMap<String, CacheEntry>) {
    // Best-effort and atomic: write a temp then rename, so a crash mid-write
    // can't corrupt the cache. Serialized by CACHE, so the temp name is safe.
    if let Ok(bytes) = serde_json::to_vec(map) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, &bytes).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(provider: RemoteProvider, host: &str, path: &str) -> RemoteTarget {
        RemoteTarget { host: host.into(), provider, path: path.into() }
    }

    #[test]
    fn backoff_prefers_retry_after_then_reset_then_default() {
        // Retry-After (seconds) wins, clamped to 30s..1h.
        assert_eq!(backoff_secs(Some("90"), Some("999999"), 1000), 90);
        assert_eq!(backoff_secs(Some("5"), None, 1000), 30); // clamp min
        assert_eq!(backoff_secs(Some("99999"), None, 1000), 3600); // clamp max
        // Else X-RateLimit-Reset (epoch) minus now.
        assert_eq!(backoff_secs(None, Some("1300"), 1000), 300);
        // Reset already in the past -> fall through to the default.
        assert_eq!(backoff_secs(None, Some("900"), 1000), 900);
        // No usable header, or an unparseable one -> 15-min default.
        assert_eq!(backoff_secs(None, None, 1000), 900);
        assert_eq!(backoff_secs(Some("soon"), None, 1000), 900);
    }

    #[test]
    fn sizes_github_url() {
        assert_eq!(
            sized_github("https://avatars.githubusercontent.com/u/1?v=4"),
            "https://avatars.githubusercontent.com/u/1?v=4&s=64"
        );
        assert_eq!(sized_github("https://x/a.png"), "https://x/a.png?s=64");
    }

    #[test]
    fn encodes_path_segments_keeping_slash() {
        assert_eq!(encode_path("owner/repo"), "owner/repo"); // safe names untouched
        assert_eq!(encode_path("grp/sub/repo"), "grp/sub/repo"); // nested groups keep '/'
        assert_eq!(encode_path("a.b_c-d~e"), "a.b_c-d~e"); // unreserved set untouched
        assert_eq!(encode_path("o wner/re?po"), "o%20wner/re%3Fpo"); // space + query char
    }

    #[test]
    fn absolutizes_gitlab_url() {
        assert_eq!(
            sized_gitlab("gitlab.com", "/uploads/x/avatar.png"),
            "https://gitlab.com/uploads/x/avatar.png?width=64"
        );
        // A Gravatar fallback handed back by GitLab is already absolute.
        assert_eq!(
            sized_gitlab("gitlab.com", "https://secure.gravatar.com/avatar/abc?s=80"),
            "https://secure.gravatar.com/avatar/abc?s=80&width=64"
        );
    }

    #[test]
    #[ignore = "network: hits the public GitHub API"]
    fn live_github() {
        let t = target(RemoteProvider::Github, "github.com", "cli/cli");
        let token = provider_token("github", &t.host);
        // Discover currently-linked author emails so the assertion can't rot as
        // history moves past a hardcoded address.
        let url = format!("https://api.github.com/repos/{}/commits?per_page=100", t.path);
        let mut req = ureq::get(&url)
            .set("Accept", "application/vnd.github+json")
            .set("User-Agent", "GitChef");
        if let Some(tok) = &token {
            req = req.set("Authorization", &format!("Bearer {tok}"));
        }
        let commits: Vec<GhCommit> = req.call().unwrap().into_json().unwrap();
        let wanted: HashSet<String> = commits
            .into_iter()
            .filter(|c| c.author.is_some())
            .filter_map(|c| c.commit.author.email)
            .map(|e| e.trim().to_lowercase())
            .collect();
        assert!(!wanted.is_empty(), "no linked GitHub author emails discovered");
        // Emails were discovered from the default branch (no sha), so scan that.
        let (out, _backoff) = fetch_github(&t, None, &wanted).unwrap();
        assert!(!out.is_empty(), "expected resolved GitHub avatars for {} emails: {out:?}", wanted.len());
    }

    #[test]
    #[ignore = "network: hits the public GitLab GraphQL API (needs glab/GITLAB_TOKEN)"]
    fn live_gitlab() {
        let t = target(RemoteProvider::Gitlab, "gitlab.com", "gitlab-org/gitlab-runner");
        let token = provider_token("gitlab", &t.host).expect("glab/GITLAB_TOKEN required for this test");
        let body = serde_json::json!({
            "query": GITLAB_QUERY,
            "variables": { "p": t.path, "ref": "main", "after": null },
        });
        let resp: GlResponse = ureq::post(&format!("https://{}/api/graphql", t.host))
            .set("Authorization", &format!("Bearer {token}"))
            .send_json(body)
            .unwrap()
            .into_json()
            .unwrap();
        let wanted: HashSet<String> = resp
            .data
            .and_then(|d| d.project)
            .and_then(|p| p.repository)
            .and_then(|r| r.commits)
            .map(|c| {
                c.nodes
                    .into_iter()
                    .filter(|n| n.author.is_some())
                    .filter_map(|n| n.author_email)
                    .map(|e| e.trim().to_lowercase())
                    .collect()
            })
            .unwrap_or_default();
        assert!(!wanted.is_empty(), "no linked GitLab author emails discovered");
        let (out, _backoff) = fetch_gitlab(&t, Some("main"), &wanted).unwrap();
        assert!(!out.is_empty(), "expected resolved GitLab avatars for {} emails: {out:?}", wanted.len());
    }
}
