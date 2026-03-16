import type { Locale } from "./config";
import en from "@/i18n/en.yaml";
import zh from "@/i18n/zh.yaml";

export interface AppMessages {
  appName: string;
  navigation: {
    overview: string;
    realtime: string;
    pages: string;
    referrers: string;
    sessions: string;
    events: string;
    visitors: string;
    geo: string;
    devices: string;
    browsers: string;
    settings: string;
  };
  common: {
    views: string;
    sessions: string;
    visitors: string;
    bounces: string;
    bounceRate: string;
    avgDuration: string;
    page: string;
    path: string;
    title: string;
    hostname: string;
    entryPage: string;
    exitPage: string;
    referrer: string;
    startedAt: string;
    endedAt: string;
    event: string;
    location: string;
    browser: string;
    operatingSystem: string;
    device: string;
    deviceType: string;
    country: string;
    region: string;
    city: string;
    continent: string;
    continentLabels: Record<string, string>;
    timezone: string;
    organization: string;
    screenSize: string;
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
    search: string;
    time: string;
    cycle: string;
    close: string;
  };
  ranges: {
    title: string;
    last30m: string;
    last1h: string;
    today: string;
    yesterday: string;
    thisWeek: string;
    thisMonth: string;
    thisYear: string;
    last24h: string;
    last7d: string;
    last30d: string;
    last90d: string;
    last6m: string;
    last12m: string;
    allTime: string;
    custom: string;
  };
  intervals: {
    title: string;
    minute: string;
    hour: string;
    day: string;
    week: string;
    month: string;
  };
  dashboardHeader: {
    range: string;
    interval: string;
    filters: string;
    customRange: string;
    customHint: string;
    customPendingEnd: string;
    customApply: string;
    rangeGroupQuick: string;
    rangeGroupCalendar: string;
    rangeGroupRolling: string;
    rangeGroupAdvanced: string;
    intervalDisabledMinute: string;
    intervalDisabledHour: string;
    intervalDisabledDay: string;
    intervalDisabledWeek: string;
    filterTitle: string;
    filterSubtitle: string;
    previousPeriod: string;
    nextPeriod: string;
    customSelectionSummary: string;
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
    liveMetrics: string;
    visitors30m: string;
    views30m: string;
    connected: string;
    connecting: string;
    disconnected: string;
    reconnecting: string;
    failed: string;
    recentEvents: string;
    enterPage: string;
    leavePage: string;
    viewPage: string;
    customEvent: string;
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
    sourceTab: string;
    sourceDomainColumn: string;
    sourceLinkTab: string;
    sourceLinkColumn: string;
    direct: string;
    searchInTab: string;
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
  siteSettings: {
    title: string;
    subtitle: string;
    editTitle: string;
    editSubtitle: string;
    nameLabel: string;
    domainLabel: string;
    publicSlugLabel: string;
    trackingStrengthGroupTitle: string;
    trackingStrengthDescription: string;
    trackingStrengthLabel: string;
    trackingStrengthStrong: string;
    trackingStrengthSmart: string;
    trackingStrengthWeak: string;
    trackingStrengthStrongDescription: string;
    trackingStrengthSmartDescription: string;
    trackingStrengthWeakDescription: string;
    queryHashGroupTitle: string;
    queryHashGroupDescription: string;
    trackQueryParamsLabel: string;
    trackHashLabel: string;
    rulesGroupTitle: string;
    rulesGroupDescription: string;
    domainWhitelistTitle: string;
    domainWhitelistDescription: string;
    domainWhitelistLabel: string;
    domainWhitelistPlaceholder: string;
    domainWhitelistHint: string;
    pathBlacklistTitle: string;
    pathBlacklistDescription: string;
    pathBlacklistLabel: string;
    pathBlacklistPlaceholder: string;
    pathBlacklistHint: string;
    privacyGroupTitle: string;
    privacyGroupDescription: string;
    ignoreDoNotTrackLabel: string;
    booleanOn: string;
    booleanOff: string;
    loadingSettings: string;
    saveTracking: string;
    savingTracking: string;
    save: string;
    saving: string;
    transferTitle: string;
    transferSubtitle: string;
    transferTeamLabel: string;
    transfer: string;
    transferring: string;
    scriptTitle: string;
    scriptSubtitle: string;
    scriptHint: string;
    copyScript: string;
    copiedScript: string;
    loadingScript: string;
    scriptUnavailable: string;
    deleteTitle: string;
    deleteSubtitle: string;
    delete: string;
    deleting: string;
    deleteConfirm: string;
    toasts: {
      saved: string;
      saveFailed: string;
      transferred: string;
      transferFailed: string;
      scriptLoadFailed: string;
      settingsLoadFailed: string;
      settingsPropagationHint: string;
      deleted: string;
      deleteFailed: string;
      invalidInput: string;
    };
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
      teamDeleted: string;
      teamDeleteFailed: string;
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
      aggregateTitle: string;
      fromLabel: string;
      toLabel: string;
      applyRange: string;
      invalidRange: string;
      pagesPerSession: string;
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
      delete: string;
      deleting: string;
      deleteConfirm: string;
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
    delete: string;
    deleting: string;
    deleteConfirm: string;
    deleteSuccess: string;
    deleteFailed: string;
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
      action: string;
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
    settings: string;
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
