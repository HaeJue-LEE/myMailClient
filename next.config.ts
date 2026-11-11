import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits plain files into out/, which the Electron app serves itself.
  output: "export",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
