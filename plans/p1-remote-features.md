# Plan: P1 Remote & Publishing Features (Clone, Remote Management, Push Tags)

> Phased, self-contained implementation plan for GitChef. Each phase is executable in a fresh chat context and cites exact `file:line` patterns to **copy**, not transform. Verify with the checklists; do not invent APIs.

## Overview

Three related features, all requiring **new** backend + frontend wiring (confirmed absent by grep):

1. **Clone a repo** - Home only has "Open"; no clone command exists.
2. **Remote management** - add / remove / rename / set-url / list. Today `repo.rs` only reads remotes internally; the section menu offers "Fetch all" only.
3. **Push tags** - `push_inner` never pushes tags; `create_tag_at`/`delete_tag` are local-only; no remote tag push/delete.

Feature independence (do phases in order; each verifies standalone):
- Backend: Phase 1 (remotes, offline) - Phase 2 (clone, network) - Phase 3 (tag push, network)
- Frontend: Phase 4 (types+api) - Phase 5 (clone UI) - Phase 6 (remotes UI) - Phase 7 (tag push UI)
- Phase 8: full verification.

---

## Phase 0: Documentation Discovery (Allowed APIs & Patterns)

Consolidated from source reads (verbatim, sourced). **These are the ONLY patterns to follow.**

### Backend command pattern (`src-tauri/src/lib.rs`)
- Repo opener: `fn open(path:&str)->AppResult<Repository> { Ok(Repository::open(path)?) }` (lib.rs:15-17).
- Simple delegating command: `#[tauri::command] fn delete_tag(repo:String,name:String)->AppResult<String> { branch::delete_tag(&open(&repo)?, &name) }` (lib.rs:312-315).
- Command with `Option` arg: `create_tag_at` (lib.rs:300-310).
- **Async network** command (worker thread, comment lib.rs:186-188): `#[tauri::command(async)] fn push(repo:String)->AppResult<String> { ops::push(&open(&repo)?) }` (lib.rs:189-192); `fetch` (204-207); `pull` (199-202).
- **Registration is mandatory**: every command name is listed one-per-line in `tauri::generate_handler![ ... ]` (lib.rs:524-597). A command not listed is unreachable.
- Module import: `use git::{...}` (lib.rs:6-9) must include any new module (e.g. `remotes`).

### Shell-out primitives (`src-tauri/src/git/mod.rs`)
- `pub fn run_git(dir:&Path, args:&[&str])->AppResult<String>` - runs `Command::new("git").current_dir(dir).args(args)`; errs on non-zero with `git <args>: <stderr>`. **Only needs an existing cwd, not a repo.**
- `pub fn workdir(repo:&Repository)->AppResult<&Path>` - the repo's working dir.
- `pub mod ...;` declarations at mod.rs:1-14 - add `pub mod remotes;` if creating `git/remotes.rs`.
- Because `args:&[&str]`, bind any `format!()` string to a `let` var first (see `push_inner`).

### Network ops (`src-tauri/src/git/ops.rs`)
- `push_inner(repo, force)` builds `vec!["push"]`, optionally `--force-with-lease`, optionally `["-u","origin","HEAD"]`, then `run_git(dir, &args)`. **No `--tags` anywhere - tag-push gap confirmed.**
- `fetch` = `run_git(workdir(repo)?, &["fetch","--all","--prune"])`.
- imports: `use super::{literal, run_git, sequencer, workdir}; use crate::git::repo;`

### Offline mutation templates (`src-tauri/src/git/branch.rs`)
- CLI style: `rename_branch` = `run_git(workdir(repo)?, &["branch","-m",old,new])`; `delete_branch` picks a flag then `run_git`.
- libgit2 style: `create_tag_at` uses `repo.revparse_single(sha)?.peel(...)?` + `repo.tag(...)`/`repo.tag_lightweight(...)`. `delete_tag` = `run_git(workdir(repo)?, &["tag","-d",name])` (local only).
- imports: `use super::{run_git, workdir}; use crate::error::{AppError, AppResult}; use git2::{...};`

