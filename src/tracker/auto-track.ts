interface AutoTrackOptions {
  autoTrackOutboundLinks: boolean;
  track(eventName: string, eventData?: unknown): void;
}

function extractEventData(el: Element): Record<string, unknown> {
  let data: Record<string, unknown> = {};
  const rawData = el.getAttribute("data-insightflare-event-data");
  if (rawData) {
    try {
      const parsed = JSON.parse(rawData);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed;
      }
    } catch {
      // ignore invalid JSON
    }
  }
  const ds = (el as any).dataset;
  if (ds) {
    for (const key in ds) {
      if (!Object.prototype.hasOwnProperty.call(ds, key)) continue;
      if (key.indexOf("insightflareEvent") !== 0) continue;
      const suffix = key.slice(17);
      if (!suffix || suffix === "Trigger" || suffix === "Data") continue;
      const dataKey = suffix.charAt(0).toLowerCase() + suffix.slice(1);
      data[dataKey] = ds[key];
    }
  }
  return data;
}

export function initAutoTrack(options: AutoTrackOptions): void {
  document.addEventListener(
    "click",
    (e) => {
      const el = (e.target as Element).closest("[data-insightflare-event]");
      if (!el) return;
      const trigger =
        el.getAttribute("data-insightflare-event-trigger") || "click";
      if (trigger !== "click") return;
      const eventName = el.getAttribute("data-insightflare-event");
      if (!eventName) return;
      options.track(eventName, extractEventData(el));
    },
    true,
  );

  if (options.autoTrackOutboundLinks) {
    const currentHostname = window.location.hostname.toLowerCase();
    document.addEventListener(
      "click",
      (e) => {
        const anchor = (e.target as Element).closest("a[href]");
        if (!anchor) return;
        const href = anchor.getAttribute("href") || "";
        if (!href) return;
        let url: URL;
        try {
          url = new URL(href, window.location.href);
        } catch {
          return;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") return;
        const targetHostname = url.hostname.toLowerCase();
        if (!targetHostname || targetHostname === currentHostname) return;
        options.track("outbound_click", {
          url: url.href,
          domain: targetHostname,
        });
      },
      true,
    );
  }

  document.addEventListener(
    "submit",
    (e) => {
      const form = (e.target as Element).closest(
        '[data-insightflare-event][data-insightflare-event-trigger="submit"]',
      );
      if (!form) return;
      const eventName = form.getAttribute("data-insightflare-event");
      if (!eventName) return;
      options.track(eventName, extractEventData(form));
    },
    true,
  );
}
