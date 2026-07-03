mod error;
mod git;

use error::AppResult;
use git::{avatars, branch, conflict, diff, files, graph, ops, rebase, repo, sequencer, worktree};
use git2::Repository;

/// Open a repository by path. The backend holds NO active-repo state: every
/// command receives the repo path it operates on, so multiple tabs can never
/// race over a shared "current repo" (libgit2 open is cheap).
fn open(path: &str) -> AppResult<Repository> {
    Ok(Repository::open(path)?)
}

#[tauri::command]
fn open_repo(path: String) -> AppResult<repo::RepoInfo> {
    repo::info(&open(&path)?)
}

/// Provider account avatars for the given commit emails (GitHub/GitLab), keyed
/// by lowercased email. `(async)` because it does blocking network I/O. Returns
/// only emails that map to a real account; the frontend handles the rest.
#[tauri::command(async)]
fn commit_avatars(
    app: tauri::AppHandle,
    repo: String,
    emails: Vec<String>,
) -> AppResult<std::collections::HashMap<String, String>> {
    avatars::resolve(&app, &repo, emails)
}

// The working-tree reads + bulk index ops below do heavy/blocking libgit2 work
// (full-tree status, the work_stats content diff over every changed file, bulk
// index writes). `(async)` runs the synchronous body on Tauri's async runtime
// (a worker thread) instead of the main thread, so a huge working tree can't
// freeze the UI/IPC. Each body owns its Repository and never awaits, so the
// spawned future is Send.
#[tauri::command(async)]
fn repo_status(repo: String) -> AppResult<repo::StatusResult> {
    repo::status(&open(&repo)?)
}

#[tauri::command(async)]
fn work_stats(repo: String) -> AppResult<repo::WorkStats> {
    repo::work_stats(&open(&repo)?)
}

#[tauri::command(async)]
fn commit_graph(repo: String, limit: Option<usize>) -> AppResult<Vec<graph::CommitNode>> {
    graph::commit_graph(&open(&repo)?, limit.unwrap_or(500))
}

#[tauri::command(async)]
fn reflog(repo: String, limit: Option<usize>) -> AppResult<Vec<graph::ReflogNode>> {
    graph::reflog(&open(&repo)?, limit.unwrap_or(200))
}

#[tauri::command(async)]
fn list_branches(repo: String) -> AppResult<Vec<branch::BranchInfo>> {
    branch::list_branches(&open(&repo)?)
}

#[tauri::command(async)]
fn list_tags(repo: String) -> AppResult<Vec<branch::TagInfo>> {
    branch::list_tags(&open(&repo)?)
}

#[tauri::command(async)]
fn list_stashes(repo: String) -> AppResult<Vec<ops::StashInfo>> {
    ops::list_stashes(&mut open(&repo)?)
}

#[tauri::command(async)]
fn list_worktrees(repo: String) -> AppResult<Vec<worktree::WorktreeInfo>> {
    worktree::list_worktrees(&open(&repo)?)
}

/// Per-worktree uncommitted-changes flags. Async: it opens and status-scans
/// every worktree, so it runs off the main thread and on demand only.
#[tauri::command(async)]
fn worktree_wips(repo: String) -> AppResult<std::collections::HashMap<String, bool>> {
    worktree::worktree_wips(&open(&repo)?)
}

#[tauri::command]
fn add_worktree(repo: String, path: String, branch: String) -> AppResult<String> {
    worktree::add_worktree(&open(&repo)?, &path, &branch)
}

#[tauri::command]
fn file_diff(repo: String, path: String, staged: bool, full: bool) -> AppResult<diff::FileDiff> {
    diff::file_diff(&open(&repo)?, &path, staged, full)
}

#[tauri::command]
fn file_content(
    repo: String,
    path: String,
    rev: Option<String>,
    staged: bool,
    full: bool,
) -> AppResult<diff::FileContent> {
    diff::file_content(&open(&repo)?, &path, rev.as_deref(), staged, full)
}

#[tauri::command]
fn commit_diff(repo: String, id: String) -> AppResult<Vec<diff::FileDiff>> {
    diff::commit_diff(&open(&repo)?, &id)
}