### Remote read helpers today (`src-tauri/src/git/repo.rs`)
- `primary_remote_url` (repo.rs:209-220) already uses `repo.find_remote("origin")`, `remote.url()`, `repo.remotes()`. **No mutation, no list command exists.**

### git2 0.20.4 remote API (VERIFIED verbatim, `~/.cargo/.../git2-0.20.4/src/repo.rs`)
- `pub fn remotes(&self) -> Result<StringArray, Error>` (:589)
- `pub fn find_remote(&self, name:&str) -> Result<Remote, Error>` (:601); `Remote::url() -> Option<&str>` (used already), `Remote::pushurl() -> Option<&str>`.
- `pub fn remote(&self, name:&str, url:&str) -> Result<Remote, Error>` (:612) - **add** (installs default fetch refspec).
- `pub fn remote_rename(&self, name:&str, new_name:&str) -> Result<StringArray, Error>` (:669) - **rename** (returns non-default refspecs it could not move; safe to ignore).
- `pub fn remote_delete(&self, name:&str) -> Result<(), Error>` (:691) - **remove**.
- `pub fn remote_set_url(&self, name:&str, url:&str) -> Result<(), Error>` (:730) - **set fetch url**.
- These are **config-only edits (no transport)** -> use git2 directly, in a **non-async** command.

### Error type (`src-tauri/src/error.rs`)
- `pub enum AppError { Git(#[from] git2::Error), Io(#[from] std::io::Error), Msg(String) }`; `pub type AppResult<T> = Result<T, AppError>;`; serializes to a plain string. Use `AppError::Msg("...".into())` for custom errors; `?` auto-converts.

### Frontend contract (`src/api.ts`, `src/App.tsx`, components)
- API wrapper = one-line `export const name = (args) => invoke<T>("snake_cmd", { camelArgs })` appended after `openDifftool` (api.ts:283-284). Tauri auto-maps camelCase<->snake_case. `import type {...}` block at api.ts:3-24. Void/value/nullable variants: `checkout` (void), `push` (string), `reflog`/`fileBlame` (`x ?? null`).
- Folder picker: `pickRepoFolder(title?)` wraps `open({directory:true,multiple:false,title})` (api.ts:26-35).
- **Open a path as a tab**: `openTab(path)` (App.tsx:65-72) - dedupes + focuses. `pickAndOpen` (App.tsx:74-77) = pick then openTab. Home wired at App.tsx ~200-205; RepoView gets `onOpenPath={openTab}`.
- Modal template (multi-field): `CreatePrModal.tsx` - `.modal-overlay`/`.modal`/`.modal-actions`/`.primary-btn`, `stopPropagation` on inner div, Escape-to-close, controlled `useState`, disabled submit until valid. Gated by parent `{prOpen && <CreatePrModal .../>}` (RepoView.tsx:2232-2240).
- Single-field dialog: `askName(title, placeholder, onSubmit, opts?: {initial?, cta?})` (RepoView.tsx:158-163) -> `NamePromptModal` (RepoView.tsx:2344-2388). Usage: rename branch (RepoView.tsx ~1379). Pick-dir-then-name sequence: `addWorktreeFlow` (RepoView.tsx:1529-1545).
- Action bus (RepoView, from `repoContext.tsx`): `run(fn, action?)` (RepoView.tsx:352-378) = mutex + `catch -> notify(err,true)`; `notify(msg, error?)` (210-219); `load(fn)` (386-389) for reads; `refresh(opts?)`. Copy-ready mutating action shape: `run(async () => { const out = await api.X(...); await refresh(); notify(out.trim() || "..."); })`.
- Clone is **App-level** (no repo open): use `openTab` + `pickRepoFolder` directly, NOT the repo bus; give the Clone modal its own local error/toast.

