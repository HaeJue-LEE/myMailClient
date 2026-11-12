// Bundles the Electron main and preload scripts. Run through
// `node --env-file-if-exists=.env.local`: a Google OAuth client found there is
// baked in; without one the app is built without Google sign-in.
// `--public` always builds without it, whatever .env.local or the shell holds:
// for executables handed to others, which must not carry the client secret.
import { build } from "esbuild";
import {
  electronBuildOptions,
  NO_OAUTH_CLIENT_NOTICE,
  oauthClientFrom,
} from "./electron-build-options.mjs";

const isPublic = process.argv.includes("--public");
const client = isPublic ? null : oauthClientFrom(process.env);
if (isPublic) console.log("배포용 빌드: Google 클라이언트를 넣지 않습니다.");
else if (!client) console.warn(NO_OAUTH_CLIENT_NOTICE);

await Promise.all(electronBuildOptions(client).map((options) => build(options)));