#[tauri::command]
fn diff_commits(repo: String, a: String, b: String) -> AppResult<Vec<diff::FileDiff>> {
    diff::diff_commits(&open(&repo)?, &a, &b)
}

#[tauri::command]
fn commit(repo: String, message: String) -> AppResult<String> {
    ops::commit(&open(&repo)?, &message)
}

#[tauri::command]
fn commit_amend(repo: String, message: String) -> AppResult<String> {
    ops::amend(&open(&repo)?, &message)
}

#[tauri::command]
fn checkout(repo: String, name: String) -> AppResult<()> {
    branch::checkout(&open(&repo)?, &name)
}

#[tauri::command]
fn create_branch(repo: String, name: String, checkout: bool) -> AppResult<()> {
    branch::create_branch(&open(&repo)?, &name, checkout)
}

#[tauri::command]
fn push(repo: String) -> AppResult<String> {
    ops::push(&open(&repo)?)
}

#[tauri::command]
fn push_force(repo: String) -> AppResult<String> {
    ops::push_force(&open(&repo)?)
}

#[tauri::command]
fn pull(repo: String, mode: String) -> AppResult<String> {
    ops::pull(&open(&repo)?, &mode)
}

#[tauri::command]
fn fetch(repo: String) -> AppResult<String> {
    ops::fetch(&open(&repo)?)
}

#[tauri::command]
fn merge(repo: String, branch: String) -> AppResult<String> {
    ops::merge(&open(&repo)?, &branch)
}

#[tauri::command]
fn fast_forward_to(repo: String, branch: String) -> AppResult<String> {
    ops::fast_forward_to(&open(&repo)?, &branch)
}

#[tauri::command]
fn rebase_onto(repo: String, branch: String) -> AppResult<String> {
    ops::rebase_onto(&open(&repo)?, &branch)
}

// --- sequencer (rebase/merge/cherry-pick/revert) + conflict resolution ---

#[tauri::command]
fn sequencer_state(repo: String) -> AppResult<sequencer::SequencerState> {
    sequencer::state(&open(&repo)?)
}

#[tauri::command]
fn sequencer_act(repo: String, action: String) -> AppResult<String> {
    sequencer::act(&open(&repo)?, &action)
}

#[tauri::command(async)]
fn conflict_blocks(repo: String, path: String) -> AppResult<conflict::ConflictFile> {
    conflict::parse(&open(&repo)?, &path)
}

#[tauri::command]
fn resolve_conflict(repo: String, path: String, choices: Vec<String>) -> AppResult<()> {
    conflict::resolve(&open(&repo)?, &path, &choices)
}

#[tauri::command]
fn take_conflict_side(repo: String, path: String, side: String) -> AppResult<()> {
    conflict::take_side(&open(&repo)?, &path, &side)
}

#[tauri::command(async)]
fn rebase_plan(repo: String, base: String) -> AppResult<Vec<rebase::TodoItem>> {
    rebase::plan(&open(&repo)?, &base)
}

#[tauri::command(async)]
fn rebase_interactive(
    repo: String,
    base: String,
    plan: Vec<rebase::TodoItem>,
) -> AppResult<String> {
    rebase::run_interactive(&open(&repo)?, &base, plan)
}

#[tauri::command]
fn rename_branch(repo: String, old_name: String, new_name: String) -> AppResult<String> {
    branch::rename_branch(&open(&repo)?, &old_name, &new_name)
}

#[tauri::command]
fn delete_branch(repo: String, name: String, is_remote: bool, force: bool) -> AppResult<String> {
    branch::delete_branch(&open(&repo)?, &name, is_remote, force)
}

#[tauri::command]
fn set_upstream(repo: String, local: String, upstream: String) -> AppResult<String> {
    branch::set_upstream(&open(&repo)?, &local, &upstream)
}

// --- commit context-menu actions ---

#[tauri::command]
fn create_branch_at(repo: String, name: String, sha: String, checkout: bool) -> AppResult<()> {
    branch::create_branch_at(&open(&repo)?, &name, &sha, checkout)
}

