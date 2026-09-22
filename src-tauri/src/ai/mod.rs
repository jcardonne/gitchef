pub mod client;
pub mod diff_filter;
pub mod embedded;
pub mod prompts;

pub use client::{AiConfig, AiStatus, GeneratedCommit, GeneratedPr};

use crate::error::{AppError, AppResult};
use crate::git::diff;
use git2::{Repository, Sort};
use tauri::AppHandle;

/// Generates a Conventional Commit message from staged changes (or unstaged changes if
/// staged_only is false and nothing is staged).
pub fn generate_commit(
    app: &AppHandle,
    repo: &Repository,
    staged_only: bool,
    config: &AiConfig,
) -> AppResult<GeneratedCommit> {
    let mut files = diff::staged_diff(repo)?;
    if files.is_empty() {
        if !staged_only {
            // For amend with no staged files, inspect the HEAD commit being amended
            if let Ok(head) = repo.head() {
                if let Ok(commit) = head.peel_to_commit() {
                    files = diff::commit_diff(repo, &commit.id().to_string()).unwrap_or_default();
                }
            }
        }
        if files.is_empty() {
            return Err(AppError::Msg(
                "No staged changes found. Please stage files first to generate a commit message.".into(),
            ));
        }
    }

    let diff_summary = diff_filter::prepare_diff_for_llm(&files);
    let user_prompt = prompts::build_commit_user_prompt(&diff_summary);
    let system_prompt = prompts::build_commit_system_prompt(config.commit_style.as_deref());

    let raw_response = client::generate_chat(app, config, &system_prompt, &user_prompt)?;
    Ok(client::parse_commit_message(&raw_response))
}

/// Generates a Pull Request title and description between base and head refs.
pub fn generate_pr(
    app: &AppHandle,
    repo: &Repository,
    base: &str,
    head: &str,
    config: &AiConfig,
) -> AppResult<GeneratedPr> {
    let base_obj = repo
        .revparse_single(base)
        .map_err(|e| AppError::Msg(format!("Could not resolve base ref '{base}': {e}")))?;
    let head_obj = repo
        .revparse_single(head)
        .map_err(|e| AppError::Msg(format!("Could not resolve head ref '{head}': {e}")))?;

    let base_commit = base_obj
        .peel_to_commit()
        .map_err(|e| AppError::Msg(format!("Base ref '{base}' is not a commit: {e}")))?;
    let head_commit = head_obj
        .peel_to_commit()
        .map_err(|e| AppError::Msg(format!("Head ref '{head}' is not a commit: {e}")))?;

    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    walk.push(head_commit.id())?;
    let _ = walk.hide(base_commit.id());

    let mut commit_summaries = Vec::new();
    for oid in walk {
        if let Ok(oid) = oid {
            if let Ok(commit) = repo.find_commit(oid) {
                if let Some(summary) = commit.summary() {
                    commit_summaries.push(summary.to_string());
                }
            }
        }
        if commit_summaries.len() >= 30 {
            break;
        }
    }

    let base_tree = base_commit.tree()?;
    let head_tree = head_commit.tree()?;
    let mut opts = git2::DiffOptions::new();
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;
    let files = diff::diff_to_files(&diff, 3000)?;

    let diff_summary = diff_filter::prepare_diff_for_llm(&files);
    let user_prompt = prompts::build_pr_user_prompt(base, head, &commit_summaries, &diff_summary);

    let raw_response = client::generate_chat(app, config, prompts::PR_SYSTEM_PROMPT, &user_prompt)?;
    Ok(client::parse_pr_response(&raw_response))
}

/// Explains a merge conflict between ours and theirs.
pub fn explain_conflict(
    app: &AppHandle,
    _repo: &Repository,
    file_path: &str,
    ours: &str,
    theirs: &str,
    config: &AiConfig,
) -> AppResult<String> {
    let user_prompt = prompts::build_conflict_user_prompt(file_path, ours, theirs);
    client::generate_chat(app, config, prompts::CONFLICT_SYSTEM_PROMPT, &user_prompt)
}
