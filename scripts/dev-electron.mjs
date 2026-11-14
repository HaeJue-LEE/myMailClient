// Dev runner for the Electron side: rebuilds electron/ on save and restarts
// the app so main/preload changes apply.
// Closing the app window ends `npm run dev`, as before.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import electronPath from "electron";
import { context } from "esbuild";
import { electronBuildOptions } from "./electron-build-options.mjs";

/** main and preload often rebuild together (shared imports): restart once. */
const RESTART_DEBOUNCE_MS = 300;

const log = (message) => console.log(`[dev-electron] ${message}`);

// --- the Electron process -------------------------------------------------

let app = null;
let restarting = false;
let stopping = false;

/** Extra arguments are passed to Electron, e.g. `-- --remote-debugging-port=9222`. */
const electronArgs = [".", "--dev", ...process.argv.slice(2)];

function launch() {
  app = spawn(electronPath, electronArgs, { stdio: "inherit" });
  app.on("exit", (code) => {
    app = null;
    if (stopping) return;
    if (restarting) {
      // Relaunch only after exit: the app holds a single-instance lock.
      restarting = false;
      launch();
      return;
    }
    log("앱 창이 닫혀 개발 모드를 종료합니다.");
    void stop(code ?? 0);
  });
}

let restartTimer;
function scheduleRestart(reason) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    if (!app) {
      log("앱 실행");
      launch();
    } else if (!restarting) {
      log(`${reason} → 앱 재시작`);
      restarting = true;
      app.kill();
    }
  }, RESTART_DEBOUNCE_MS);
}

// --- the bundles ----------------------------------------------------------

let contexts = [];
/** Last emitted bundle per output, so no-op rebuilds do not restart the app. */
const bundleHashes = new Map();

function emitAndRestartPlugin(outfile, expectedBundles) {
  return {
    name: "emit-and-restart",
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0 || !result.outputFiles) return;
        for (const file of result.outputFiles) {
          mkdirSync(path.dirname(file.path), { recursive: true });
          writeFileSync(file.path, file.contents);
        }
        const bundle = result.outputFiles.find((file) =>
          file.path.endsWith(".cjs"),
        );
        const hash = createHash("sha1").update(bundle.contents).digest("hex");
        if (bundleHashes.get(outfile) === hash) return;
        bundleHashes.set(outfile, hash);
        // Wait until every bundle exists before the first launch.
        if (bundleHashes.size === expectedBundles) {
          scheduleRestart(`${path.basename(outfile)} 변경`);
        }
      });
    },
  };
}

async function watchBundles() {
  const options = electronBuildOptions();
  contexts = await Promise.all(
    options.map((option) =>
      context({
        ...option,
        // Written by the plugin, so the app restarts only after files are on disk.
        write: false,
        plugins: [emitAndRestartPlugin(option.outfile, options.length)],
      }),
    ),
  );
  await Promise.all(contexts.map((ctx) => ctx.watch()));
}

async function disposeBundles() {
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  contexts = [];
}

// --- lifecycle ------------------------------------------------------------

async function stop(code) {
  stopping = true;
  clearTimeout(restartTimer);
  app?.kill();
  await disposeBundles();
  process.exit(code);
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
process.on("exit", () => app?.kill());

await watchBundles();
log("electron/ 감시 중 (저장하면 앱이 자동으로 재시작됩니다)");
