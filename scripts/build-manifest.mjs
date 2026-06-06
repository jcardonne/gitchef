// Builds the Tauri updater manifest (latest.json) from the signed bundles
// produced by the release matrix. Run in the publish job after all per-platform
// artifacts are downloaded into one directory.
//
// Env:
//   VERSION         release version, e.g. "0.2.0" (leading "v" tolerated)
//   R2_PUBLIC_URL   public base, e.g. "https://pub-xxxx.r2.dev" (no trailing /)
//   DIST_DIR        directory holding the bundles + .sig files (default ./dist-updater)
//   NOTES           optional release notes string
//
// Each signed binary is matched to its `.sig` sibling and mapped to one or more
// Tauri platform keys (OS-ARCH). The macOS bundle is a universal binary, so it
// serves both darwin-aarch64 and darwin-x86_64.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

const version = (process.env.VERSION ?? "").replace(/^v/, "");
const base = (process.env.R2_PUBLIC_URL ?? "").replace(/\/+$/, "");
const distDir = process.env.DIST_DIR ?? "dist-updater";
const notes = process.env.NOTES ?? "";

if (!version) throw new Error("VERSION is required");
if (!base) throw new Error("R2_PUBLIC_URL is required");

// Recursively list every file under a directory.
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// Which platform keys a given binary filename serves (or null to ignore it).
function platformsFor(file) {
  if (file.endsWith(".app.tar.gz")) return ["darwin-aarch64", "darwin-x86_64"];
  if (file.endsWith("-setup.exe") || file.endsWith(".msi")) return ["windows-x86_64"];
  if (file.endsWith(".AppImage")) return ["linux-x86_64"];
  return null;
}

const files = walk(distDir);
const sigs = new Set(files.filter((f) => f.endsWith(".sig")).map((f) => f.slice(0, -4)));

const platforms = {};
for (const file of files) {
  const keys = platformsFor(file);
  if (!keys) continue;
  if (!sigs.has(file)) {
    console.warn(`no .sig for ${file}, skipping`);
    continue;
  }
  const entry = {
    signature: readFileSync(`${file}.sig`, "utf8").trim(),
    url: `${base}/v${version}/${basename(file)}`,
  };
  // Windows: prefer the NSIS installer (-setup.exe) if both it and the .msi exist.
  for (const key of keys) {
    if (platforms[key] && key === "windows-x86_64" && !file.endsWith("-setup.exe")) continue;
    platforms[key] = entry;
  }
}

if (Object.keys(platforms).length === 0) {
  throw new Error(`no signed bundles found under ${distDir}`);
}

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync("latest.json", JSON.stringify(manifest, null, 2));
console.log("latest.json written:\n", JSON.stringify(manifest, null, 2));
