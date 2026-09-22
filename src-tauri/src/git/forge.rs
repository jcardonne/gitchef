use super::repo::{remote_target, RemoteProvider};
use crate::error::{AppError, AppResult};
use git2::Repository;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use tauri::AppHandle;

/// Run a forge CLI (`gh`/`glab`) inside the repo dir and return its stdout. GUI
/// apps launch with a minimal PATH, so the usual install dirs are prepended
/// (mirrors avatars::run_capture). On failure the CLI's stderr is surfaced so
/// the user sees the real reason (not authenticated, branch not pushed, ...).
fn run_cli(dir: &Path, args: &[&str]) -> AppResult<String> {
    let (bin, rest) = args.split_first().ok_or_else(|| AppError::Msg("empty command".into()))?;
    let base = std::env::var("PATH").unwrap_or_default();
    let path = format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{base}");
    let out = Command::new(bin)
        .args(rest)
        .current_dir(dir)
        .env("PATH", path)
        .output()
        .map_err(|e| AppError::Msg(format!("failed to run `{bin}` (is it installed?): {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let msg = if stderr.trim().is_empty() {
            String::from_utf8_lossy(&out.stdout).into_owned()
        } else {
            stderr.into_owned()
        };
        return Err(AppError::Msg(msg.trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// First https URL in CLI output - `gh`/`glab` print the created PR/MR URL.
fn first_url(text: &str) -> Option<String> {
    text.split_whitespace().find(|t| t.starts_with("https://")).map(str::to_string)
}

/// Create a PR (GitHub) / MR (GitLab) for the current branch against `base`,
/// via the user's `gh`/`glab` CLI (no token handled here - the CLI owns auth).
/// The source branch is pushed first (a PR needs it on the remote); the created
/// page is opened and its URL returned.
pub fn create_pr(repo: &Repository, title: &str, body: &str, base: &str) -> AppResult<String> {
    let target = remote_target(repo)
        .ok_or_else(|| AppError::Msg("no GitHub/GitLab remote for this repo".into()))?;
    if repo.head_detached()? {
        return Err(AppError::Msg("check out a branch before creating a pull request".into()));
    }
    let head = repo.head()?;
    let branch = head
        .shorthand()
        .ok_or_else(|| AppError::Msg("cannot resolve the current branch name".into()))?
        .to_string();
    let dir = super::workdir(repo)?;

    // The source branch must exist on the remote for the PR/MR to be openable.
    super::run_git(dir, &["push", "--set-upstream", "origin", &branch])?;

    let out = match target.provider {
        RemoteProvider::Github => run_cli(
            dir,
            &["gh", "pr", "create", "--title", title, "--body", body, "--base", base],
        )?,
        RemoteProvider::Gitlab => run_cli(
            dir,
            &[
                "glab", "mr", "create", "--title", title, "--description", body,
                "--target-branch", base, "--source-branch", &branch, "--yes",
            ],
        )?,
    };
    let url = first_url(&out)
        .ok_or_else(|| AppError::Msg(format!("created, but could not find its URL in the CLI output:\n{out}")))?;
    super::files::open_url(&url)?;
    Ok(url)
}

/// A pull request (GitHub) / merge request (GitLab), normalized across providers.
#[derive(Serialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// Source branch (`headRefName` / `source_branch`) - links a PR to a branch.
    pub branch: String,
    pub draft: bool,
    pub author: String,
    /// Author avatar URL, or None when the provider doesn't hand one out cheaply.
    pub author_avatar: Option<String>,
    /// Rolled-up CI: "success" | "failure" | "pending" | "none".
    pub checks: String,
    /// "approved" | "changes_requested" | "review_required" | "none".
    pub review: String,
}

/// Open pull/merge requests for the repo's remote, via the user's `gh`/`glab`
/// CLI. Returns an empty list for non-forge remotes rather than erroring, so the
/// UI just hides the section. GitLab yields a degraded row (no CI/review/avatar -
/// `glab mr list` doesn't include them).
pub fn list_prs(app: Option<&AppHandle>, repo: &Repository) -> AppResult<Vec<PullRequest>> {
    let Some(target) = remote_target(repo) else {
        return Ok(Vec::new());
    };
    let dir = super::workdir(repo)?;
    match target.provider {
        RemoteProvider::Github => list_github(app, &target.host, dir),
        RemoteProvider::Gitlab => list_gitlab(app, &target.host, dir),
    }
}

#[derive(Deserialize)]
struct GhPr {
    number: u64,
    title: String,
    url: String,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    #[serde(rename = "isDraft")]
    is_draft: bool,
    author: GhAuthor,
    #[serde(rename = "statusCheckRollup", default)]
    status_check_rollup: Vec<GhCheck>,
    #[serde(rename = "reviewDecision", default)]
    review_decision: Option<String>,
}
#[derive(Default, Deserialize)]
struct GhAuthor {
    #[serde(default)]
    login: String,
}
/// Heterogeneous rollup entry: a CheckRun (status+conclusion) or a StatusContext
/// (state). All optional so unknown shapes just don't contribute.
#[derive(Deserialize)]
struct GhCheck {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    state: Option<String>,
}

fn list_github(app: Option<&AppHandle>, host: &str, dir: &Path) -> AppResult<Vec<PullRequest>> {
    let out = run_cli(
        dir,
        &[
            "gh", "pr", "list", "--state", "open", "--limit", "50", "--json",
            "number,title,url,headRefName,isDraft,author,statusCheckRollup,reviewDecision",
        ],
    )?;
    let prs: Vec<GhPr> = serde_json::from_str(&out)
        .map_err(|e| AppError::Msg(format!("could not parse `gh pr list` output: {e}")))?;
    Ok(prs
        .into_iter()
        .map(|p| {
            let clean_login = p.login().strip_prefix("app/").unwrap_or_else(|| p.login()).to_string();
            let author_avatar = (!clean_login.is_empty()).then(|| {
                if let Some(app) = app {
                    if let Some(cached) = super::avatars::cached_avatar_for_login(app, Some(host), &clean_login) {
                        return cached;
                    }
                }
                format!("https://github.com/{clean_login}.png?size=40")
            });
            PullRequest {
                number: p.number,
                title: p.title,
                url: p.url,
                branch: p.head_ref_name,
                draft: p.is_draft,
                author: clean_login,
                author_avatar,
                checks: rollup_checks(&p.status_check_rollup),
                review: normalize_review(p.review_decision.as_deref()),
            }
        })
        .collect())
}

impl GhPr {
    fn login(&self) -> &str {
        &self.author.login
    }
}

/// Roll a GitHub statusCheckRollup up to one word: any failure wins, then any
/// still-running, then success; empty/all-unknown -> "none".
fn rollup_checks(checks: &[GhCheck]) -> String {
    let mut any_pending = false;
    let mut any_success = false;
    for c in checks {
        // CheckRun: not yet COMPLETED means it's still running.
        if let Some(s) = &c.status {
            if s != "COMPLETED" {
                any_pending = true;
                continue;
            }
        }
        // Normalized outcome from either a CheckRun conclusion or a StatusContext state.
        let outcome = c.conclusion.as_deref().or(c.state.as_deref()).unwrap_or("");
        match outcome.to_ascii_uppercase().as_str() {
            "FAILURE" | "ERROR" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED"
            | "STARTUP_FAILURE" => return "failure".into(),
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => any_success = true,
            "PENDING" | "EXPECTED" | "IN_PROGRESS" | "QUEUED" => any_pending = true,
            _ => {}
        }
    }
    if any_pending {
        "pending".into()
    } else if any_success {
        "success".into()
    } else {
        "none".into()
    }
}

fn normalize_review(decision: Option<&str>) -> String {
    match decision {
        Some("APPROVED") => "approved",
        Some("CHANGES_REQUESTED") => "changes_requested",
        Some("REVIEW_REQUIRED") => "review_required",
        _ => "none",
    }
    .to_string()
}

#[derive(Deserialize)]
struct GlMr {
    iid: u64,
    title: String,
    web_url: String,
    source_branch: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    work_in_progress: bool,
    #[serde(default)]
    author: GlAuthor,
}
#[derive(Deserialize, Default)]
struct GlAuthor {
    #[serde(default)]
    username: String,
}

fn list_gitlab(app: Option<&AppHandle>, host: &str, dir: &Path) -> AppResult<Vec<PullRequest>> {
    let out = run_cli(dir, &["glab", "mr", "list", "--output", "json"])?;
    let mrs: Vec<GlMr> = serde_json::from_str(&out)
        .map_err(|e| AppError::Msg(format!("could not parse `glab mr list` output: {e}")))?;
    Ok(mrs
        .into_iter()
        .map(|m| {
            let author_avatar = if !m.author.username.is_empty() {
                app.and_then(|a| super::avatars::cached_avatar_for_login(a, Some(host), &m.author.username))
            } else {
                None
            };
            PullRequest {
                number: m.iid,
                title: m.title,
                url: m.web_url,
                branch: m.source_branch,
                draft: m.draft || m.work_in_progress,
                author: m.author.username,
                author_avatar,
                checks: "none".into(),
                review: "none".into(),
            }
        })
        .collect())
}

/// A repository the signed-in user can clone, normalized across GitHub/GitLab.
#[derive(Serialize)]
pub struct ForgeRepo {
    pub name: String, // owner/name (or group/.../name on GitLab)
    pub url: String, // https clone URL
    pub ssh_url: String,
    pub description: String,
    pub private: bool,
    pub fork: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRepo {
    name_with_owner: String,
    url: String,
    ssh_url: String,
    #[serde(default)]
    description: String,
    is_private: bool,
    is_fork: bool,
}

#[derive(Deserialize)]
struct GlRepo {
    path_with_namespace: String,
    http_url_to_repo: String,
    ssh_url_to_repo: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    visibility: String,
    #[serde(default)]
    forked_from_project: Option<serde_json::Value>,
}

/// Repositories the signed-in user can clone from `provider` ("github"/"gitlab"),
/// via their `gh`/`glab` CLI (the CLI owns auth). Runs without an open repo - these
/// list the account globally - so it works from the clone dialog. GitLab uses
/// `--member` so group projects show up, not just owned ones.
pub fn list_repos(provider: &str) -> AppResult<Vec<ForgeRepo>> {
    let dir = std::env::temp_dir();
    match provider {
        "github" => map_gh(&run_cli(
            &dir,
            &[
                "gh", "repo", "list", "--limit", "200", "--json",
                "nameWithOwner,url,sshUrl,description,isPrivate,isFork",
            ],
        )?),
        "gitlab" => map_gl(&run_cli(
            &dir,
            &["glab", "repo", "list", "--member", "--per-page", "100", "--output", "json"],
        )?),
        other => Err(AppError::Msg(format!("unknown provider: {other}"))),
    }
}

/// Parse `gh repo list --json …` output into normalized repos.
fn map_gh(out: &str) -> AppResult<Vec<ForgeRepo>> {
    let repos: Vec<GhRepo> = serde_json::from_str(out)
        .map_err(|e| AppError::Msg(format!("could not parse `gh repo list` output: {e}")))?;
    Ok(repos
        .into_iter()
        .map(|r| ForgeRepo {
            name: r.name_with_owner,
            url: r.url,
            ssh_url: r.ssh_url,
            description: r.description,
            private: r.is_private,
            fork: r.is_fork,
        })
        .collect())
}

/// Parse `glab repo list --output json` output into normalized repos.
fn map_gl(out: &str) -> AppResult<Vec<ForgeRepo>> {
    let repos: Vec<GlRepo> = serde_json::from_str(out)
        .map_err(|e| AppError::Msg(format!("could not parse `glab repo list` output: {e}")))?;
    Ok(repos
        .into_iter()
        .map(|r| ForgeRepo {
            name: r.path_with_namespace,
            url: r.http_url_to_repo,
            ssh_url: r.ssh_url_to_repo,
            description: r.description.unwrap_or_default(),
            private: r.visibility != "public",
            fork: r.forked_from_project.is_some(),
        })
        .collect())
}

#[derive(Serialize)]
pub struct PrCheckDetail {
    pub name: String,
    pub workflow: Option<String>,
    pub status: String,
    pub conclusion: Option<String>,
    pub url: Option<String>,
}

#[derive(Serialize)]
pub struct PrReviewDetail {
    pub author: String,
    pub author_avatar: Option<String>,
    pub state: String,
    pub body: String,
    pub submitted_at: Option<String>,
}

#[derive(Serialize)]
pub struct PrCommitDetail {
    pub oid: String,
    pub headline: String,
    pub body: String,
    pub author: String,
    pub date: String,
}

#[derive(Serialize)]
pub struct PrCommentDetail {
    pub author: String,
    pub author_avatar: Option<String>,
    pub body: String,
    pub created_at: String,
}

#[derive(Serialize)]
pub struct PrDetails {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub state: String,
    pub url: String,
    pub branch: String,
    pub base_branch: String,
    pub draft: bool,
    pub author: String,
    pub author_avatar: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub merged_at: Option<String>,
    pub closed_at: Option<String>,
    pub additions: usize,
    pub deletions: usize,
    pub changed_files: usize,
    pub mergeable: String,
    pub checks: Vec<PrCheckDetail>,
    pub reviews: Vec<PrReviewDetail>,
    pub commits: Vec<PrCommitDetail>,
    pub comments: Vec<PrCommentDetail>,
}

pub fn get_pr_details(
    app: Option<&AppHandle>,
    repo: &Repository,
    number: u64,
) -> AppResult<PrDetails> {
    let Some(target) = remote_target(repo) else {
        return Err(AppError::Msg("no GitHub/GitLab remote for this repo".into()));
    };
    let dir = super::workdir(repo)?;
    match target.provider {
        RemoteProvider::Github => get_pr_github(app, &target.host, dir, number),
        RemoteProvider::Gitlab => get_pr_gitlab(app, &target.host, dir, number),
    }
}

pub fn get_pr_diff(repo: &Repository, number: u64) -> AppResult<Vec<super::diff::FileDiff>> {
    let Some(target) = remote_target(repo) else {
        return Err(AppError::Msg("no GitHub/GitLab remote for this repo".into()));
    };
    let dir = super::workdir(repo)?;
    let num_str = number.to_string();
    let patch = match target.provider {
        RemoteProvider::Github => run_cli(dir, &["gh", "pr", "diff", &num_str])?,
        RemoteProvider::Gitlab => run_cli(dir, &["glab", "mr", "diff", &num_str])?,
    };
    super::diff::diff_from_patch(&patch)
}

pub fn merge_pr(repo: &Repository, number: u64, method: Option<String>) -> AppResult<String> {
    let Some(target) = remote_target(repo) else {
        return Err(AppError::Msg("no GitHub/GitLab remote for this repo".into()));
    };
    let dir = super::workdir(repo)?;
    let num_str = number.to_string();
    match target.provider {
        RemoteProvider::Github => {
            let flag = match method.as_deref() {
                Some("squash") => "--squash",
                Some("rebase") => "--rebase",
                _ => "--merge",
            };
            run_cli(dir, &["gh", "pr", "merge", &num_str, flag, "--auto"])
                .or_else(|_| run_cli(dir, &["gh", "pr", "merge", &num_str, flag]))
        }
        RemoteProvider::Gitlab => {
            let mut args = vec!["glab", "mr", "merge", &num_str, "--yes"];
            match method.as_deref() {
                Some("squash") => args.push("--squash"),
                Some("rebase") => args.push("--rebase"),
                _ => {}
            }
            run_cli(dir, &args)
        }
    }
}

pub fn checkout_pr(repo: &Repository, number: u64) -> AppResult<String> {
    let Some(target) = remote_target(repo) else {
        return Err(AppError::Msg("no GitHub/GitLab remote for this repo".into()));
    };
    let dir = super::workdir(repo)?;
    let num_str = number.to_string();
    match target.provider {
        RemoteProvider::Github => run_cli(dir, &["gh", "pr", "checkout", &num_str]),
        RemoteProvider::Gitlab => run_cli(dir, &["glab", "mr", "checkout", &num_str]),
    }
}

pub fn approve_pr(repo: &Repository, number: u64) -> AppResult<String> {
    let Some(target) = remote_target(repo) else {
        return Err(AppError::Msg("no GitHub/GitLab remote for this repo".into()));
    };
    let dir = super::workdir(repo)?;
    let num_str = number.to_string();
    match target.provider {
        RemoteProvider::Github => {
            run_cli(dir, &["gh", "pr", "review", &num_str, "--approve"])
        }
        RemoteProvider::Gitlab => {
            run_cli(dir, &["glab", "mr", "approve", &num_str])
        }
    }
}

#[derive(Deserialize)]
struct GhPrView {
    number: u64,
    title: String,
    #[serde(default)]
    body: String,
    state: String,
    url: String,
    #[serde(rename = "headRefName")]
    head_ref_name: String,
    #[serde(rename = "baseRefName")]
    base_ref_name: String,
    #[serde(rename = "isDraft", default)]
    is_draft: bool,
    author: GhAuthor,
    #[serde(rename = "createdAt", default)]
    created_at: String,
    #[serde(rename = "updatedAt", default)]
    updated_at: String,
    #[serde(rename = "mergedAt")]
    merged_at: Option<String>,
    #[serde(rename = "closedAt")]
    closed_at: Option<String>,
    #[serde(default)]
    additions: usize,
    #[serde(default)]
    deletions: usize,
    #[serde(rename = "changedFiles", default)]
    changed_files: usize,
    #[serde(default)]
    mergeable: Option<String>,
    #[serde(rename = "statusCheckRollup", default)]
    status_check_rollup: Vec<GhCheckView>,
    #[serde(default)]
    reviews: Vec<GhReviewView>,
    #[serde(default)]
    commits: Vec<GhCommitView>,
    #[serde(default)]
    comments: Vec<GhCommentView>,
}

#[derive(Deserialize)]
struct GhCheckView {
    #[serde(default)]
    name: Option<String>,
    #[serde(rename = "workflowName", default)]
    workflow_name: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(rename = "detailsUrl", default)]
    details_url: Option<String>,
}

#[derive(Deserialize)]
struct GhReviewView {
    #[serde(default)]
    author: GhAuthor,
    #[serde(default)]
    state: String,
    #[serde(default)]
    body: String,
    #[serde(rename = "submittedAt")]
    submitted_at: Option<String>,
}

#[derive(Deserialize)]
struct GhCommitView {
    #[serde(default)]
    oid: String,
    #[serde(rename = "messageHeadline", default)]
    message_headline: String,
    #[serde(rename = "messageBody", default)]
    message_body: String,
    #[serde(rename = "committedDate", default)]
    committed_date: String,
    #[serde(default)]
    authors: Vec<GhCommitAuthor>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct GhCommitAuthor {
    #[serde(default)]
    name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    login: Option<String>,
}

#[derive(Deserialize)]
struct GhCommentView {
    #[serde(default)]
    author: GhAuthor,
    #[serde(default)]
    body: String,
    #[serde(rename = "createdAt", default)]
    created_at: String,
}

fn get_pr_github(app: Option<&AppHandle>, host: &str, dir: &Path, number: u64) -> AppResult<PrDetails> {
    let num_str = number.to_string();
    let out = run_cli(
        dir,
        &[
            "gh", "pr", "view", &num_str, "--json",
            "number,title,body,state,url,headRefName,baseRefName,isDraft,author,createdAt,updatedAt,mergedAt,closedAt,additions,deletions,changedFiles,mergeable,statusCheckRollup,reviews,commits,comments",
        ],
    )?;
    let p: GhPrView = serde_json::from_str(&out)
        .map_err(|e| AppError::Msg(format!("could not parse `gh pr view` output: {e}")))?;

    let clean_login = p.author.login.strip_prefix("app/").unwrap_or_else(|| &p.author.login).to_string();
    let author_avatar = (!clean_login.is_empty()).then(|| {
        if let Some(app) = app {
            if let Some(cached) = super::avatars::cached_avatar_for_login(app, Some(host), &clean_login) {
                return cached;
            }
        }
        format!("https://github.com/{clean_login}.png?size=40")
    });

    let checks = p.status_check_rollup.into_iter().map(|c| {
        let status = c.status.or(c.state).unwrap_or_else(|| "UNKNOWN".into());
        PrCheckDetail {
            name: c.name.unwrap_or_else(|| "check".into()),
            workflow: c.workflow_name,
            status,
            conclusion: c.conclusion,
            url: c.details_url,
        }
    }).collect();

    let reviews = p.reviews.into_iter().map(|r| {
        let r_author = r.author.login.strip_prefix("app/").unwrap_or_else(|| &r.author.login).to_string();
        let r_avatar = (!r_author.is_empty()).then(|| {
            if let Some(app) = app {
                if let Some(cached) = super::avatars::cached_avatar_for_login(app, Some(host), &r_author) {
                    return cached;
                }
            }
            format!("https://github.com/{r_author}.png?size=40")
        });
        PrReviewDetail {
            author: r_author,
            author_avatar: r_avatar,
            state: r.state,
            body: r.body,
            submitted_at: r.submitted_at,
        }
    }).collect();

    let commits = p.commits.into_iter().map(|cm| {
        let author_name = cm.authors.first().map(|a| a.name.clone()).unwrap_or_default();
        PrCommitDetail {
            oid: cm.oid,
            headline: cm.message_headline,
            body: cm.message_body,
            author: author_name,
            date: cm.committed_date,
        }
    }).collect();

    let comments = p.comments.into_iter().map(|c| {
        let c_author = c.author.login.strip_prefix("app/").unwrap_or_else(|| &c.author.login).to_string();
        let c_avatar = (!c_author.is_empty()).then(|| {
            if let Some(app) = app {
                if let Some(cached) = super::avatars::cached_avatar_for_login(app, Some(host), &c_author) {
                    return cached;
                }
            }
            format!("https://github.com/{c_author}.png?size=40")
        });
        PrCommentDetail {
            author: c_author,
            author_avatar: c_avatar,
            body: c.body,
            created_at: c.created_at,
        }
    }).collect();

    Ok(PrDetails {
        number: p.number,
        title: p.title,
        body: p.body,
        state: p.state,
        url: p.url,
        branch: p.head_ref_name,
        base_branch: p.base_ref_name,
        draft: p.is_draft,
        author: clean_login,
        author_avatar,
        created_at: p.created_at,
        updated_at: p.updated_at,
        merged_at: p.merged_at,
        closed_at: p.closed_at,
        additions: p.additions,
        deletions: p.deletions,
        changed_files: p.changed_files,
        mergeable: p.mergeable.unwrap_or_else(|| "UNKNOWN".into()),
        checks,
        reviews,
        commits,
        comments,
    })
}

fn get_pr_gitlab(app: Option<&AppHandle>, host: &str, dir: &Path, number: u64) -> AppResult<PrDetails> {
    let num_str = number.to_string();
    let out = run_cli(dir, &["glab", "mr", "view", &num_str, "--output", "json"])?;
    #[derive(Deserialize)]
    struct GlMrView {
        iid: u64,
        title: String,
        #[serde(default)]
        description: String,
        state: String,
        web_url: String,
        source_branch: String,
        target_branch: String,
        #[serde(default)]
        draft: bool,
        author: GlAuthor,
        #[serde(default)]
        created_at: String,
        #[serde(default)]
        updated_at: String,
        merged_at: Option<String>,
        closed_at: Option<String>,
    }
    #[derive(Deserialize)]
    struct GlAuthor {
        #[serde(default)]
        username: String,
        #[serde(default)]
        avatar_url: Option<String>,
    }
    let m: GlMrView = serde_json::from_str(&out)
        .map_err(|e| AppError::Msg(format!("could not parse `glab mr view` output: {e}")))?;
    // ponytail: normalize GitLab MR state "opened" to "OPEN" so the frontend badge
    // and merge/action guards align with GitHub's "OPEN" / "MERGED" / "CLOSED".
    let state = match m.state.to_ascii_uppercase().as_str() {
        "OPENED" => "OPEN".to_string(),
        other => other.to_string(),
    };
    let author_avatar = m.author.avatar_url.filter(|u| !u.is_empty()).or_else(|| {
        app.and_then(|a| super::avatars::cached_avatar_for_login(a, Some(host), &m.author.username))
    });
    Ok(PrDetails {
        number: m.iid,
        title: m.title,
        body: m.description,
        state,
        url: m.web_url,
        branch: m.source_branch,
        base_branch: m.target_branch,
        draft: m.draft,
        author: m.author.username,
        author_avatar,
        created_at: m.created_at,
        updated_at: m.updated_at,
        merged_at: m.merged_at,
        closed_at: m.closed_at,
        additions: 0,
        deletions: 0,
        changed_files: 0,
        mergeable: "UNKNOWN".into(),
        checks: Vec::new(),
        reviews: Vec::new(),
        commits: Vec::new(),
        comments: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::{first_url, map_gh, map_gl, normalize_review, rollup_checks, GhCheck};

    fn check(status: Option<&str>, conclusion: Option<&str>, state: Option<&str>) -> GhCheck {
        GhCheck {
            status: status.map(String::from),
            conclusion: conclusion.map(String::from),
            state: state.map(String::from),
        }
    }

    #[test]
    fn maps_gh_and_glab_repo_json_to_forge_repos() {
        // Real shapes captured from `gh repo list --json …` and `glab repo list --output json`.
        let gh = map_gh(
            r#"[{"description":"a client","isFork":false,"isPrivate":true,"nameWithOwner":"me/app","sshUrl":"git@github.com:me/app.git","url":"https://github.com/me/app"}]"#,
        )
        .unwrap();
        assert_eq!(gh.len(), 1);
        assert_eq!(gh[0].name, "me/app");
        assert_eq!(gh[0].url, "https://github.com/me/app");
        assert_eq!(gh[0].ssh_url, "git@github.com:me/app.git");
        assert!(gh[0].private && !gh[0].fork);

        // GitLab: null description, nested group path, non-public visibility.
        let gl = map_gl(
            r#"[{"name":"orisha","path_with_namespace":"atyos/superscooper/orisha","http_url_to_repo":"https://gitlab.com/atyos/superscooper/orisha.git","ssh_url_to_repo":"git@gitlab.com:atyos/superscooper/orisha.git","description":null,"visibility":"private"}]"#,
        )
        .unwrap();
        assert_eq!(gl.len(), 1);
        assert_eq!(gl[0].name, "atyos/superscooper/orisha");
        assert_eq!(gl[0].url, "https://gitlab.com/atyos/superscooper/orisha.git");
        assert_eq!(gl[0].description, ""); // null -> empty
        assert!(gl[0].private && !gl[0].fork);
    }

    #[test]
    fn rolls_up_checks_failure_wins() {
        assert_eq!(rollup_checks(&[]), "none");
        assert_eq!(
            rollup_checks(&[check(Some("COMPLETED"), Some("SUCCESS"), None)]),
            "success"
        );
        // A still-running check makes the whole thing pending...
        assert_eq!(
            rollup_checks(&[
                check(Some("COMPLETED"), Some("SUCCESS"), None),
                check(Some("IN_PROGRESS"), None, None),
            ]),
            "pending"
        );
        // ...but any failure wins outright.
        assert_eq!(
            rollup_checks(&[
                check(Some("IN_PROGRESS"), None, None),
                check(Some("COMPLETED"), Some("FAILURE"), None),
            ]),
            "failure"
        );
        // StatusContext form (state, no CheckRun status).
        assert_eq!(rollup_checks(&[check(None, None, Some("success"))]), "success");
    }

    #[test]
    fn normalizes_review_decision() {
        assert_eq!(normalize_review(Some("APPROVED")), "approved");
        assert_eq!(normalize_review(Some("CHANGES_REQUESTED")), "changes_requested");
        assert_eq!(normalize_review(None), "none");
        assert_eq!(normalize_review(Some("weird")), "none");
    }

    #[test]
    fn extracts_the_pr_url_from_cli_output() {
        assert_eq!(
            first_url("Creating pull request...\nhttps://github.com/o/r/pull/42\n").as_deref(),
            Some("https://github.com/o/r/pull/42")
        );
        assert_eq!(first_url("https://gitlab.com/g/p/-/merge_requests/7").as_deref(), Some("https://gitlab.com/g/p/-/merge_requests/7"));
        assert_eq!(first_url("no url here"), None);
    }

    #[test]
    fn cleans_bot_logins() {
        let raw = r#"[{"number":1,"title":"bump","url":"https://github.com/a/b/pull/1","headRefName":"dep","isDraft":false,"author":{"login":"app/dependabot"},"statusCheckRollup":[],"reviewDecision":null}]"#;
        let prs: Vec<super::GhPr> = serde_json::from_str(raw).unwrap();
        assert_eq!(prs[0].login().strip_prefix("app/").unwrap_or_else(|| prs[0].login()), "dependabot");
    }
}
