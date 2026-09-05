import type { PublicAnalyticsEngineConfig } from "@/lib/analytics-engine-config";
import type { AdminPublicLoginTurnstileConfig } from "@/lib/auth/login-turnstile-config";
import type { NotificationPreferencesData } from "@/lib/edge-client";
import type {
  AccountUserData,
  ApiKeyData,
  MemberData,
  NotificationMessageData,
  NotificationRuleData,
  SiteData,
  TeamData,
} from "@/lib/edge-client-types";
import type { PublicNotificationEmailConfig } from "@/lib/notifications/email-config";
import type { PageResult } from "@/lib/pagination";
import type {
  ScheduledTaskRetentionConfig,
  ScheduledTaskRun,
  ScheduledTaskRunGroup,
  ScheduledTaskRunLog,
  ScheduledTasksData,
  ScheduledTaskSummary,
} from "@/lib/scheduled-tasks";
import type { SiteSettingsConfig } from "@/lib/site-settings";
import type { SystemPerformanceData } from "@/lib/system-performance";

export type ManagementJsonValue =
  | string
  | number
  | boolean
  | null
  | ManagementJsonValue[]
  | { [key: string]: ManagementJsonValue };

export type ManagementJsonObject = {
  [key: string]: ManagementJsonValue;
};

export type SerializableNotificationRuleData = Omit<
  NotificationRuleData,
  "schedule" | "condition" | "recipient" | "state"
> & {
  schedule: ManagementJsonObject;
  condition: ManagementJsonObject;
  recipient: ManagementJsonObject;
  state: ManagementJsonObject;
};

export type SerializableNotificationMessageData = Omit<
  NotificationMessageData,
  "data" | "channels" | "deliveryResults"
> & {
  data: ManagementJsonObject;
  channels: ManagementJsonObject;
  deliveryResults: ManagementJsonObject;
};

export type SerializableScheduledTaskRun = Omit<ScheduledTaskRun, "summary"> & {
  summary: ManagementJsonObject;
};

export type SerializableScheduledTaskRunLog = Omit<
  ScheduledTaskRunLog,
  "data"
> & {
  data: ManagementJsonObject;
};

export type SerializableScheduledTaskRunGroup = Omit<
  ScheduledTaskRunGroup,
  "summary" | "runs"
> & {
  summary: ManagementJsonObject;
  runs: SerializableScheduledTaskRun[];
};

export type SerializableScheduledTaskSummary = Omit<
  ScheduledTaskSummary,
  "lastRun"
> & {
  lastRun: SerializableScheduledTaskRun | null;
};

export type SerializableScheduledTasksData = Omit<
  ScheduledTasksData,
  "tasks" | "runs" | "selectedRun" | "logs"
> & {
  tasks: SerializableScheduledTaskSummary[];
  runs: Omit<PageResult<ScheduledTaskRunGroup>, "items"> & {
    items: SerializableScheduledTaskRunGroup[];
  };
  selectedRun: SerializableScheduledTaskRunGroup | null;
  logs: Omit<PageResult<ScheduledTaskRunLog>, "items"> & {
    items: SerializableScheduledTaskRunLog[];
  };
};

export interface TeamInviteData {
  id: string;
  email: string;
  payload: {
    teamRole?: "member" | "admin";
    siteIds?: string[];
  };
  code?: string;
  url?: string;
  createdByUserId: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedByUserId: string;
  revokedAt: number | null;
  status: "active" | "used" | "revoked" | "expired";
}

export type SafeTeamInviteData = Omit<TeamInviteData, "code" | "url">;

export interface CreatedTeamInviteData {
  invite: TeamInviteData;
  url: string;
}

export interface ScriptSnippetData {
  siteId: string;
  src: string;
  snippet: string;
}

export interface SiteSettingsInitialData {
  config: SiteSettingsConfig;
  scriptSnippet: string;
  origin: string;
  fetchedAt: number;
}

export interface TeamManagementInitialData {
  members: MemberData[];
  sites: SiteData[];
  invites: SafeTeamInviteData[];
  fetchedAt: number;
}

export interface ApiKeysInitialData {
  keys: ApiKeyData[];
  fetchedAt: number;
}

export interface TeamNotificationsInitialData {
  rules: SerializableNotificationRuleData[];
  sites: SiteData[];
  members: MemberData[];
  emailConfigured: boolean;
  fetchedAt: number;
}

export interface NotificationCenterInitialData {
  messages: SerializableNotificationMessageData[];
  unreadAttentionCount: number;
  fetchedAt: number;
}

export interface AccountNotificationPreferencesInitialData {
  preferences: NotificationPreferencesData;
  fetchedAt: number;
}

export interface AdminTeamsInitialData {
  teams: TeamData[];
  fetchedAt: number;
}

export interface AdminUsersInitialData {
  users: AccountUserData[];
  fetchedAt: number;
}

export interface SystemSettingsInitialData {
  analyticsEngine: PublicAnalyticsEngineConfig;
  loginTurnstile: AdminPublicLoginTurnstileConfig;
  notificationEmail: PublicNotificationEmailConfig;
  scheduledTaskRetention: ScheduledTaskRetentionConfig;
  fetchedAt: number;
}

export type ScheduledTasksInitialData = SerializableScheduledTasksData & {
  fetchedAt: number;
};

export interface SystemPerformanceInitialData {
  data: SystemPerformanceData;
  fetchedAt: number;
}
