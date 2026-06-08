// Sync the release version across every file that hard-codes it. Run by
// semantic-release (@semantic-release/exec prepareCmd) with the computed version.
//
//   node scripts/bump-version.mjs 0.2.0
//
// The three build systems each keep their own version field; this keeps them in
// lockstep so the binary, the bundle, and the updater manifest all agree.

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("usage: bump-version.mjs <version>");
  process.exit(1);
}

// package.json
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = version;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

// src-tauri/tauri.conf.json
const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
conf.version = version;
writeFileSync("src-tauri/tauri.conf.json", JSON.stringify(conf, null, 2) + "\n");

// src-tauri/Cargo.toml - only the [package] version (line-start), never the
// inline `version = "2"` of dependencies (those are mid-line).
let cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
cargo = cargo.replace(/^version = "[^"]*"/m, `version = "${version}"`);
writeFileSync("src-tauri/Cargo.toml", cargo);

// src-tauri/Cargo.lock - the gitchef package entry, so `cargo build` against the
// committed lock stays consistent (no dirty lockfile in the build).
let lock = readFileSync("src-tauri/Cargo.lock", "utf8");
lock = lock.replace(
  /(name = "gitchef"\nversion = ")[^"]*(")/,
  `$1${version}$2`
);
writeFileSync("src-tauri/Cargo.lock", lock);

console.log(`bumped version to ${version}`);
