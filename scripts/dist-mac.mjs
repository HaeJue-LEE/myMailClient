// Builds the Mac app, on a Mac (or the macOS runner of .github/workflows/mac.yml):
// `release/MailClient-<version>-mac-arm64.dmg` (Apple silicon, M1 and later)
// and `release/MailClient-<version>-mac-x64.dmg` (Intel).
//
// - Always built without the Google OAuth client, like `npm run dist:public`:
//   the dmg is meant to be handed out.
// - Not signed with an Apple Developer ID, only ad hoc (Apple silicon runs
//   nothing unsigned). macOS therefore asks once before the first start; see
//   the README for opening it.
// - No launcher and no updater: the app is a plain .app bundle that is
//   dragged to Applications, and a new version replaces it the same way.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";
import { electronBuildOptions } from "./electron-build-options.mjs";

if (process.platform !== "darwin") {
  console.error("맥용 앱은 macOS에서만 만들 수 있습니다 (GitHub Actions의 Mac 빌드를 쓰세요).");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const builder = require("electron-builder");

const RELEASE = path.resolve("release");
const ICON = path.join(RELEASE, "mac-icon.png");
const { version, productName } = JSON.parse(readFileSync("package.json", "utf8"));
const ARCHES = [
  { name: "arm64", arch: builder.Arch.arm64, folder: "mac-arm64" },
  { name: "x64", arch: builder.Arch.x64, folder: "mac" },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`실패: ${command} ${args.join(" ")}`);
  }
}

/** hdiutil sometimes finds the new image still busy; it works on a retry. */
function makeDmg(source, output) {
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync(
      "hdiutil",
      ["create", "-volname", productName, "-srcfolder", source, "-ov", "-format", "UDZO", output],
      { stdio: "inherit" },
    );
    if (result.status === 0) return;
    if (attempt === 3) throw new Error(`실패: hdiutil create ${output}`);
  }
}

run("npm", ["run", "build:web"]);
console.log("배포용 빌드: Google 클라이언트를 넣지 않습니다.");
await Promise.all(electronBuildOptions(null).map((options) => build(options)));

// macOS wants an icon of at least 512 px; the largest source is smaller, so
// it is scaled up.
mkdirSync(RELEASE, { recursive: true });
run("sips", ["-z", "1024", "1024", "logo-icon.png", "--out", ICON]);

await builder.build({
  targets: builder.Platform.MAC.createTarget("dir", ...ARCHES.map((item) => item.arch)),
  publish: "never",
  config: {
    // The Mac folders are `en.lproj`, not `en-US.lproj`.
    electronLanguages: ["ko", "en"],
    mac: {
      target: "dir",
      icon: ICON,
      category: "public.app-category.productivity",
      // Signed ad hoc below; electron-builder would look for a Developer ID.
      identity: null,
    },
  },
});

for (const { name, folder } of ARCHES) {
  const app = path.join(RELEASE, folder, `${productName}.app`);
  if (!existsSync(app)) throw new Error(`만들어지지 않았습니다: ${app}`);
  run("codesign", ["--force", "--deep", "--sign", "-", app]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);

  // The dmg shows the app beside Applications, to drag it there.
  const stage = path.join(RELEASE, `dmg-${name}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  run("ditto", [app, path.join(stage, `${productName}.app`)]);
  symlinkSync("/Applications", path.join(stage, "Applications"));
  const output = path.join(RELEASE, `MailClient-${version}-mac-${name}.dmg`);
  makeDmg(stage, output);
  rmSync(stage, { recursive: true, force: true });
  console.log(`만들었습니다: ${path.relative(process.cwd(), output)}`);
}
