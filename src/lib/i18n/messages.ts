import type { Locale } from "./config";
import en from "@/i18n/en.yaml";
import zh from "@/i18n/zh.yaml";

export interface AppMessages {
  appName: string;
  navigation: {
    overview: string;
    pages: string;
    referrers: string;
    sessions: string;
    events: string;
    visitors: string;
    geo: string;
    devices: string;
    browsers: string;
  };
  common: {
    views: string;
    sessions: string;
    visitors: string;
    bounces: string;
    bounceRate: string;
    avgDuration: string;
    page: string;
    referrer: string;
    startedAt: string;
    endedAt: string;
    event: string;
    location: string;
    browser: string;
    device: string;
    country: string;
    duration: string;
    loading: string;
    noData: string;
    unknown: string;
    lastUpdated: string;
    site: string;
    team: string;
  };
  ranges: {
    title: string;
    last24h: string;
    last7d: string;
    last30d: string;
    last90d: string;
  };
  filters: {
    title: string;
    country: string;
    device: string;
    browser: string;
    eventType: string;
    all: string;
    clear: string;
  };
  realtime: {
    title: string;
    subtitle: string;
    activeNow: string;
    connected: string;
    disconnected: string;
    recentEvents: string;
  };
  overview: {
    title: string;
    subtitle: string;
    trendTitle: string;
    engagementTitle: string;
    compositionTitle: string;
    eventTypesTitle: string;
    sessionDurationTitle: string;
    topPages: string;
    topReferrers: string;
    recentSessions: string;
    recentEvents: string;
  };
  pages: {
    title: string;
    subtitle: string;
  };
  referrers: {
    title: string;
    subtitle: string;
  };
  sessions: {
    title: string;
    subtitle: string;
  };
  events: {
    title: string;
    subtitle: string;
  };
  visitors: {
    title: string;
    subtitle: string;
  };
  geo: {
    title: string;
    subtitle: string;
  };
  devices: {
    title: string;
    subtitle: string;
  };
  browsers: {
    title: string;
    subtitle: string;
  };
  login: {
    title: string;
    subtitle: string;
    username: string;
    password: string;
    signIn: string;
    invalidCredentials: string;
  };
  empty: {
    noTeams: string;
    noSites: string;
    siteNotFound: string;
  };
  actions: {
    logout: string;
    switchToEnglish: string;
    switchToChinese: string;
    switchToLight: string;
    switchToDark: string;
  };
}

const DICTIONARIES: Record<Locale, AppMessages> = {
  en: en as AppMessages,
  zh: zh as AppMessages,
};

export function getMessages(locale: Locale): AppMessages {
  return DICTIONARIES[locale];
}

