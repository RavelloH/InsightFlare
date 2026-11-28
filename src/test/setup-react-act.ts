import { SUPPORTED_LOCALES } from "@/lib/i18n/config";
import { loadRuntimeMessages } from "@/lib/i18n/runtime-messages";

// Unit fixtures render standalone components without the real route lifecycle.
await Promise.all(SUPPORTED_LOCALES.map(loadRuntimeMessages));

// React 19's act() requires the testing runtime to explicitly opt in.
// Apply this only to the browser/DOM Vitest project, never production code.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Happy DOM rejects the native finished promise on cancel(), but unlike
// the Web Animations spec it does not mark that rejection as handled.
// Keep the original promise rejected for callers that explicitly await it.
if (typeof Animation !== "undefined") {
  const cancel = Animation.prototype.cancel;
  Animation.prototype.cancel = function (this: Animation) {
    if (this.playState !== "idle") {
      void this.finished.catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          throw error;
        }
      });
    }
    cancel.call(this);
  };
}
