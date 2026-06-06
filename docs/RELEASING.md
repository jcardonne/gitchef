# Releasing GitChef (auto-updates via Cloudflare R2)

GitChef ships silent auto-updates. On launch the app fetches `latest.json` from a
Cloudflare R2 bucket; if a newer **signed** build exists it downloads, installs,
and relaunches into the new version. Failures (offline, bad signature) are
swallowed - a missed update never blocks the app.

The update signature is [minisign](https://jedisct1.github.io/minisign/) (Tauri's
own integrity check), independent of any OS code-signing.

---

## One-time setup

### 1. Signing keypair (already generated)

A keypair was generated at `~/.tauri/gitchef.key` (private) and
`~/.tauri/gitchef.key.pub` (public). The **public** key is already baked into
`src-tauri/tauri.conf.json` under `plugins.updater.pubkey`.

> Keep `~/.tauri/gitchef.key` safe and backed up. Lose it and you can never sign
> an update again - users would be stranded on their current version.

The key currently has **no password**. The private key becomes a GitHub secret;
anyone who reads that secret can sign updates that every client installs silently.
For a stronger posture, regenerate with a passphrase and store it in
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` so a secret-store leak yields only an
encrypted blob:

```sh
pnpm tauri signer generate -w ~/.tauri/gitchef.key -f   # prompts for a password
```

Then update `plugins.updater.pubkey` with the new `~/.tauri/gitchef.key.pub`.

### 2. Cloudflare R2 bucket (all via wrangler CLI)

Authenticate once - either:

```sh
wrangler login                      # interactive browser OAuth
# or
export CLOUDFLARE_API_TOKEN=...     # token with R2 read/write
```

Then create the bucket + enable its public URL:

```sh
./scripts/r2-setup.sh               # default bucket: gitchef-updates
```

The script prints the public base, e.g. `https://pub-<hash>.r2.dev`. Copy it.

### 3. GitHub repo secrets + variables

Settings -> Secrets and variables -> Actions.

**Secrets:**

| Name | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | full contents of `~/.tauri/gitchef.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the key's passphrase (empty if you kept it password-less) |
| `CLOUDFLARE_API_TOKEN` | a Cloudflare token with **R2 read/write** on the bucket |

**Variables:**

| Name | Value |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_BUCKET` | bucket name, e.g. `gitchef-updates` |
| `R2_PUBLIC_URL` | the r2.dev base, e.g. `https://pub-<hash>.r2.dev` (no trailing slash) |

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/gitchef.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body ""   # or your passphrase
gh secret set CLOUDFLARE_API_TOKEN --body "<token>"
gh variable set R2_ACCOUNT_ID --body "<account-id>"
gh variable set R2_BUCKET --body "gitchef-updates"
gh variable set R2_PUBLIC_URL --body "https://pub-<hash>.r2.dev"
```

> The committed `tauri.conf.json` keeps a placeholder endpoint. The release
> workflow **injects** `R2_PUBLIC_URL` into the binary at build time (so the URL
> has a single source of truth and you can never forget to replace it). Nothing
> to edit by hand.

---

## Cutting a release

1. Bump the version in **all three** files (keep them in sync):
   - `src-tauri/tauri.conf.json` -> `version`
   - `src-tauri/Cargo.toml` -> `version`
   - `package.json` -> `version`
2. Commit.
3. Tag and push - the tag drives the whole pipeline:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

The `release` workflow then:
- injects the real updater endpoint from `R2_PUBLIC_URL`;
- builds + signs bundles on macOS (universal arm+intel), Windows, and Linux;
- assembles `latest.json` from the `.sig` files (`scripts/build-manifest.mjs`);
- uploads bundles to `<bucket>/v0.2.0/` and `latest.json` to the bucket root,
  all via `wrangler r2 object put`.

Within a minute, every running GitChef older than `0.2.0` self-updates on its
next launch.

> The updater only fires when the **remote** version is **greater** than the
> installed one. Re-tagging the same version does nothing.

---

## Platform notes

- **macOS (ad-hoc signed):** updates install fine (the `.app` is replaced in
  place). But because the app is not notarized with an Apple Developer ID, the
  **first** install on a machine may trip Gatekeeper ("unidentified developer").
  Workaround for users: right-click the app -> *Open* once. Subsequent
  auto-updates are seamless. Add an Apple Developer ID + notarization later for a
  fully clean first run.
- **Windows:** `installMode` is `passive` - the installer runs with a progress
  bar but no prompts. Unsigned builds may show a SmartScreen warning on first
  install; an EV/OV code-signing cert removes it (optional, paid).
- **Linux:** auto-update works for the **AppImage** target only (not deb/rpm).

---

## How the client side works

- `src/updater.ts` - `runSilentUpdate(onStatus)`: `check()` ->
  `downloadAndInstall()` (with progress events) -> `relaunch()`, all wrapped in
  try/catch and behind a one-shot in-flight guard. Guarded to
  `import.meta.env.PROD`, so `pnpm tauri dev` never touches the network.
- `src/components/UpdateToast.tsx` - unobtrusive bottom-right progress toast.
- `src/App.tsx` - calls it once in a mount `useEffect`, feeds the toast.
- `src-tauri/src/lib.rs` - registers `tauri_plugin_updater` + `tauri_plugin_process`.
- `src-tauri/capabilities/default.json` - grants `updater:default` +
  `process:allow-restart` (restart only - not the broader `process:default`,
  which would also expose `exit`).

## Hardening backlog (optional)

- Add a passphrase to the signing key (see step 1).
- Pin `tauri-apps/tauri-action@v0` and `dtolnay/rust-toolchain@stable` to commit
  SHAs (the tauri-action step holds the signing key); add Dependabot.
- Set a restrictive `csp` in `tauri.conf.json` (currently `null`). Must allow
  `img-src https://gravatar.com data:` so commit avatars keep loading.

## Testing the flow end-to-end

1. Do the one-time setup; build + release `v0.1.0`.
2. Install that build locally.
3. Bump to `v0.1.1`, push the tag, let CI upload.
4. Relaunch the installed app - it should fetch, update, and relaunch into
   `0.1.1` with a brief progress toast and no interaction. Watch the dev console
   for `auto-update skipped` if anything goes wrong.
