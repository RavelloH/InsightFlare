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
    management: string;
    backToTeam: string;
    system: string;
    account: string;
    theme: string;
    language: string;
    role: string;
    admin: string;
    user: string;
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
  teamSelect: {
    groupLabel: string;
    createHint: string;
    createTitle: string;
    createDescription: string;
    nameLabel: string;
    namePlaceholder: string;
    slugLabel: string;
    slugPlaceholder: string;
    create: string;
    creating: string;
    cancel: string;
    invalidName: string;
    createFailed: string;
    createSuccess: string;
  };
  teamManagement: {
    title: string;
    subtitle: string;
    stats: {
      sites: string;
      members: string;
    };
    toasts: {
      teamSaved: string;
      teamSaveFailed: string;
      memberAdded: string;
      memberAddFailed: string;
      memberRemoved: string;
      memberRemoveFailed: string;
      invalidTeamName: string;
      invalidMemberIdentifier: string;
    };
    sites: {
      title: string;
      subtitle: string;
      noSites: string;
      openAnalytics: string;
      columns: {
        name: string;
        domain: string;
        slug: string;
        createdAt: string;
        action: string;
      };
    };
    settings: {
      title: string;
      subtitle: string;
      nameLabel: string;
      slugLabel: string;
      save: string;
      saving: string;
    };
    members: {
      title: string;
      subtitle: string;
      identifierLabel: string;
      identifierPlaceholder: string;
      add: string;
      adding: string;
      remove: string;
      removing: string;
      noMembers: string;
      columns: {
        name: string;
        username: string;
        email: string;
        role: string;
        joinedAt: string;
        action: string;
      };
    };
  };
  managementNav: {
    users: string;
    sites: string;
    teams: string;
  };
  adminUsers: {
    title: string;
    subtitle: string;
    createTitle: string;
    createSubtitle: string;
    username: string;
    email: string;
    name: string;
    password: string;
    role: string;
    create: string;
    creating: string;
    listTitle: string;
    listSubtitle: string;
    noData: string;
    loadFailed: string;
    createSuccess: string;
    createFailed: string;
    invalidInput: string;
    columns: {
      name: string;
      username: string;
      email: string;
      role: string;
      teams: string;
      created: string;
    };
  };
  adminSites: {
    title: string;
    subtitle: string;
    team: string;
    createTitle: string;
    createSubtitle: string;
    name: string;
    domain: string;
    publicSlug: string;
    create: string;
    creating: string;
    listTitle: string;
    listSubtitle: string;
    noData: string;
    loadFailed: string;
    createSuccess: string;
    createFailed: string;
    invalidInput: string;
    open: string;
    columns: {
      name: string;
      domain: string;
      slug: string;
      created: string;
      action: string;
    };
  };
  adminTeams: {
    title: string;
    subtitle: string;
    createTitle: string;
    createSubtitle: string;
    name: string;
    slug: string;
    create: string;
    creating: string;
    listTitle: string;
    listSubtitle: string;
    noData: string;
    loadFailed: string;
    createSuccess: string;
    createFailed: string;
    invalidInput: string;
    open: string;
    columns: {
      name: string;
      slug: string;
      sites: string;
      members: string;
      created: string;
      action: string;
    };
  };
  loginForm: {
    signingIn: string;
    failed: string;
  };
  logoutAction: {
    pending: string;
    success: string;
    failed: string;
  };
  sidebarFooter: {
    loggingOut: string;
    logoutSuccess: string;
    logoutFailed: string;
  };
  teamEntry: {
    title: string;
    description: string;
  };
}

const DICTIONARIES: Record<Locale, AppMessages> = {
  en: en as AppMessages,
  zh: zh as AppMessages,
};

export function getMessages(locale: Locale): AppMessages {
  return DICTIONARIES[locale];
}

