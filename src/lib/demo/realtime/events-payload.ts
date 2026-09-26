import { fnv1a, mulberry32, sInt, sPick } from "@/lib/demo/generators/utils";
import type { DemoCustomEventFact } from "@/lib/demo/realtime/events-facts";
import { parseDemoScreenSize } from "@/lib/demo/realtime/shared";

export function demoEventRecordPayload(event: DemoCustomEventFact) {
  const visit = event.visit;
  if (visit.customEventPayload !== undefined) return visit.customEventPayload;
  const screen = parseDemoScreenSize(visit.screenSize);
  const eventScore = fnv1a(event.eventId);
  const rng = mulberry32(eventScore);
  const base = {
    plan: sPick(rng, ["free", "pro", "team", "enterprise"]),
    surface: sPick(rng, ["hero", "nav", "pricing_table", "inline_card"]),
    value: sInt(rng, 1, 12),
    page: {
      path: visit.pathname,
      title: visit.title,
    },
    device: {
      type: visit.deviceType,
      screen: {
        width: screen.screenWidth,
        height: screen.screenHeight,
      },
    },
    flags: {
      signedIn: eventScore % 3 === 0,
      experiment: sPick(rng, ["control", "variant_a", "variant_b"]),
    },
    items: [
      { id: `sku_${eventScore % 97}`, quantity: 1 },
      null,
      eventScore % 2 === 0,
    ],
  };

  if (event.eventName.includes("purchase")) {
    return {
      ...base,
      order: {
        currency: "USD",
        amount: Math.round((20 + rng() * 260) * 100) / 100,
        couponApplied: eventScore % 4 === 0,
      },
    };
  }

  if (event.eventName.includes("cart")) {
    return {
      ...base,
      product: {
        id: `product_${eventScore % 31}`,
        category: sPick(rng, ["audio", "wearables", "workspace"]),
        price: Math.round((12 + rng() * 180) * 100) / 100,
      },
    };
  }

  return base;
}

export function demoJsonTypeLabel(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const valueType = typeof value;
  if (valueType === "string") return "string";
  if (valueType === "number") return "number";
  if (valueType === "boolean") return "boolean";
  return "object";
}
