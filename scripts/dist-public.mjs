// Builds the app as one executable: the small launcher in launcher/ with the
// app (release/win-unpacked, zipped) appended. The first run unpacks the app
// into a "Mail Client" folder beside the exe, later runs start it directly.
//
// `npm run dist:public` makes `release/MailClient-<version>.exe`, the one
// executable for this PC, others and releases alike: no Google OAuth client is
// built in, each user enters their own in the app.
//
// dist-electron/ is shared with `npm run dev` and `npm start`, so a build made
// to test the updater (MAIL_CLIENT_UPDATE_FEED) rebuilds it the usual way
// afterwards, also on failure.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { electronBuildOptions } from "./electron-build-options.mjs";

const RELEASE = path.resolve("release");
const UNPACKED = path.join(RELEASE, "win-unpacked");
const PAYLOAD = path.join(RELEASE, "payload.zip");
const LAUNCHER = path.resolve("launcher/target/release/mailclient-launcher.exe");
const MAGIC = Buffer.from("MCPKG001");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const OUTPUT = path.join(RELEASE, `MailClient-${version}.exe`);

function run(command, args, options = {}) {
  // `shell` resolves npm/npx on Windows as npm scripts do.
  const result = spawnSync(command, args, { stdio: "inherit", shell: true, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`실패: ${command} ${args.join(" ")}`);
  }
}

const bundle = (updateFeed = "") =>
  Promise.all(electronBuildOptions(updateFeed).map((options) => build(options)));

/**
 * MAIL_CLIENT_UPDATE_FEED replaces the GitHub release feed in the exe, to
 * test updating against a local feed. Never set it for a release.
 */
const UPDATE_FEED = process.env.MAIL_CLIENT_UPDATE_FEED ?? "";

function buildLauncher() {
  const cargo = spawnSync("cargo", ["--version"], { shell: true });
  if (cargo.status !== 0) {
    throw new Error("Rust(cargo)가 없어 실행 파일 런처를 만들 수 없습니다. https://rustup.rs 에서 설치해 주세요.");
  }
  // No debug info: it would carry this PC's build paths into the exe.
  run("cargo", ["build", "--release", "--manifest-path", "launcher/Cargo.toml"], {
    env: { ...process.env, RUSTFLAGS: "-C link-arg=/DEBUG:NONE" },
  });
}

/** release/win-unpacked as a zip, made with Windows' own tar (as the launcher unpacks it). */
function zipApp() {
  rmSync(PAYLOAD, { force: true });
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  run(`"${path.join(windows, "System32", "tar.exe")}"`, ["-a", "-cf", `"${PAYLOAD}"`, "*"], {
    cwd: UNPACKED,
  });
}

/** launcher + zip + package id (a hash of the zip) + lengths + magic. */
function assemble() {
  const launcher = readFileSync(LAUNCHER);
  const zip = readFileSync(PAYLOAD);
  const id = Buffer.from(`${version}+${createHash("sha256").update(zip).digest("hex").slice(0, 16)}`);
  const lengths = Buffer.alloc(12);
  lengths.writeUInt32LE(id.length, 0);
  lengths.writeBigUInt64LE(BigInt(zip.length), 4);
  writeFileSync(OUTPUT, Buffer.concat([launcher, zip, id, lengths, MAGIC]));
  rmSync(PAYLOAD, { force: true });
  return id.toString();
}

let failed = false;
try {
  run("npm", ["run", "build:web"]);
  await bundle(UPDATE_FEED);
  if (UPDATE_FEED) {
    console.warn(`
*** 업데이트 시험용 빌드: 업데이트를 ${UPDATE_FEED}에서 확인합니다. 배포하지 마세요. ***
`);
  }
  run("npx", ["electron-builder", "--win", "--dir"]);
  buildLauncher();
  zipApp();
  const id = assemble();
  console.log(`만들었습니다: ${path.relative(process.cwd(), OUTPUT)} (패키지 ${id})`);
} catch (error) {
  failed = true;
  console.error(error.message);
} finally {
  if (UPDATE_FEED) {
    await bundle();
    console.log("업데이트 시험 주소를 뺀 앱 코드로 다시 빌드했습니다.");
  }
}
if (failed) process.exit(1);