### Sidebar + menus (`src/components/Sidebar.tsx`, `RepoView.tsx`)
- Section template = Tags `<Group>` (Sidebar.tsx ~256-278) / Stashes `<Group>` (~362-383): `<Group title icon count open onToggle onMenu?>` + empty-hint + `.map` rows with `onClick`/`onContextMenu`. `Group` def ~386-434. Open-state keys via `getSidebarGroups/setSidebarGroups` (src/storage.ts) + `toggle(key)` (Sidebar.tsx ~108-115).
- **The existing "Remote" group (Sidebar.tsx ~231-249) is remote-tracking BRANCHES (`branches.filter(is_remote)`), NOT named remotes.** A new "Remotes" section is required and distinct.
- Menu builders: imports `import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";` (RepoView.tsx:4). `showSectionMenu` (RepoView.tsx ~1637-1652): local->New branch, remote->"Fetch all" only, tags->New tag. `showTagMenu` (~1613-1634): tag actions incl `deleteTag`. `showBranchMenu` (~1275-1442): richest - conditional spreads `...(cond ? [...] : [])`, `PredefinedMenuItem.new({item:"Separator"})`, `Submenu.new({text, items: await Promise.all([...])})`, `askName(..., {initial, cta})`. Close every menu with `await (await Menu.new({ items })).popup();`.
- Data wiring: `const [tags,setTags]=useState<TagInfo[]>([])` (RepoView.tsx:69), `[stashes,...]` (:72). In `refresh()` (~414-446): `api.listTags` inside the awaited history Promise.all; `api.listStashes(path).then(setStashes).catch(()=>{})` off-path (~440). Passed to `<Sidebar tags={tags} stashes={stashes} onTagMenu={showTagMenu} onSectionMenu={showSectionMenu} .../>` (~1939-1961).
- Types: `TagInfo { name; target }` (types.ts ~110-113). **No `RemoteInfo` type exists.** Header note (types.ts:1): types mirror the Rust serde structs field-for-field.
- Icons: `RemoteIcon`/`TagIcon` (icons.tsx). RemoteIcon is already used by the branch "Remote" group; a distinct glyph disambiguates the new section (optional).

### ANTI-PATTERNS (do NOT do)
- ❌ `git2` for **network** (clone/push): `git2 = { default-features=false }` (Cargo.toml:24) strips ssh/https transports. Shell out via `run_git`.
- ❌ Giving `clone_repo` a `repo` param or calling `open()` - no repo exists pre-clone.
- ❌ Making the remote add/remove/rename/set-url commands `async` or shelling out - they are instant offline config edits; use git2 directly, non-async.
- ❌ Forgetting to register a command in `generate_handler!` (lib.rs:524-597) - it becomes unreachable.
- ❌ A TS `RemoteInfo` that does not match the Rust serde struct field-for-field.
- ❌ Putting a `format!()` result directly into a `&[&str]` - bind to a `let` first.
- ❌ Reusing/altering the existing "Remote" (branches) sidebar group for named remotes.

---

## Phase 1: Backend - Remote management (offline)

**What to implement (COPY the libgit2 offline style):** a new `src-tauri/src/git/remotes.rs` module with:
- `#[derive(Serialize)] pub struct RemoteInfo { pub name: String, pub url: String }` (mirror `TagInfo`, branch.rs / types.ts).
- `pub fn list(repo:&Repository)->AppResult<Vec<RemoteInfo>>` - iterate `repo.remotes()?.iter().flatten()`, `repo.find_remote(name)?`, collect `{ name, url: remote.url().unwrap_or_default().to_string() }` (copy read pattern from `primary_remote_url`, repo.rs:209-220).
- `pub fn add(repo, name, url)->AppResult<()>` = `repo.remote(name, url)?; Ok(())` (git2 :612).
- `pub fn remove(repo, name)->AppResult<()>` = `repo.remote_delete(name)?; Ok(())` (:691).
- `pub fn rename(repo, old, new)->AppResult<()>` = `repo.remote_rename(old, new)?; Ok(())` (ignore the returned `StringArray`) (:669).
- `pub fn set_url(repo, name, url)->AppResult<()>` = `repo.remote_set_url(name, url)?; Ok(())` (:730).

