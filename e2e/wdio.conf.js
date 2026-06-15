import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Tauri names the binary after the crate (`gitchef`); override with TAURI_APP_BIN
// if a packager ever renames it.
const application =
  process.env.TAURI_APP_BIN || path.resolve(ROOT, "src-tauri/target/debug/gitchef");

// keep track of the `tauri-driver` child process
let tauriDriver;
let exit = false;

export const config = {
  host: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.e2e.js"],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      "tauri:options": { application },
    },
  ],
  reporters: ["spec"],
  framework: "mocha",
  logLevel: "warn",
  mochaOpts: {
    ui: "bdd",
    // Generous: the before() hook may reload + re-wait a few times if a launch
    // stalls under CI load. The debug build runs in onPrepare, outside this.
    timeout: 300000,
  },

  // Build the debug binary the webdriver session drives. `--no-bundle` skips
  // installer packaging (and the signing it needs); tauri's beforeBuildCommand
  // builds the frontend. Set E2E_SKIP_BUILD=1 to reuse an existing build.
  onPrepare: () => {
    if (process.env.E2E_SKIP_BUILD === "1") return;
    const res = spawnSync("pnpm", ["tauri", "build", "--debug", "--no-bundle"], {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
    });
    if (res.status !== 0) {
      throw new Error(`tauri debug build failed (exit ${res.status})`);
    }
  },

  // tauri-driver proxies WebDriver to the platform's native driver
  // (WebKitWebDriver on Linux); it must be running before the session starts.
  beforeSession: () => {
    tauriDriver = spawn(
      process.env.TAURI_DRIVER_BIN ||
        path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver"),
      [],
      { stdio: [null, process.stdout, process.stderr] }
    );

    tauriDriver.on("error", (error) => {
      console.error("tauri-driver error:", error);
      process.exit(1);
    });
    tauriDriver.on("exit", (code) => {
      if (!exit) {
        console.error("tauri-driver exited with code:", code);
        process.exit(1);
      }
    });
  },

  // clean up the `tauri-driver` process we spawned at the start of the session
  afterSession: () => closeTauriDriver(),
};

function closeTauriDriver() {
  exit = true;
  tauriDriver?.kill();
}

function onShutdown(fn) {
  const cleanup = () => {
    try {
      fn();
    } finally {
      process.exit();
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);
  process.on("SIGBREAK", cleanup);
}

// ensure tauri-driver is closed when our test process exits
onShutdown(() => closeTauriDriver());
