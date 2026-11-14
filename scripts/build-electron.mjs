// Bundles the Electron main and preload scripts.
import { build } from "esbuild";
import { electronBuildOptions } from "./electron-build-options.mjs";

await Promise.all(electronBuildOptions().map((options) => build(options)));
