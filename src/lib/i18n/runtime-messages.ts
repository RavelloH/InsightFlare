import { type Locale, resolveLocale } from "./config";
import type { AppMessages } from "./messages";

// Each import is a statically analyzable Vite split point. Only the current
// route language is loaded; immutable dictionaries can safely be shared.
const loaders = {
  en: () => import("./generated/locale-en"),
  zh: () => import("./generated/locale-zh"),
  "zh-tw": () => import("./generated/locale-zh-tw"),
  ja: () => import("./generated/locale-ja"),
} satisfies Record<Locale, () => Promise<{ default: AppMessages }>>;
const loaded = new Map<Locale, AppMessages>();
const pending = new Map<Locale, Promise<AppMessages>>();

export function loadRuntimeMessages(locale: Locale): Promise<AppMessages> {
  const cached = loaded.get(locale);
  if (cached) return Promise.resolve(cached);
  const inflight = pending.get(locale);
  if (inflight) return inflight;
  const promise = loaders[locale]().then(
    (module) => {
      loaded.set(locale, module.default);
      pending.delete(locale);
      return module.default;
    },
    (error: unknown) => {
      pending.delete(locale);
      throw error;
    },
  );
  pending.set(locale, promise);
  return promise;
}

export function getRuntimeMessages(locale: Locale): AppMessages {
  const messages = loaded.get(locale);
  if (!messages)
    throw new Error("Route language has not been loaded: " + locale);
  return messages;
}

/** Preload before route context is constructed on the server or browser. */
export async function preloadPathMessages(pathname: string): Promise<void> {
  await loadRuntimeMessages(resolveLocale(pathname.split("/")[1]));
}
