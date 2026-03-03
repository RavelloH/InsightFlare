import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    adapterPath: "@opennextjs/cloudflare",
  },
};

export default nextConfig;
