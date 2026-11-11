// esbuild options shared by the one-off build and the dev watcher.

/** Returns the OAuth client from `env`, or exits with a hint when it is missing. */
export function requireOAuthClient(env) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.error(
      "GOOGLE_CLIENT_ID와 GOOGLE_CLIENT_SECRET을 .env.local에 설정해 주세요. (.env.example 참고)",
    );
    process.exit(1);
  }
  return { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET };
}

/** Main and preload bundles; the OAuth client is inlined into main. */
export function electronBuildOptions({ GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET }) {
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
        "process.env.GOOGLE_CLIENT_ID": JSON.stringify(GOOGLE_CLIENT_ID),
        "process.env.GOOGLE_CLIENT_SECRET": JSON.stringify(GOOGLE_CLIENT_SECRET),
      },
    },
    {
      ...common,
      entryPoints: ["electron/preload.ts"],
      outfile: "dist-electron/preload.cjs",
    },
  ];
}
