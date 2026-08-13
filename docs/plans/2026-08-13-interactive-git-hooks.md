# Interactive Git Hook Output Implementation Plan

> **For GitChef:** Implement task-by-task, keeping commit/push behavior unchanged except for observable output.

**Goal:** Make commit, amend, and push hook output visible in GitChef while the Git process is running, without bypassing hooks or falsely reporting success.

**Architecture:** Keep Git as the source of truth and retain the existing `git commit`/`git push` commands. Add a streaming subprocess path for user-facing operations, emit scoped Tauri events for stdout/stderr, and render a bounded, dismissible console panel in the active repository tab. Hook failures remain rejected IPC calls and continue to appear as error notifications.

**Tech Stack:** Rust/Tauri 2, `std::process`, Tauri events, React/TypeScript, Vitest/Rust tests.

## Acceptance criteria

- `pre-commit`, `commit-msg`, and `pre-push` are not bypassed.
- stdout and stderr are visible while commit/amend/push is running.
- Output is scoped to the repository tab that started the operation.
- Non-zero Git/hook exit prevents success notifications and preserves the error toast.
- Output is bounded in memory and can be dismissed.
- Interactive hooks are explicitly documented as not fully supported until a PTY/input design is implemented.
- Existing non-hook Git operations keep their current behavior.

## Tasks

1. Add a streaming Git runner that captures stdout/stderr concurrently and emits `git-output` events with repository, stream, and text fields.
2. Route commit, amend, push, and force-push through the streaming runner while keeping the existing command arguments and exit-code handling.
3. Subscribe the active `RepoView` to scoped output events and retain only the most recent 500 lines.
4. Render a dismissible output panel with separate stderr styling and an in-progress action label.
5. Add backend tests for hook success/failure and output propagation using temporary repositories; add frontend tests for event scoping and bounded output where the existing test harness permits.
6. Run formatting, Rust tests, TypeScript build, Vitest, and a disposable-hook manual smoke test on a machine with Rust/pnpm available.
7. Open a focused PR documenting supported non-interactive hooks, the current interactive-hook limitation, test results, and follow-up PTY work.

## Follow-up: true interactive hooks

A later PR should replace pipe-based capture with a platform-aware PTY or explicit terminal dialog. It must provide input forwarding, cancellation/termination, terminal resize handling, and safe environment/credential behavior. Do not claim that a pipe-backed subprocess supports prompts merely because stdin is inherited.
