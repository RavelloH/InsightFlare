import type {
  FunnelAnalysis,
  FunnelDefinition,
  FunnelDetailData,
  FunnelListData,
  FunnelMutationData,
  FunnelStep,
} from "@/lib/edge-client";
import { demoBadRequest, demoNotFound } from "@/lib/realtime/mock/envelope";
import { demoPage } from "@/lib/realtime/mock/pagination";
import type { ErrorEnvelope } from "@/lib/response-envelope";

const CREATED_AT = 1_767_225_600;
let customFunnelCounter = 0;

function step(id: string, filterDsl: string, name?: string): FunnelStep {
  return { id, filterDsl, ...(name ? { name } : {}) };
}

const demoFunnels: FunnelDefinition[] = [
  {
    id: "demo-funnel-signup",
    siteId: "demo-site-001",
    name: "Signup activation",
    filterDslVersion: 1,
    progressionScope: "session",
    conversionWindowMs: null,
    semanticFingerprint: "demo-funnel-signup-v2",
    steps: [
      step("landing", 'page.path eq "/pricing"'),
      step("started", 'event.name eq "signup_started"'),
      step("completed", 'event.name eq "signup_completed"'),
      step("onboarding", 'page.path eq "/app/onboarding"'),
    ],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT + 86_400,
  },
  {
    id: "demo-funnel-checkout",
    siteId: "demo-site-001",
    name: "Checkout",
    filterDslVersion: 1,
    progressionScope: "visitor",
    conversionWindowMs: 7 * 86_400_000,
    semanticFingerprint: "demo-funnel-checkout-v2",
    steps: [
      step("products", 'page.path eq "/products"'),
      step("cart", 'event.name eq "cart_add"'),
      step("checkout", 'page.path eq "/checkout"'),
      step("purchase", 'event.name eq "purchase"'),
    ],
    createdAt: CREATED_AT - 172_800,
    updatedAt: CREATED_AT + 43_200,
  },
];

function cloneFunnel(funnel: FunnelDefinition): FunnelDefinition {
  return { ...funnel, steps: funnel.steps.map((item) => ({ ...item })) };
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
  return templates.map(cloneFunnel);
}

function analysisFor(funnel: FunnelDefinition): FunnelAnalysis {
  const base = funnel.id.includes("checkout") ? 1260 : 1840;
  const retention = funnel.id.includes("checkout")
    ? [1, 0.62, 0.39, 0.24]
    : [1, 0.54, 0.38, 0.31];
  const progressionCounts = funnel.steps.map((_, index) =>
    Math.round(
      base * (retention[index] ?? Math.max(0.12, 0.31 - index * 0.06)),
    ),
  );
  const sessionCounts = progressionCounts.map((count) =>
    funnel.progressionScope === "session" ? count : Math.round(count * 0.78),
  );
  const visitorCounts = progressionCounts.map((count) =>
    funnel.progressionScope === "visitor" ? count : Math.round(count * 0.82),
  );
  let largestDropOffStepIndex: number | null = null;
  let largestDropOff = 0;
  const first = progressionCounts[0] ?? 0;
  const steps = funnel.steps.map((stepConfig, index) => {
    const count = progressionCounts[index] ?? 0;
    const previous = index === 0 ? count : (progressionCounts[index - 1] ?? 0);
    const dropOffCount = index === 0 ? 0 : Math.max(0, previous - count);
    if (index > 0 && dropOffCount > largestDropOff) {
      largestDropOff = dropOffCount;
      largestDropOffStepIndex = index;
    }
    return {
      stepId: stepConfig.id,
      index,
      sessions: sessionCounts[index] ?? 0,
      visitors: visitorCounts[index] ?? 0,
      progression: {
        count,
        conversionRate: first > 0 ? count / first : 0,
        stepConversionRate: previous > 0 ? count / previous : 0,
        dropOffCount,
        dropOffRate: previous > 0 ? dropOffCount / previous : 0,
      },
    };
  });
  const converted = steps.at(-1)?.progression.count ?? 0;
  return {
    progressionScope: funnel.progressionScope,
    steps,
    summary: {
      totalProgressions: first,
      convertedProgressions: converted,
      overallConversionRate: first > 0 ? converted / first : 0,
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
    return {
      ok: true,
      data: demoPage(
        funnels,
        params,
        { operation: "funnels", siteId, sort: "createdAt:desc,id:desc" },
        50,
        100,
      ),
    };
  }
  const funnel = funnels.find((item) => item.id === id);
  if (!funnel) return demoNotFound();
  if (funnel.steps.length < 2)
    return demoBadRequest("Funnel has fewer than 2 steps");
  return { ok: true, data: { funnel, analysis: analysisFor(funnel) } };
}

function parseV2Input(record: Record<string, unknown>): {
  progressionScope: "session" | "visitor";
  conversionWindowMs: number | null;
  steps: FunnelStep[];
} | null {
  const progressionScope = record.progressionScope ?? "session";
  const conversionWindowMs = record.conversionWindowMs ?? null;
  if (
    (progressionScope !== "session" && progressionScope !== "visitor") ||
    (progressionScope === "session" && conversionWindowMs !== null) ||
    (progressionScope === "visitor" &&
      (typeof conversionWindowMs !== "number" ||
        !Number.isFinite(conversionWindowMs) ||
        conversionWindowMs <= 0)) ||
    !Array.isArray(record.steps) ||
    record.steps.length < 2 ||
    record.steps.length > 10
  )
    return null;
  const steps = record.steps.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.id !== "string" ||
      !candidate.id.trim() ||
      typeof candidate.filterDsl !== "string" ||
      !candidate.filterDsl.trim()
    )
      return [];
    return [
      {
        id: candidate.id,
        filterDsl: candidate.filterDsl,
        ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
      },
    ];
  });
  const ids = new Set(steps.map((item) => item.id));
  return ids.size === steps.length && steps.length === record.steps.length
    ? {
        progressionScope,
        conversionWindowMs: conversionWindowMs as number | null,
        steps,
      }
    : null;
}

