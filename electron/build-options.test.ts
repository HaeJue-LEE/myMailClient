import { describe, expect, it } from "vitest";
import { electronBuildOptions as buildOptions } from "../scripts/electron-build-options.mjs";

/** Only `define` matters here; the bundles differ in which of them has one. */
const electronBuildOptions = (updateFeed?: string) =>
  buildOptions(updateFeed) as { define?: Record<string, string> }[];

describe("build options", () => {
  it("builds no Google client in, and the update feed into main only", () => {
    const [main, preload] = electronBuildOptions();
    expect(main.define).toEqual({ "process.env.MAIL_CLIENT_UPDATE_FEED": '""' });
    expect(preload.define).toBeUndefined();

    const [testing] = electronBuildOptions("http://127.0.0.1:8080/latest");
    expect(testing.define).toEqual({
      "process.env.MAIL_CLIENT_UPDATE_FEED": '"http://127.0.0.1:8080/latest"',
    });
  });
});