#[tauri::command]
fn create_tag_at(
    repo: String,
    name: String,
    sha: String,
    annotated: bool,
    message: Option<String>,
) -> AppResult<()> {
    branch::create_tag_at(&open(&repo)?, &name, &sha, annotated, message)
}

#[tauri::command]
fn delete_tag(repo: String, name: String) -> AppResult<String> {
    branch::delete_tag(&open(&repo)?, &name)
}

#[tauri::command]
fn cherry_pick(repo: String, sha: String) -> AppResult<String> {
    ops::cherry_pick(&open(&repo)?, &sha)
}

#[tauri::command]
fn revert_commit(repo: String, sha: String) -> AppResult<String> {
    ops::revert_commit(&open(&repo)?, &sha)
}

#[tauri::command]
fn reset_to(repo: String, sha: String, mode: String) -> AppResult<String> {
    ops::reset_to(&open(&repo)?, &sha, &mode)
}

#[tauri::command]
fn save_commit_patch(repo: String, sha: String, dest: String) -> AppResult<()> {
    ops::save_commit_patch(&open(&repo)?, &sha, &dest)
}

#[tauri::command]
fn save_commit_file_patch(repo: String, sha: String, path: String, dest: String) -> AppResult<()> {
    ops::save_commit_file_patch(&open(&repo)?, &sha, &path, &dest)
}

#[tauri::command]
fn compare_workdir(repo: String, sha: String) -> AppResult<Vec<diff::FileDiff>> {
    diff::compare_workdir(&open(&repo)?, &sha)
}

// --- multi-select + file actions ---

#[tauri::command(async)]
fn stage_paths(repo: String, paths: Vec<String>) -> AppResult<()> {
    files::stage_paths(&open(&repo)?, paths)
}

#[tauri::command(async)]
fn unstage_paths(repo: String, paths: Vec<String>) -> AppResult<()> {
    files::unstage_paths(&open(&repo)?, paths)
}

#[tauri::command(async)]
fn discard_paths(repo: String, paths: Vec<String>) -> AppResult<()> {
    files::discard_paths(&open(&repo)?, paths)
}

#[tauri::command]
fn ignore_path(repo: String, pattern: String) -> AppResult<()> {
    files::ignore_path(&open(&repo)?, &pattern)
}

#[tauri::command]
fn stash_file(repo: String, path: String) -> AppResult<String> {
    files::stash_file(&open(&repo)?, &path)
}

#[tauri::command]
fn stash_apply(repo: String, sha: String) -> AppResult<String> {
    ops::stash_apply(&mut open(&repo)?, &sha)
}

#[tauri::command]
fn stash_pop(repo: String, sha: String) -> AppResult<String> {
    ops::stash_pop(&mut open(&repo)?, &sha)
}

#[tauri::command]
fn stash_drop(repo: String, sha: String) -> AppResult<String> {
    ops::stash_drop(&mut open(&repo)?, &sha)
}

#[tauri::command]
fn stash_edit_message(repo: String, sha: String, message: String) -> AppResult<String> {
    ops::stash_edit_message(&mut open(&repo)?, &sha, &message)
}

#[tauri::command]
fn save_patch(repo: String, path: String, dest: String) -> AppResult<()> {
    files::save_patch(&open(&repo)?, &path, &dest)
}

#[tauri::command]
fn delete_file(repo: String, path: String) -> AppResult<()> {
    files::delete_file(&open(&repo)?, &path)
}

#[tauri::command]
fn copy_text(text: String) -> AppResult<()> {
    files::copy_text(&text)
}

#[tauri::command]
fn reveal_in_finder(repo: String, path: String) -> AppResult<()> {
    files::reveal_in_finder(&open(&repo)?, &path)
}

#[tauri::command]
fn open_default(repo: String, path: String) -> AppResult<()> {
    files::open_default(&open(&repo)?, &path)
}