function semanticFingerprintFor(
  id: string,
  config: Pick<
    FunnelDefinition,
    "progressionScope" | "conversionWindowMs" | "steps"
  >,
): string {
  return `${id}-v2-${config.progressionScope}-${config.conversionWindowMs ?? "none"}-${config.steps
    .map((item) => `${item.id}:${item.filterDsl}`)
    .join("|")}`;
}

export function createDemoFunnel(
  siteId: string,
  body: unknown,
): FunnelMutationData | ErrorEnvelope {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const config = parseV2Input(record);
  if (!name || !config) return demoBadRequest("Invalid funnel configuration");
  customFunnelCounter += 1;
  const now = Math.floor(Date.now() / 1000);
  const funnel: FunnelDefinition = {
    id: `demo-funnel-custom-${customFunnelCounter}`,
    siteId,
    name,
    filterDslVersion: 1,
    ...config,
    semanticFingerprint: semanticFingerprintFor(
      `demo-funnel-custom-${customFunnelCounter}`,
      config,
    ),
    createdAt: now,
    updatedAt: now,
  };
  demoFunnels.unshift(funnel);
  return { ok: true, data: { funnel: cloneFunnel(funnel) } };
}

export function updateDemoFunnel(
  siteId: string,
  params: Record<string, string | number>,
  body: unknown,
): FunnelMutationData | ErrorEnvelope {
  const id = String(params.id ?? "").trim();
  const index = demoFunnels.findIndex(
    (funnel) => funnel.siteId === siteId && funnel.id === id,
  );
  if (index < 0) return demoNotFound();
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const current = demoFunnels[index]!;
  const merged = {
    ...current,
    ...record,
    steps: record.steps ?? current.steps,
  };
  const config = parseV2Input(merged);
  const name = typeof merged.name === "string" ? merged.name.trim() : "";
  if (!name || !config) return demoBadRequest("Invalid funnel configuration");
  const next = {
    ...current,
    name,
    ...config,
    semanticFingerprint: semanticFingerprintFor(current.id, config),
    updatedAt: Math.floor(Date.now() / 1000),
  };
  demoFunnels[index] = next;
  return { ok: true, data: { funnel: cloneFunnel(next) } };
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
