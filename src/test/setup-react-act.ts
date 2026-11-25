import { SUPPORTED_LOCALES } from "@/lib/i18n/config";
import { loadRuntimeMessages } from "@/lib/i18n/runtime-messages";

// Unit fixtures render standalone components without the real route lifecycle.
await Promise.all(SUPPORTED_LOCALES.map(loadRuntimeMessages));

// React 19's act() requires the testing runtime to explicitly opt in.
// Apply this only to the browser/DOM Vitest project, never production code.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
