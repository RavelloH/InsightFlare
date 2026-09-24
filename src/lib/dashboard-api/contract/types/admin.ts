import type { TeamRole } from "@/lib/dashboard/permissions";

export interface TeamData {
  id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  createdAt: number;
  updatedAt?: number;
  siteCount: number;
  memberCount: number;
  membershipRole?: TeamRole;
}

export interface SessionTeamGroups {
  created: TeamData[];
  managed: TeamData[];
  member: TeamData[];
  system: TeamData[];
}

export interface SiteData {
  id: string;
  teamId: string;
  name: string;
  domain: string;
  iconPath?: string;
  publicEnabled: number | boolean;
  publicSlug: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MemberData {
  teamId: string;
  userId: string;
  role: TeamRole;
  siteIds: string[];
  joinedAt: number;
  username: string;
  email: string;
  name: string | null;
}

export interface AccountUserData {
  id: string;
  username: string;
  email: string;
  name: string;
  systemRole: "admin" | "user";
  timeZone?: string;
  preferredLocale: "" | "en" | "zh";
  createdAt: number;
  updatedAt: number;
  teamCount?: number;
  ownedTeamCount?: number;
}

export type ApiKeyScope =
  | "analytics:read"
  | "analysis:read"
  | "analysis:write"
  | "site:read"
  | "site:write"
  | "site_config:read"
  | "site_config:write";

export interface ApiKeyData {
  id: string;
  teamId: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  siteIds: string[];
  createdByUserId: string;
  expiresAt: number | null;
  revokedAt: number | null;
  revokedByUserId: string;
  rotatedFromKeyId: string;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
  status: "active" | "expired" | "revoked";
}

export type NotificationDeliveryStatus =
  "created" | "sending" | "sent" | "partial" | "failed" | "skipped";

export interface NotificationRuleData {
  id: string;
  teamId: string;
  siteId: string | null;
  name: string;
  description: string;
  type: string;
  enabled: boolean;
  schedule: Record<string, unknown>;
  condition: Record<string, unknown>;
  recipient: Record<string, unknown>;
  state: Record<string, unknown>;
  lastCheckedAt: number | null;
  lastTriggeredAt: number | null;
  nextRunAt: number | null;
  cooldownUntil: number | null;
  createdByUserId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type NotificationRuleEvaluationData =
  | {
      status: "skipped";
      reason: string;
      data?: Record<string, unknown>;
    }
  | {
      status: "checked";
      triggered: false;
      summary: string;
      data?: Record<string, unknown>;
    }
  | {
      status: "triggered";
      message: {
        type: string;
        severity: string;
        requiresAttention: boolean;
        title: string;
        summary: string;
        bodyText: string;
        bodyHtml?: string;
        data?: Record<string, unknown>;
      };
      cooldownUntil?: number | null;
      data?: Record<string, unknown>;
    };

export interface NotificationRuleRunData {
  evaluation: NotificationRuleEvaluationData;
  messages: NotificationMessageData[];
  messageCount: number;
  summary: Record<string, unknown>;
}

export interface NotificationMessageData {
  id: string;
  teamId: string;
  siteId: string | null;
  userId: string;
  ruleId: string | null;
  runId: string | null;
  batchId: string | null;
  type: string;
  severity: string;
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
