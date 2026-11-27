interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      size: "invisible";
      execution: "execute";
      retry: "never";
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
      "timeout-callback": () => void;
    },
  ) => string;
  execute: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_ID = "cloudflare-turnstile-script";
const TIMEOUT_MS = 60_000;
let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    const timeout = window.setTimeout(fail, TIMEOUT_MS);
    function cleanup() {
      window.clearTimeout(timeout);
      script.removeEventListener("load", loaded);
      script.removeEventListener("error", fail);
    }
    function fail() {
      cleanup();
      script.remove();
      reject(new Error("turnstile_load_failed"));
    }
    function loaded() {
      if (!window.turnstile) {
        fail();
        return;
      }
      cleanup();
      resolve(window.turnstile);
    }
    script.addEventListener("load", loaded);
    script.addEventListener("error", fail);
    document.getElementById(SCRIPT_ID)?.remove();
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    scriptPromise = null;
    throw error;
  });
  return scriptPromise;
}

// Each attempt owns its widget and callbacks; a late callback cannot settle a new attempt.
export async function verifyTurnstile(
  container: HTMLElement,
  siteKey: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const api = await loadTurnstile();
  signal.throwIfAborted();
  let widgetId: string | undefined;
  let timeout: number | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const fail = () => reject(new Error("turnstile_verification_failed"));
      timeout = window.setTimeout(fail, TIMEOUT_MS);
      widgetId = api.render(container, {
        sitekey: siteKey,
        size: "invisible",
        execution: "execute",
        retry: "never",
        callback: (token) => (token ? resolve(token) : fail()),
        "error-callback": fail,
        "expired-callback": fail,
        "timeout-callback": fail,
      });
      api.execute(widgetId);
    });
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    window.clearTimeout(timeout);
    if (widgetId !== undefined) api.remove(widgetId);
  }
}
