// Builds the app as one executable: the small launcher in launcher/ with the
// app (release/win-unpacked, zipped) appended. The first run unpacks the app
// into a "Mail Client" folder beside the exe, later runs start it directly.
//
// - Default (`npm run dist:public`): `release/MailClient-<version>.exe`, to
//   hand to others. Always built without the Google OAuth client, so no
//   client secret ships.
// - `--local` (`npm run dist`): `release/MailClient-<version>-local.exe`, for
//   this PC: built with the Google client from .env.local when there is one.
//   Not for handing out: the client secret is inside.
//
// dist-electron/ is shared with `npm run dev` and `npm start`, so afterwards
// (also on failure) it is rebuilt the usual way, with the client from
// .env.local when there is one.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { build } from "esbuild";
import {
  electronBuildOptions,
  oauthClientFrom,
} from "./electron-build-options.mjs";

const ENV_FILE = ".env.local";
const RELEASE = path.resolve("release");
const UNPACKED = path.join(RELEASE, "win-unpacked");
const PAYLOAD = path.join(RELEASE, "payload.zip");
const LAUNCHER = path.resolve("launcher/target/release/mailclient-launcher.exe");
const MAGIC = Buffer.from("MCPKG001");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const LOCAL = process.argv.includes("--local");
const OUTPUT = path.join(RELEASE, `MailClient-${version}${LOCAL ? "-local" : ""}.exe`);

function run(command, args, options = {}) {
  // `shell` resolves npm/npx on Windows as npm scripts do.
  const result = spawnSync(command, args, { stdio: "inherit", shell: true, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`실패: ${command} ${args.join(" ")}`);
  }
}

const bundle = (client) =>
  Promise.all(electronBuildOptions(client).map((options) => build(options)));

function localClient() {
  const file = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, "utf8")) : {};
  return oauthClientFrom({ ...process.env, ...file });
}

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
  if (LOCAL) {
    const client = localClient();
    console.log(
      client
        ? "이 PC용 빌드: .env.local의 Google 클라이언트를 넣습니다. 남에게 주지 마세요."
        : "이 PC용 빌드: .env.local이 없어 Google 로그인 없이 빌드합니다.",
    );
    await bundle(client);
  } else {
    console.log("배포용 빌드: Google 클라이언트를 넣지 않습니다.");
    await bundle(null);
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
  const client = localClient();
  await bundle(client);
  console.log(
    client
      ? "이 PC용 앱 코드를 .env.local의 Google 클라이언트로 다시 빌드했습니다."
      : "이 PC용 앱 코드를 다시 빌드했습니다 (.env.local 없음: Google 로그인 없음).",
  );
}
if (failed) process.exit(1);
