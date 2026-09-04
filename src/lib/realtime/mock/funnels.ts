import type {
  FunnelAnalysis,
  FunnelDefinition,
  FunnelDetailData,
  FunnelListData,
  FunnelMutationData,
  FunnelStep,
} from "@/lib/edge-client";
import { demoBadRequest, demoNotFound } from "@/lib/realtime/mock/envelope";
import type { ErrorEnvelope } from "@/lib/response-envelope";

const CREATED_AT = 1_767_225_600;
let customFunnelCounter = 0;

const demoFunnels: FunnelDefinition[] = [
  {
    id: "demo-funnel-signup",
    siteId: "demo-site-001",
    name: "Signup activation",
    steps: [
      { type: "pageview", value: "/pricing" },
      { type: "event", value: "signup_started" },
      { type: "event", value: "signup_completed" },
      { type: "pageview", value: "/app/onboarding" },
    ],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT + 86_400,
  },
  {
    id: "demo-funnel-checkout",
    siteId: "demo-site-001",
    name: "Checkout",
    steps: [
      { type: "pageview", value: "/products" },
      { type: "event", value: "cart_add" },
      { type: "pageview", value: "/checkout" },
      { type: "event", value: "purchase" },
    ],
    createdAt: CREATED_AT - 172_800,
    updatedAt: CREATED_AT + 43_200,
  },
];

function normalizeDemoSteps(input: unknown): FunnelStep[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      if (record.type !== "pageview" && record.type !== "event") return null;
      const value = String(record.value ?? "").trim();
      return value ? { type: record.type, value } : null;
    })
    .filter((step): step is FunnelStep => Boolean(step))
    .slice(0, 12);
}

function siteFunnels(siteId: string): FunnelDefinition[] {
  const siteSpecific = demoFunnels.filter((funnel) => funnel.siteId === siteId);
  const templates =
    siteId === "demo-site-001"
      ? siteSpecific
      : [
          ...siteSpecific,
          ...demoFunnels
            .filter((funnel) => funnel.siteId === "demo-site-001")
            .map((funnel) => ({ ...funnel, siteId })),
        ];
  return templates.map((funnel) => ({
    ...funnel,
    steps: funnel.steps.map((step) => ({ ...step })),
  }));
}

function analysisFor(funnel: FunnelDefinition): FunnelAnalysis {
  const base = funnel.id.includes("checkout") ? 1260 : 1840;
  const retention = funnel.id.includes("checkout")
    ? [1, 0.62, 0.39, 0.24]
    : [1, 0.54, 0.38, 0.31];
  const counts = funnel.steps.map((_, index) =>
    Math.round(
      base * (retention[index] ?? Math.max(0.12, 0.31 - index * 0.06)),
    ),
  );
  const visitorCounts = counts.map((count) => Math.round(count * 0.82));
  let largestDropOffStepIndex: number | null = null;
  let largestDropOffSessions = 0;

  const steps = funnel.steps.map((step, index) => {
    const sessions = counts[index] ?? 0;
    const previous = index === 0 ? sessions : (counts[index - 1] ?? 0);
    const dropOffSessions = index === 0 ? 0 : Math.max(0, previous - sessions);
    if (index > 0 && dropOffSessions > largestDropOffSessions) {
      largestDropOffSessions = dropOffSessions;
      largestDropOffStepIndex = index;
    }
    return {
      index,
      label: step.value,
      type: step.type,
      sessions,
      visitors: visitorCounts[index] ?? 0,
      conversionRate: counts[0] ? sessions / counts[0] : 0,
      stepConversionRate:
        index === 0
          ? sessions > 0
            ? 1
            : 0
          : previous > 0
            ? sessions / previous
            : 0,
      dropOffSessions,
      dropOffRate:
        index === 0 || previous <= 0 ? 0 : dropOffSessions / previous,
    };
  });
  const converted = steps[steps.length - 1];

  return {
    steps,
    summary: {
      totalSessions: steps[0]?.sessions ?? 0,
      convertedSessions: converted?.sessions ?? 0,
      totalVisitors: steps[0]?.visitors ?? 0,
      convertedVisitors: converted?.visitors ?? 0,
      overallConversionRate: steps[0]?.sessions
        ? (converted?.sessions ?? 0) / steps[0].sessions
        : 0,
      largestDropOffStepIndex,
    },
  };
}

export function generateDemoFunnels(
  siteId: string,
  params: Record<string, string | number>,
): FunnelListData | FunnelDetailData | ErrorEnvelope {
  const id = String(params.id ?? "").trim();
  const funnels = siteFunnels(siteId);
  if (!id) {
    const limit = Math.max(1, Number(params.limit ?? funnels.length));
    const items = funnels.slice(0, limit);
    return {
      ok: true,
      data: {
        items,
        pagination: {
          limit,
          returned: items.length,
          hasMore: items.length < funnels.length,
          nextCursor: null,
        },
      },
    };
  }

  const funnel = funnels.find((item) => item.id === id);
  if (!funnel) return demoNotFound();
  if (funnel.steps.length < 2) {
    return demoBadRequest("Funnel has fewer than 2 steps");
  }
  return {
    ok: true,
    data: { funnel, analysis: analysisFor(funnel) },
  };
}

export function createDemoFunnel(
  siteId: string,
  body: unknown,
): FunnelMutationData | ErrorEnvelope {
  const payload = body && typeof body === "object" ? body : {};
  const record = payload as Record<string, unknown>;
  const name = String(record.name ?? "").trim();
  if (!name) return demoBadRequest("Name is required");
  const steps = normalizeDemoSteps(record.steps);
  if (steps.length < 2) return demoBadRequest("At least 2 steps are required");
  customFunnelCounter += 1;
  const now = Math.floor(Date.now() / 1000);
  const funnel: FunnelDefinition = {
    id: `demo-funnel-custom-${customFunnelCounter}`,
    siteId,
    name,
    steps,
    createdAt: now,
    updatedAt: now,
  };
  demoFunnels.unshift(funnel);
  return { ok: true, data: { funnel } };
}

export function deleteDemoFunnel(
  siteId: string,
  params: Record<string, string | number>,
): { ok: boolean } | ErrorEnvelope {
  const id = String(params.id ?? "").trim();
  if (!id) return demoBadRequest("Funnel id is required");
  const index = demoFunnels.findIndex(
    (funnel) => funnel.siteId === siteId && funnel.id === id,
  );
  if (index >= 0) demoFunnels.splice(index, 1);
  return { ok: true };
}
