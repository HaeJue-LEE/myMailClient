// esbuild options shared by the one-off build and the dev watcher.

/**
 * Main and preload bundles. No Google OAuth client is built in: each user
 * enters their own in the app (see electron/google-client.ts).
 * `updateFeed` replaces the GitHub release feed, for testing the updater only.
 */
export function electronBuildOptions(updateFeed = "") {
  const common = {
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["electron"],
    sourcemap: true,
    logLevel: "info",
  };
  return [
    {
      ...common,
      entryPoints: ["electron/main.ts"],
      outfile: "dist-electron/main.cjs",
      define: {
        // Empty except in builds made to test the updater (see electron/updater.ts).
        "process.env.MAIL_CLIENT_UPDATE_FEED": JSON.stringify(updateFeed),
      },
    },
    {
      ...common,
      entryPoints: ["electron/preload.ts"],
      outfile: "dist-electron/preload.cjs",
    },
  ];
}