Then in `lib.rs`: add `pub mod remotes;` to `git/mod.rs:1-14`, add `remotes` to `use git::{...}` (lib.rs:6-9), and add **non-async** command wrappers copying `delete_tag` (lib.rs:312-315):
- `list_remotes(repo)->AppResult<Vec<RemoteInfo>>`, `add_remote(repo,name,url)->AppResult<()>`, `remove_remote(repo,name)->AppResult<()>`, `rename_remote(repo,old_name,new_name)->AppResult<()>`, `set_remote_url(repo,name,url)->AppResult<()>`.
- Register all five names in `generate_handler!` (lib.rs:524-597), near the other repo ops.

**Doc references:** repo.rs:209-220 (remote read); branch.rs `create_tag_at`/`delete_tag` (mutation style + serde struct); git2 0.20.4 repo.rs :589/:601/:612/:669/:691/:730; error.rs.

**Verification checklist:**
- [ ] `cd src-tauri && cargo check` compiles.
- [ ] `grep -n "remotes" src-tauri/src/git/mod.rs` shows `pub mod remotes;`.
- [ ] `grep -nE "list_remotes|add_remote|remove_remote|rename_remote|set_remote_url" src-tauri/src/lib.rs` shows both the fn defs AND the `generate_handler!` entries (5 each = 10 hits region).
- [ ] Add a `#[cfg(test)]` test in remotes.rs (copy the `init` helper from branch.rs tests): add a remote, `list` returns it; rename; set_url; remove -> `list` empty. `cargo test --lib remotes`.

**Anti-pattern guards:** commands are **non-async** (offline). Do NOT `run_git` here. Do NOT forget `pub mod remotes;` + the `use git::{...}` entry.

---

## Phase 2: Backend - Clone (network, shell-out, no repo)

**What to implement (COPY `fetch`, but with NO repo/open):**
- In `src-tauri/src/git/ops.rs`: `pub fn clone(url:&str, dest:&str)->AppResult<String> { let parent = std::path::Path::new(dest).parent().ok_or_else(|| AppError::Msg("invalid destination".into()))?; run_git(parent, &["clone", url, dest])?; Ok(dest.to_string()) }` (returns `dest` so the frontend can open it). Ensure `AppError` is imported in ops.rs (add if missing).
- In `lib.rs`: `#[tauri::command(async)] fn clone_repo(url:String, dest:String)->AppResult<String> { ops::clone(&url, &dest) }` (copy `push` lib.rs:189-192 but **omit `repo`/`open`**). Register `clone_repo` in `generate_handler!` near `fetch,`.

**Doc references:** ops.rs `fetch`/`push_inner` (run_git usage); mod.rs `run_git` (needs only a cwd); Cargo.toml:24 (why shell-out).

**Verification checklist:**
- [ ] `cargo check` compiles.
- [ ] `grep -n "clone_repo" src-tauri/src/lib.rs` shows the fn AND the registration.
- [ ] Manual (Tauri app): clone a small public repo into an empty parent folder; confirm it appears and opens.

**Anti-pattern guards:** NO `git2::Repository::clone` (transport stripped). `clone_repo` takes NO `repo` param and does NOT call `open()`. Parent dir must already exist (the picked folder); `git clone` creates `dest`.

---

## Phase 3: Backend - Push tags / delete remote tag (network, shell-out)

