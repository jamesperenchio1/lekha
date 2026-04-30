import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default config;
