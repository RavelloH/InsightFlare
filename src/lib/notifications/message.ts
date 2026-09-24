import type {
  NotificationDeliveryStatus,
  NotificationMessageType,
  NotificationSeverity,
} from "./message-types";

/** Runtime-neutral notification message contract shared by UI, Demo, and Edge. */
export interface NotificationMessage {
  id: string;
  teamId: string;
  siteId: string | null;
  userId: string;
  ruleId: string | null;
  runId: string | null;
  batchId: string | null;
  type: NotificationMessageType;
  severity: NotificationSeverity;
  requiresAttention: boolean;
  title: string;
  summary: string;
  bodyText: string;
  bodyHtml: string;
  data: Record<string, unknown>;
  channels: Record<string, unknown>;
  deliveryStatus: NotificationDeliveryStatus;
  deliveryResults: Record<string, unknown>;
  errorMessage: string;
  readAt: number | null;
  dismissedAt: number | null;
  archivedAt: number | null;
  triggeredAt: number | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  failedAt: number | null;
  expiresAt: number | null;
}

export interface NotificationMessageDraft {
  type: NotificationMessageType;
  severity: NotificationSeverity;
  requiresAttention: boolean;
  title: string;
  summary: string;
  bodyText: string;
  bodyHtml?: string;
  data?: Record<string, unknown>;
}