**What to implement (COPY `push_inner`'s run_git style):** in `src-tauri/src/git/ops.rs`:
- `pub fn push_tags(repo:&Repository, remote:&str)->AppResult<String> { run_git(workdir(repo)?, &["push", remote, "--tags"]) }`
- `pub fn push_tag(repo:&Repository, remote:&str, name:&str)->AppResult<String> { run_git(workdir(repo)?, &["push", remote, "tag", name]) }`
- `pub fn delete_remote_tag(repo:&Repository, remote:&str, name:&str)->AppResult<String> { let refspec = format!("refs/tags/{name}"); run_git(workdir(repo)?, &["push", remote, "--delete", &refspec]) }` (bind `refspec` first).

In `lib.rs` (copy `push` lib.rs:189-192, async):
- `#[tauri::command(async)] fn push_tags(repo:String, remote:String)->AppResult<String>`
- `#[tauri::command(async)] fn push_tag(repo:String, remote:String, name:String)->AppResult<String>`
- `#[tauri::command(async)] fn delete_remote_tag(repo:String, remote:String, name:String)->AppResult<String>`
- Register all three in `generate_handler!` near `push_force,`.

**Doc references:** ops.rs `push_inner`/`fetch`; branch.rs `delete_tag` (local, stays as-is).

**Verification checklist:**
- [ ] `cargo check` compiles.
- [ ] `grep -nE "push_tags|push_tag|delete_remote_tag" src-tauri/src/lib.rs` shows defs + registrations.
- [ ] Manual (Tauri app): create a local tag, push it, verify on remote; delete on remote.

**Anti-pattern guards:** shell-out only (network). Bind `format!()` to a `let` before the `&[&str]`. `remote` is explicit (no implicit origin here) - the frontend supplies it.

---

## Phase 4: Frontend - Types + API wrappers

**What to implement (COPY api.ts one-liner shape):**
- `src/types.ts`: add `export interface RemoteInfo { name: string; url: string; }` (mirror the Rust struct exactly). Add `RemoteInfo` to the `import type {...}` in api.ts:3-24.
- `src/api.ts` (append after `openDifftool`, line 283-284):
  - `export const cloneRepo = (url: string, dest: string) => invoke<string>("clone_repo", { url, dest });`
  - `export const listRemotes = (repo: string) => invoke<RemoteInfo[]>("list_remotes", { repo });`
  - `export const addRemote = (repo: string, name: string, url: string) => invoke<void>("add_remote", { repo, name, url });`
  - `export const removeRemote = (repo: string, name: string) => invoke<void>("remove_remote", { repo, name });`
  - `export const renameRemote = (repo: string, oldName: string, newName: string) => invoke<void>("rename_remote", { repo, oldName, newName });`
  - `export const setRemoteUrl = (repo: string, name: string, url: string) => invoke<void>("set_remote_url", { repo, name, url });`
  - `export const pushTags = (repo: string, remote: string) => invoke<string>("push_tags", { repo, remote });`
  - `export const pushTag = (repo: string, remote: string, name: string) => invoke<string>("push_tag", { repo, remote, name });`
  - `export const deleteRemoteTag = (repo: string, remote: string, name: string) => invoke<string>("delete_remote_tag", { repo, remote, name });`

**Doc references:** api.ts:26-35 (shape), :3-24 (imports), existing `push`/`checkout`/`deleteTag`/`reflog`; types.ts ~110-113 (`TagInfo`).

**Verification checklist:**
- [ ] `npx tsc -b` compiles.
- [ ] Each wrapper's invoke string exactly matches a registered command name from Phases 1-3.

**Anti-pattern guards:** camelCase arg keys (auto-mapped); `RemoteInfo` fields match the Rust struct.

---

## Phase 5: Frontend - Clone UI (App-level)

**What to implement:**
- `src/components/Home.tsx`: add `onClone: () => void` to Props; render a second `.primary-btn` "Clone a repository" beside the existing "Open a repository" button (Home.tsx ~40-42).
- New `src/components/CloneModal.tsx` (COPY `CreatePrModal.tsx` structure): fields = URL `<input autoFocus>`, a destination-parent row (readonly input + "Browse..." button calling `api.pickRepoFolder("Choose where to clone")`), and a derived/editable folder name (default = last URL path segment with `.git` stripped). Submit disabled until URL + parent set. On submit: compute `dest = parent + "/" + folder`, call `props.onSubmit(url, dest)`. Local error state (NOT the repo bus). `.modal-overlay`/`.modal`/`.modal-actions`/`.primary-btn`, stopPropagation, Escape-to-close.
- `src/App.tsx`: `const [cloneOpen, setCloneOpen] = useState(false)`; pass `onClone={() => setCloneOpen(true)}` to Home; render `{cloneOpen && <CloneModal onClose={() => setCloneOpen(false)} onSubmit={async (url, dest) => { try { const dir = await api.cloneRepo(url, dest); openTab(dir); } catch (e) { /* show error in modal/toast */ } }} />}`. `openTab` (App.tsx:65-72) turns the cloned path into a focused tab; `onRepoLoaded` refines the label + adds to recents.

**Doc references:** CreatePrModal.tsx (full); App.tsx:65-77 (openTab/pickAndOpen), ~200-205 (Home wiring); api.ts:26-35 (pickRepoFolder); addWorktreeFlow RepoView.tsx:1529-1545 (pick-dir sequence).

**Verification checklist:**
- [ ] `npx tsc -b` + `npx vite build` compile.
- [ ] `npx vitest run` still green.
- [ ] Manual (Tauri app): Home shows "Clone"; clone a repo -> new focused tab loads it.

**Anti-pattern guards:** Clone is App-level - do NOT route through `useRepo()`/repo bus (no repo yet). Surface clone errors locally.

---

## Phase 6: Frontend - Remotes sidebar section + CRUD menu

**What to implement:**
- `src/storage.ts`: add a `remotes` boolean key to the `SidebarGroups` shape used by `getSidebarGroups/setSidebarGroups` (default open or closed). (Read the file first to match the exact shape.)
- `src/components/Sidebar.tsx`: add `remotes: RemoteInfo[]` and `onRemoteMenu: (r: RemoteInfo) => void` to Props (48-77); import `RemoteInfo`. Add a new `<Group title="Remotes" icon={<RemoteIcon />} count={remotes.length} open={open.remotes} onToggle={() => toggle("remotes")} onMenu={() => onSectionMenu("remotes")}>` (COPY Tags/Stashes group, ~256-278/~362-383) with empty-hint and `remotes.map` rows: `<div key={r.name} className="branch-row" title={r.url} onContextMenu={(e) => { e.preventDefault(); onRemoteMenu(r); }}><span className="branch-name">{r.name}</span></div>`. Keep it distinct from the existing branch "Remote" group.
- `src/components/RepoView.tsx`:
  - `const [remotes, setRemotes] = useState<RemoteInfo[]>([]);` (beside :69/:72).
  - In `refresh()` (~414-446) off-path block (next to `listStashes`, ~440): `api.listRemotes(path).then(setRemotes).catch(() => {});`
  - New `showRemoteMenu(r: RemoteInfo)` (COPY `showTagMenu` + `showBranchMenu` rename pattern): items = `Rename ${r.name}...` (`askName("Rename remote","remote-name",(n)=>run(async()=>{await api.renameRemote(path,r.name,n);await refresh();notify(...)}),{initial:r.name,cta:"Rename"})`), `Set URL...` (`askName("Remote URL","https://...",(u)=>run(...api.setRemoteUrl...),{initial:r.url,cta:"Save"})`), Separator, `Delete ${r.name}` (`confirm(...)` then `run(...api.removeRemote...)`, copy `deleteBranch` confirm at RepoView.tsx:2). Close with `await (await Menu.new({ items })).popup();`.
  - Extend `showSectionMenu` "remote" branch (~1641-1642) with `MenuItem.new({ text: "Add remote...", action: () => askName("Remote name","origin",(name)=>askName("Remote URL","https://...",(url)=>run(async()=>{await api.addRemote(path,name,url);await refresh();notify(`Added remote ${name}`);}),{cta:"Add"}),{cta:"Next"}) })` beside "Fetch all". Widen the `section` param type to include `"remotes"` if you also wire the new section header's `onMenu`.
  - Pass `remotes={remotes}` and `onRemoteMenu={showRemoteMenu}` on `<Sidebar/>` (~1939-1961).

**Doc references:** Sidebar.tsx ~256-278/~362-383/~386-434/~108-115; RepoView.tsx :69/:72/~414-446/~1613-1652/~1275-1442/~1939-1961; storage.ts (SidebarGroups); icons.tsx (RemoteIcon).

**Verification checklist:**
- [ ] `npx tsc -b` + `npx vite build` compile; `npx vitest run` green.
- [ ] Manual (Tauri app): Remotes section lists `origin`; add/rename/set-url/remove work and the list refreshes.

**Anti-pattern guards:** new section is **named remotes**, not the branch "Remote" group. Destructive remove uses `confirm(...)`. Mutations go through `run()`.

---

## Phase 7: Frontend - Tag push / remote-delete menu

**What to implement (COPY `showTagMenu` + tag action fns):** in `src/components/RepoView.tsx`, extend `showTagMenu` (~1613-1634). Using the loaded `remotes` list:
- If exactly one remote: `MenuItem.new({ text: `Push ${name} to ${remote.name}`, action: () => run(async () => { const out = await api.pushTag(path, remote.name, name); await refresh(); notify(out.trim() || `Pushed ${name}`); }) })` and a `Delete ${name} on ${remote.name}` item (`confirm` then `api.deleteRemoteTag`).
- If multiple remotes: `Submenu.new({ text: "Push tag to...", items: await Promise.all(remotes.map(r => MenuItem.new({ text: r.name, action: () => run(...pushTag...) }))) })` (COPY the Reset submenu shape in showBranchMenu ~1366-1373), and a matching "Delete tag on remote..." submenu.
- Optional: after `create_tag_at` succeeds (existing `tagAt`, RepoView.tsx ~1159-1164), offer a follow-up push; keep minimal for v1.

**Doc references:** RepoView.tsx ~1613-1634 (showTagMenu), ~1366-1373 (Submenu), ~1159-1164 (tagAt), :2 (confirm import); api wrappers from Phase 4.

**Verification checklist:**
- [ ] `npx tsc -b` + `npx vite build` compile; `npx vitest run` green.
- [ ] Manual (Tauri app): right-click a tag -> Push / Delete-on-remote; verify against the remote.

**Anti-pattern guards:** pass `remote` explicitly (no implicit origin). Mutations via `run()`; destructive via `confirm()`.

---

## Phase 8: Verification (final)

1. **Compile & test both sides:**
   - Frontend: `npx tsc -b` (0 errors), `npx vitest run` (all pass), `npx vite build` (clean).
   - Backend: `cd src-tauri && cargo check` (clean), `cargo test --lib` (all pass, incl. the Phase 1 remotes test).
2. **Contract integrity greps:**
   - Every new command appears BOTH as a `#[tauri::command]` fn AND in `generate_handler!` (lib.rs:524-597): `grep -nE "clone_repo|list_remotes|add_remote|remove_remote|rename_remote|set_remote_url|push_tags|push_tag|delete_remote_tag" src-tauri/src/lib.rs`.
   - Every new api.ts wrapper's invoke string matches a registered command.
3. **Anti-pattern greps:**
   - No git2 network: `grep -rn "Repository::clone\|\.push(" src-tauri/src/git` should show only `run_git`-based network ops (no git2 transport calls).
   - Remote CRUD commands are non-async: confirm no `#[tauri::command(async)]` on `add_remote`/`remove_remote`/`rename_remote`/`set_remote_url`/`list_remotes`.
   - `RemoteInfo` TS fields == Rust struct fields.
4. **Manual smoke (Tauri app - the UI is NOT browser-testable; Tauri-only runtime):** `pnpm tauri dev`, then:
   - Clone a public repo -> opens as a tab.
   - Remotes section lists remotes; add/rename/set-url/remove reflect immediately.
   - Create tag -> push tag -> appears on remote; delete-on-remote removes it.
5. **Commits (jcardonne identity, per repo convention - title-only messages, no body, no push unless asked):** suggest three `feat:` commits (backend remotes+clone+tags; frontend clone; frontend remotes+tags) or one composite - confirm with the user.

---

## Execution notes
- Backend phases (1-3) each end at a green `cargo check`; do them before the frontend so the api.ts invoke strings have real targets.
- Frontend phases (4-7) each end at green `tsc -b` + `vitest` + `vite build`.
- The app cannot be smoke-tested in a plain browser (Tauri runtime APIs throw on mount); rely on compile + unit tests + `renderToStaticMarkup` for pure render logic, and manual `pnpm tauri dev` for interaction.
- Keep new backend commands registered in `generate_handler!` - the single most common miss.
