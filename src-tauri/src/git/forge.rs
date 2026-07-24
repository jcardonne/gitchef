use super::repo::{remote_target, RemoteProvider};
use crate::error::{AppError, AppResult};
use git2::Repository;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

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
pub fn list_prs(repo: &Repository) -> AppResult<Vec<PullRequest>> {
    let Some(target) = remote_target(repo) else {
        return Ok(Vec::new());
    };
    let dir = super::workdir(repo)?;
    match target.provider {
        RemoteProvider::Github => list_github(dir),
        RemoteProvider::Gitlab => list_gitlab(dir),
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
#[derive(Deserialize)]
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

fn list_github(dir: &Path) -> AppResult<Vec<PullRequest>> {
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
            let author_avatar = (!p.login().is_empty())
                .then(|| format!("https://github.com/{}.png?size=40", p.author.login));
            PullRequest {
                number: p.number,
                title: p.title,
                url: p.url,
                branch: p.head_ref_name,
                draft: p.is_draft,
                author: p.author.login.clone(),
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

fn list_gitlab(dir: &Path) -> AppResult<Vec<PullRequest>> {
    let out = run_cli(dir, &["glab", "mr", "list", "--output", "json"])?;
    let mrs: Vec<GlMr> = serde_json::from_str(&out)
        .map_err(|e| AppError::Msg(format!("could not parse `glab mr list` output: {e}")))?;
    Ok(mrs
        .into_iter()
        .map(|m| PullRequest {
            number: m.iid,
            title: m.title,
            url: m.web_url,
            branch: m.source_branch,
            draft: m.draft || m.work_in_progress,
            author: m.author.username,
            author_avatar: None, // glab doesn't hand out an avatar URL in list output
            checks: "none".into(),
            review: "none".into(),
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
}
