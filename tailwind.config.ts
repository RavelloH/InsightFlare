import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        // 重写默认的 font-mono 栈
        mono: [
          "var(--font-mono)", // 优先使用 JetBrains Mono
          "PingFang SC", // macOS/iOS 中文后备
          "Hiragino Sans GB", // 较老 Mac 中文后备
          "Microsoft YaHei", // Windows 中文后备
          "ui-monospace", // 系统默认等宽
          "SFMono-Regular",
          "monospace",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
