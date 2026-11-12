// Dev runner for the Electron side: rebuilds electron/ on save (and when
// .env.local changes) and restarts the app so main/preload changes apply.
// Closing the app window ends `npm run dev`, as before.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import electronPath from "electron";
import { context } from "esbuild";
import {
  electronBuildOptions,
  NO_OAUTH_CLIENT_NOTICE,
  oauthClientFrom,
} from "./electron-build-options.mjs";

const ENV_FILE = ".env.local";
/** main and preload often rebuild together (shared imports): restart once. */
const RESTART_DEBOUNCE_MS = 300;

const log = (message) => console.log(`[dev-electron] ${message}`);

function readOAuthClient() {
  const file = existsSync(ENV_FILE)
    ? parseEnv(readFileSync(ENV_FILE, "utf8"))
    : {};
  return oauthClientFrom({ ...process.env, ...file });
}

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

async function watchBundles(client) {
  const options = electronBuildOptions(client);
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

/** Null builds the app without Google sign-in. */
let client = readOAuthClient();
if (!client) log(NO_OAUTH_CLIENT_NOTICE);

async function stop(code) {
  stopping = true;
  clearTimeout(restartTimer);
  unwatchFile(ENV_FILE);
  app?.kill();
  await disposeBundles();
  process.exit(code);
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
process.on("exit", () => app?.kill());

// The OAuth client is inlined at build time, so a change needs new contexts.
watchFile(ENV_FILE, { interval: 1000 }, async () => {
  const next = readOAuthClient();
  // Half-edited values keep the last good client rather than drop sign-in.
  if (!next && client) {
    log(`${ENV_FILE}에 Google 클라이언트 값이 없어 이전 값을 유지합니다.`);
    return;
  }
  if (JSON.stringify(next) === JSON.stringify(client)) return;
  client = next;
  log(`${ENV_FILE} 변경 → 다시 빌드`);
  await disposeBundles();
  await watchBundles(client);
});

await watchBundles(client);
log("electron/ 감시 중 (저장하면 앱이 자동으로 재시작됩니다)");
