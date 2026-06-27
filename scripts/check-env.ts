// scripts/check-env.ts
// 检查环境变量设置是否正确，确保生产环境安全

import { randomBytes } from "node:crypto";

import { createScriptLogger } from "./shared/logger";

const rlog = createScriptLogger();

// 计算香农熵
function calculateShannonEntropy(str: string): number {
  const len = str.length;
  const frequencies = new Map<string, number>();
  for (const char of str) {
    frequencies.set(char, (frequencies.get(char) || 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// 生成强随机密钥
function generateStrongSecret(): string {
  return randomBytes(32).toString("hex");
}

// 密钥验证器
function validateSecret(value: string, minLength: number = 32): string | null {
  if (value.length < minLength) {
    return `Should be at least ${minLength} characters long for security`;
  }
  const entropy = calculateShannonEntropy(value);
  if (entropy < 3.5) {
    return `Entropy is too low (${entropy.toFixed(2)}). Please use a more random secret (aim for > 3.5).`;
  }
  return null;
}

// 检查是否有可用的 secret 来源
function hasUsableSecretSource(): boolean {
  // 检查 MAIN_SECRET 或 DAILY_SALT_SECRET（root secret）
  const rootSecret = process.env.MAIN_SECRET || process.env.DAILY_SALT_SECRET;
  if (rootSecret && rootSecret.length >= 16) return true;

  // 检查显式的 session secret
  const sessionSecret =
    process.env.DASHBOARD_SESSION_SECRET || process.env.SESSION_SECRET;
  if (sessionSecret && sessionSecret.length >= 16) return true;

  return false;
}

// 必需的环境变量配置
const REQUIRED_ENV_VARS: Array<{
  name: string;
  description: string;
  validator: (value: string) => string | null;
  optional?: boolean;
}> = [
  {
    name: "MAIN_SECRET",
    description:
      "Root secret for deriving session keys, API key hashes, and visitor salts (or use DAILY_SALT_SECRET)",
    validator: (value: string) => validateSecret(value),
    optional: true, // 可选，因为可以回退到 DAILY_SALT_SECRET
  },
  {
    name: "DAILY_SALT_SECRET",
    description: "Alternative root secret (used if MAIN_SECRET not set)",
    validator: (value: string) => validateSecret(value, 16),
    optional: true, // 可选，与 MAIN_SECRET 互为回退
  },
];

// 可选但推荐的环境变量
const RECOMMENDED_ENV_VARS = [
  {
    name: "BOOTSTRAP_ADMIN_PASSWORD",
    description: "Password for the default admin account",
    validator: (value: string) => {
      if (value.length < 12) {
        return "Should be at least 12 characters long";
      }
      return null;
    },
  },
  {
    name: "DASHBOARD_SESSION_SECRET",
    description: "Optional override for dashboard session signing key",
    validator: (value: string) => {
      if (value.length < 16) {
        return "Should be at least 16 characters long";
      }
      return null;
    },
  },
];

// 检查是否为生产环境
function isProduction(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.CF_PAGES === "1" ||
    process.env.VERCEL === "1" ||
    process.env.CI === "true"
  );
}

// 检查是否为 Demo 模式
function isDemoMode(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === "1";
}

// 导出的环境检查函数
export async function checkEnvironmentVariables(options?: {
  strict?: boolean;
}): Promise<void> {
  const strict = options?.strict ?? isProduction();
  let hasErrors = false;
  let hasWarnings = false;

  // Demo 模式跳过检查
  if (isDemoMode()) {
    rlog.info("> Demo mode detected, skipping environment checks");
    return;
  }

  rlog.info("> Checking environment variables...");

  // 检查可选的 root secret（MAIN_SECRET 或 DAILY_SALT_SECRET）
  for (const envVar of REQUIRED_ENV_VARS) {
    const value = process.env[envVar.name];

    if (!value) {
      rlog.info(`  ○ ${envVar.name} is not set (optional)`);
    } else {
      const validationError = envVar.validator(value);
      if (validationError) {
        rlog.error(`  ✗ ${envVar.name} is invalid: ${validationError}`);
        hasErrors = true;
      } else {
        rlog.success(`  ✓ ${envVar.name} is set and valid`);
      }
    }
  }

  // 检查是否有至少一个可用的 secret 来源
  // 与 src/lib/secrets.ts 中的回退逻辑一致
  if (!hasUsableSecretSource()) {
    if (strict) {
      rlog.error("");
      rlog.error("  ✗ No usable secret found!");
      rlog.error("    At least one of the following must be set:");
      rlog.error("    - MAIN_SECRET (recommended)");
      rlog.error("    - DAILY_SALT_SECRET");
      rlog.error("    - DASHBOARD_SESSION_SECRET");
      rlog.error("    - SESSION_SECRET");
      rlog.error("");
      const generated = generateStrongSecret();
      rlog.info(`    Suggested MAIN_SECRET: ${generated}`);
      hasErrors = true;
    } else {
      rlog.warn("  ⚠ No secret configured, using insecure defaults (dev only)");
      hasWarnings = true;
    }
  }

  // 检查推荐的环境变量
  for (const envVar of RECOMMENDED_ENV_VARS) {
    const value = process.env[envVar.name];

    if (!value) {
      rlog.warn(`  ⚠ ${envVar.name} is not set (recommended)`);
      rlog.warn(`    ${envVar.description}`);
      hasWarnings = true;
    } else {
      const validationError = envVar.validator(value);
      if (validationError) {
        rlog.warn(`  ⚠ ${envVar.name}: ${validationError}`);
        hasWarnings = true;
      } else {
        rlog.success(`  ✓ ${envVar.name} is set and valid`);
      }
    }
  }

  // 总结检查结果
  if (hasErrors) {
    rlog.error("");
    rlog.error("✗ Environment variables check FAILED!");
    rlog.error("  Production deployments require at least one secret source.");
    rlog.error("  This prevents session forgery and API key compromise.");
    rlog.error("");
    throw new Error("Required environment variables are missing or invalid.");
  }

  if (hasWarnings) {
    rlog.warn("");
    rlog.warn("  Environment variables check completed with warnings.");
    rlog.warn("  Consider setting recommended variables for better security.");
  } else {
    rlog.success("✓ Environment variables check passed");
  }
}
