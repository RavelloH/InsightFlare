import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import {
  type RealtimeConnectionState,
  RealtimeStatusDot,
  type RealtimeStatusDotProps,
} from "./realtime-status-dot";

function fixture(
  status: RealtimeConnectionState,
  title: string,
): ComponentFixture<RealtimeStatusDotProps> & { readonly id: string } {
  return {
    id: `realtime-status-dot.status.${status}`,
    title,
    presentation: { kind: "scenario", scenario: status },
    props: { status } satisfies RealtimeStatusDotProps,
  };
}

export const realtimeStatusDotFixtures = [
  fixture("connected", "Connected"),
  fixture("connecting", "Connecting"),
  fixture("disconnected", "Reconnecting"),
  fixture("failed", "Failed"),
] as const satisfies readonly ComponentFixture<RealtimeStatusDotProps>[];

export const realtimeStatusDotContract =
  defineComponentContract<RealtimeStatusDotProps>({
    id: "realtime-status-dot",
    title: "Realtime status dot",
    category: "Product UI / Realtime",
    categoryId: "product-realtime",
    description:
      "A props-only connection indicator with pulsing connected, connecting, reconnecting and failed states.",
    fixtures: realtimeStatusDotFixtures,
    render: (props) => <RealtimeStatusDot {...props} />,
  });
