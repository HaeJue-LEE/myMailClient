// esbuild options shared by the one-off build and the dev watcher.

/**
 * The Google OAuth client from `env`, or null when it is not set. Without it
 * the app is built without Google sign-in (Gmail API and Google contacts);
 * IMAP and POP3 accounts, Gmail over IMAP included, work as before.
 */
export function oauthClientFrom(env) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
  return GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET
    ? { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET }
    : null;
}

/** The line printed when a build leaves Google sign-in out. */
export const NO_OAUTH_CLIENT_NOTICE =
  "Google 클라이언트(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)가 .env.local에 없어 " +
  "Google 로그인 없이 빌드합니다. IMAP·POP3 계정(Gmail IMAP 포함)은 그대로 쓸 수 있습니다.";

/**
 * Main and preload bundles. The OAuth client, when given, is inlined into
 * main; null leaves both values empty, which turns Google sign-in off.
 */
export function electronBuildOptions(client) {
  const { GOOGLE_CLIENT_ID = "", GOOGLE_CLIENT_SECRET = "" } = client ?? {};
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