/// Open a repo/commit/branch/file on its GitHub/GitLab web UI in the browser.
#[tauri::command]
fn open_on_web(
    repo: String,
    kind: String,
    reference: Option<String>,
    path: Option<String>,
) -> AppResult<()> {
    let r = open(&repo)?;
    let target = repo::remote_target(&r)
        .ok_or_else(|| error::AppError::Msg("no GitHub/GitLab remote for this repo".into()))?;
    let url = repo::web_url(
        &target,
        &kind,
        reference.as_deref().unwrap_or(""),
        path.as_deref().unwrap_or(""),
    )?;
    files::open_url(&url)
}

#[tauri::command]
fn open_in_editor(repo: String, path: String) -> AppResult<()> {
    files::open_in_editor(&open(&repo)?, &path)
}

#[tauri::command]
fn open_commit_file_in_editor(repo: String, sha: String, path: String) -> AppResult<()> {
    files::open_commit_file_in_editor(&open(&repo)?, &sha, &path)
}

#[tauri::command]
fn open_difftool(repo: String, path: String) -> AppResult<()> {
    files::open_difftool(&open(&repo)?, &path)
}

#[tauri::command]
fn reveal_path(path: String) -> AppResult<()> {
    files::reveal_path(&path)
}

#[tauri::command]
fn open_terminal(path: String) -> AppResult<()> {
    files::open_terminal(&path)
}

#[tauri::command]
fn stash_all(repo: String) -> AppResult<String> {
    ops::stash_all(&open(&repo)?)
}

#[tauri::command]
fn apply_hunk(repo: String, path: String, action: String, hunk_header: String) -> AppResult<()> {
    files::apply_hunk(&open(&repo)?, &path, &action, &hunk_header)
}

#[tauri::command]
fn apply_lines(
    repo: String,
    path: String,
    action: String,
    hunk_header: String,
    selected: Vec<String>,
) -> AppResult<()> {
    files::apply_lines(&open(&repo)?, &path, &action, &hunk_header, selected)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // During an interactive rebase, git re-launches THIS binary as its sequence
    // editor (to inject the todo) and as the `exec` reword hook. Handle those
    // invocations and exit before booting Tauri - they must never open a window.
    if rebase::run_cli_hook() {
        return;
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    // macOS binds Cmd+W to the default Window menu's "Close Window". Replace the
    // menu with just App + Edit (no Window menu) so Cmd+W is free for the JS
    // tab-close shortcut, while keeping Quit and copy/paste/undo working.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|handle| {
        use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
        let app = Submenu::with_items(handle, "GitChef", true, &[
            &PredefinedMenuItem::quit(handle, None)?,
        ])?;
        let edit = Submenu::with_items(handle, "Edit", true, &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ])?;
        Menu::with_items(handle, &[&app, &edit])
    });

    builder
        .invoke_handler(tauri::generate_handler![
            open_repo,
            commit_avatars,
            repo_status,
            work_stats,
            commit_graph,
            list_branches,
            list_tags,
            file_diff,
            file_content,
            commit_diff,
            diff_commits,
            reflog,
            commit,
            commit_amend,
            checkout,
            create_branch,
            push,
            push_force,
            pull,
            fetch,
            merge,
            fast_forward_to,
            rebase_onto,
            sequencer_state,
            sequencer_act,
            conflict_blocks,
            resolve_conflict,
            take_conflict_side,
            rebase_plan,
            rebase_interactive,
            rename_branch,
            delete_branch,
            set_upstream,
            create_branch_at,
            create_tag_at,
            delete_tag,
            cherry_pick,
            revert_commit,
            reset_to,
            save_commit_patch,
            compare_workdir,
            stage_paths,
            unstage_paths,
            discard_paths,
            ignore_path,
            stash_file,
            stash_apply,
            stash_pop,
            stash_drop,
            stash_edit_message,
            save_patch,
            delete_file,
            copy_text,
            reveal_in_finder,
            open_default,
            open_on_web,
            open_in_editor,
            open_commit_file_in_editor,
            open_difftool,
            reveal_path,
            stash_all,
            apply_hunk,
            apply_lines,
            save_commit_file_patch,
            open_terminal,
            list_stashes,
            list_worktrees,
            worktree_wips,
            add_worktree,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitChef");
}
