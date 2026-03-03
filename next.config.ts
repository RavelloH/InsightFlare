import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    rules: {
      "*.yaml": {
        loaders: ["yaml-loader"],
        as: "*.js",
      },
      "*.yml": {
        loaders: ["yaml-loader"],
        as: "*.js",
      },
    },
  },
  experimental: {
    adapterPath: "@opennextjs/cloudflare",
  },
  webpack: (config) => {
    config.module.rules.push({
      test: /\.ya?ml$/,
      use: "yaml-loader",
    });
    return config;
  },
};

export default nextConfig;
