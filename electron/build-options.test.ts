import { describe, expect, it } from "vitest";
import {
  electronBuildOptions as buildOptions,
  oauthClientFrom,
} from "../scripts/electron-build-options.mjs";

/** Only `define` matters here; the bundles differ in which of them has one. */
const electronBuildOptions = (client: Parameters<typeof buildOptions>[0]) =>
  buildOptions(client) as { define?: Record<string, string> }[];

describe("build options", () => {
  it("finds the Google client only when both values are set", () => {
    expect(oauthClientFrom({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" })).toEqual({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
    });
    expect(oauthClientFrom({ GOOGLE_CLIENT_ID: "id" })).toBeNull();
    expect(oauthClientFrom({ GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" })).toBeNull();
    expect(oauthClientFrom({})).toBeNull();
  });

  it("inlines the client into main only, and nothing without one", () => {
    const [main, preload] = electronBuildOptions({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
    });
    expect(main.define).toEqual({
      "process.env.GOOGLE_CLIENT_ID": '"id"',
      "process.env.GOOGLE_CLIENT_SECRET": '"secret"',
    });
    expect(preload.define).toBeUndefined();

    const [withoutClient] = electronBuildOptions(null);
    expect(withoutClient.define).toEqual({
      "process.env.GOOGLE_CLIENT_ID": '""',
      "process.env.GOOGLE_CLIENT_SECRET": '""',
    });
  });
});
