// Bundles the Electron main and preload scripts. Run through
// `node --env-file-if-exists=.env.local` so the OAuth client is baked in.
import { build } from "esbuild";
import {
  electronBuildOptions,
  requireOAuthClient,
} from "./electron-build-options.mjs";

await Promise.all(
  electronBuildOptions(requireOAuthClient(process.env)).map((options) =>
    build(options),
  ),
);
