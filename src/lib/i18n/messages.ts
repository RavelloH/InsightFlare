import type { Locale } from "./config";

export interface AppMessages {
  appName: string;
  navigation: {
    overview: string;
    realtime: string;
    pages: string;
    referrers: string;
    sessions: string;
    events: string;
    funnels: string;
    campaigns: string;
    visitors: string;
    retention: string;
    geo: string;
    devices: string;
    browsers: string;
    performance: string;
    settings: string;
  };
  common: {
    deviceLabels: {
      desktop: string;
      mobile: string;
      tablet: string;
    };
    timeRelativePair: string;
    id: string;
    views: string;
    sessions: string;
    visitors: string;
    bounceRate: string;
    avgDuration: string;
    path: string;
    title: string;
    hostname: string;
    referrerHost: string;
    entryPage: string;
    exitPage: string;
    referrer: string;
    startedAt: string;
    event: string;
    location: string;
    browser: string;
    operatingSystem: string;
    deviceType: string;
    country: string;
    region: string;
    regionCode: string;
    city: string;
    continent: string;
    latitude: string;
    longitude: string;
    continentLabels: Record<string, string>;
    timezone: string;
    organization: string;
    screenSize: string;
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
    tableExport: {
      action: string;
      title: string;
      description: string;
      scopeLabel: string;
      currentTab: string;
      allTabs: string;
      rowsLabel: string;
      currentView: string;
      rawRows: string;
      fileNameLabel: string;
      download: string;
      empty: string;
      allTabsUnavailable: string;
    };
    time: string;
    cycle: string;
    close: string;
    sitesFiltered: string;
    cumulativeTraffic: string;
  };
  ranges: {
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
    country: string;
    device: string;
    browser: string;
    all: string;
    clear: string;
  };
  filterBuilder: {
    fieldGroups: {
      page: string;
      session: string;
      referrer: string;
      campaign: string;
      client: string;
      geography: string;
      event: string;
    };
    fieldLabels: Record<string, string>;
    operatorLabels: Record<string, string>;
    valueType: string;
    valueKinds: {
      string: string;
      enum: string;
      number: string;
      boolean: string;
      date: string;
      datetime: string;
      "json-scalar": string;
    };
    booleanTrue: string;
    booleanFalse: string;
    valueUnset: string;
    valueLoading: string;
    valueSearchPlaceholder: string;
    valueListPlaceholder: string;
    rangeStartPlaceholder: string;
    rangeEndPlaceholder: string;
    jsonPointer: string;
    match: string;
    expression: string;
    expressionPlaceholder: string;
    expressionInvalid: string;
    expressionHelpTitle: string;
    expressionHelpDescription: string;
    expressionHelpSyntax: string;
    expressionHelpLogicDescription: string;
    expressionHelpValues: string;
    expressionHelpValuesDescription: string;
    expressionHelpOperators: string;
    expressionHelpUnaryOperators: string;
    expressionHelpFields: string;
    expressionHelpFieldType: string;
    expressionHelpFieldOperators: string;
    expressionHelpOtherFields: string;
    apply: string;
    allConditions: string;
    anyCondition: string;
    condition: string;
    group: string;
    invertCondition: string;
    exclude: string;
    addGroup: string;
    invalid: string;
  };
  realtime: {
    title: string;
    subtitle: string;
    logTitleSeparator: string;
    activeNow: string;
    liveMetrics: string;
    connected: string;
    connecting: string;
    reconnecting: string;
    failed: string;
    recentEvents: string;
    enterPage: string;
    leavePage: string;
    viewPage: string;
    customEvent: string;
    detailsTitle: string;
    detailsSection: string;
    visitorHistorySection: string;
    visitorHistorySubtitle: string;
    visitorHistoryEmpty: string;
    visitorMapSection: string;
    visitorMapSubtitle: string;
    visitorMapUnavailable: string;
    visitorId: string;
    sessionId: string;
    visitId: string;
    eventType: string;
    eventTime: string;
  };
  overview: {
    title: string;
    subtitle: string;
    trendTitle: string;
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
    pagesPerSession: string;
    untitled: string;
    empty: string;
    loadError: string;
    loadMoreError: string;
    retry: string;
    trendTitle: string;
    otherPages: string;
    hashTab: string;
    noHash: string;
    queryTab: string;
    noQuery: string;
    eventTab: string;
    eventsMetric: string;
    viewDetails: string;
  };
  referrers: {
    title: string;
    subtitle: string;
    summaryTitle: string;
    splitTitle: string;
    chartTitle: string;
    radarTitle: string;
    radarSubtitle: string;
    radarDuration: string;
    radarEngagement: string;
    radarDepth: string;
    radarLoyalty: string;
    radarFrequency: string;
    radarTraffic: string;
    directSourceNote: string;
    breakdownTitle: string;
    directViews: string;
    uniqueDomains: string;
    uniqueLinks: string;
    topSource: string;
    topSourceShare: string;
    noExternalSource: string;
    externalLabel: string;
    nextSources: string;
    longTail: string;
  };
  campaigns: {
    title: string;
    subtitle: string;
    tabSource: string;
    tabMedium: string;
    tabCampaign: string;
    tabTerm: string;
    tabContent: string;
    breakdownTitle: string;
    notSet: string;
    noTaggedTraffic: string;
  };
  sessions: {
    title: string;
    subtitle: string;
    search: string;
    started: string;
    sessionId: string;
    visitor: string;
    anonymous: string;
    entryPage: string;
    exitPage: string;
    duration: string;
    referrer: string;
    location: string;
    os: string;
    browser: string;
    device: string;
    pageViews: string;
    loadError: string;
    empty: string;
  };
  sessionDetail: {
    anonymous: string;
    back: string;
    missing: string;
    notFound: string;
    loadError: string;
    active: string;
    inactive: string;
    status: string;
    duration: string;
    screenViews: string;
    events: string;
    bounce: string;
    entryPath: string;
    exitPath: string;
    referrerName: string;
    os: string;
    browser: string;
    device: string;
    screen: string;
    yes: string;
    no: string;
    uniquePages: string;
    firstEvent: string;
    lastEvent: string;
    sessionStarted: string;
    pageview: string;
    exitPage: string;
    customEvent: string;
    eventTitleSeparator: string;
    visitDetailsTitle: string;
    visitDetailsSubtitle: string;
    location: string;
    visitorId: string;
    sessionId: string;
    referrerUrl: string;
    emptyEvents: string;
    emptyCustomEvents: string;
    sincePrevious: string;
    geoLocationTitle: string;
    performanceTitle: string;
    range: string;
  };
  events: {
    title: string;
    subtitle: string;
    detailTitle: string;
    detailSubtitle: string;
    typeDetailSubtitle: string;
    backToEvents: string;
    totalEvents: string;
    eventTypes: string;
    sessions: string;
    visitors: string;
    avgEventsPerSession: string;
    shareOfAllEvents: string;
    triggerCount: string;
    triggerVisitors: string;
    trendTitle: string;
    topEvents: string;
    recordsTitle: string;
    fieldsTitle: string;
    fieldsSubtitle: string;
    fieldValuesTitle: string;
    fieldValuesSubtitle: string;
    fieldValuesEmpty: string;
    payloadFilter: string;
    payloadFilterTitle: string;
    payloadFilterSubtitle: string;
    payloadFilterPlaceholder: string;
    payloadFilterApply: string;
    payloadFilterClear: string;
    payloadFilterInvalid: string;
    expandField: string;
    collapseField: string;
    breakdownTitle: string;
    search: string;
    eventName: string;
    eventId: string;
    occurredAt: string;
    receivedAt: string;
    page: string;
    context: string;
    visitor: string;
    visit: string;
    referrer: string;
    location: string;
    browser: string;
    os: string;
    device: string;
    payload: string;
    payloadFields: string;
    values: string;
    nodes: string;
    occurrences: string;
    openVisitor: string;
    openSession: string;
    copyJson: string;
    copiedJson: string;
    copyJsonFailed: string;
    copyValue: string;
    copiedValue: string;
    copyValueFailed: string;
    loadError: string;
    empty: string;
    emptyFields: string;
    noEventName: string;
    loading: string;
    other: string;
  };
  funnels: {
    title: string;
    subtitle: string;
    listTitle: string;
    listSubtitle: string;
    create: string;
    createTitle: string;
    createDescription: string;
    nameLabel: string;
    namePlaceholder: string;
    stepsLabel: string;
    addStep: string;
    removeStep: string;
    stepTypePageview: string;
    stepTypeEvent: string;
    stepValueLabel: string;
    pageviewPlaceholder: string;
    eventPlaceholder: string;
    save: string;
    creating: string;
    cancel: string;
    delete: string;
    deleteTitle: string;
    deleteDescription: string;
    deleteConfirm: string;
    deleting: string;
    empty: string;
    emptyHint: string;
    loadError: string;
    detailLoadError: string;
    invalidFunnel: string;
    created: string;
    createFailed: string;
    deleted: string;
    deleteFailed: string;
    overallConversion: string;
    startedSessions: string;
    convertedSessions: string;
    convertedVisitors: string;
    largestDropOff: string;
    noDropOff: string;
    step: string;
    sessions: string;
    visitors: string;
    conversion: string;
    stepConversion: string;
    dropOff: string;
    updated: string;
  };
  visitors: {
    title: string;
    subtitle: string;
    search: string;
    visitor: string;
    sessionId: string;
    anonymous: string;
    referrer: string;
    location: string;
    os: string;
    browser: string;
    device: string;
    firstSeen: string;
    lastSeen: string;
    pageViews: string;
    sessions: string;
    loadError: string;
    empty: string;
  };
  visitorDetail: {
    anonymous: string;
    back: string;
    missing: string;
    notFound: string;
    loadError: string;
    totalDuration: string;
    events: string;
    views: string;
    uniquePages: string;
    avgPagesPerSession: string;
    avgEventsPerSession: string;
    avgStay: string;
    firstSeen: string;
    lastSeen: string;
    daysActive: string;
    avgTimeBetweenSessions: string;
    activity: string;
    sessionRecords: string;
    started: string;
    visitor: string;
    duration: string;
    referrer: string;
    pageViews: string;
    visitDetailsTitle: string;
    visitDetailsSubtitle: string;
    customEvents: string;
    emptyEvents: string;
    emptyCustomEvents: string;
    emptySessions: string;
    visitorId: string;
    sessionId: string;
    referrerName: string;
    referrerUrl: string;
    location: string;
    browser: string;
    os: string;
    device: string;
    screen: string;
    entryPath: string;
    exitPath: string;
    sessionStarted: string;
    pageview: string;
    exitPage: string;
    customEvent: string;
    eventTitleSeparator: string;
    sincePrevious: string;
    geoLocationTitle: string;
    performanceTitle: string;
    range: string;
  };
  retention: {
    title: string;
    subtitle: string;
    cohortDate: string;
    cohortSize: string;
    periodLabel: string;
    matrixTitle: string;
    matrixSubtitle: string;
    cohortsMetric: string;
    visitorsMetric: string;
    periodOneMetric: string;
    averageReturnMetric: string;
    strongestCohortMetric: string;
    eligibleVisitors: string;
    periodsAnalyzed: string;
    noEligibleCohorts: string;
    weightedAverage: string;
    legendLow: string;
    legendHigh: string;
    periodZero: string;
    empty: string;
    emptyHint: string;
    loadError: string;
    unavailableCell: string;
    visitorsDetail: string;
    rateDetail: string;
    cohortDetail: string;
    sizeDetail: string;
  };
  geo: {
    title: string;
    subtitle: string;
    mapTitle: string;
    countryLabel: string;
    regionLabel: string;
    cityLabel: string;
    back: string;
    viewOnWikipedia: string;
    investigationNotice: string;
    timezoneDeltaVsLocal: string;
    visitorCoordinates: string;
    ipNotice: string;
    multipleNotice: string;
    investigation: {
      countryScopedLabel: string;
      capital: string;
      population: string;
      gdp: string;
      gdpPerCapita: string;
      marketPenetration: string;
      region: string;
      currency: string;
      phonecode: string;
      timezone: string;
      type: string;
      iso: string;
      coordinates: string;
      unavailable: string;
      gdpValue: string;
      gdpPerCapitaValue: string;
      gdpPerCapitaNearAverage: string;
      gdpPerCapitaAboveAverage: string;
      gdpPerCapitaBelowAverage: string;
      marketPenetrationWindow: string;
      timezoneCount: string;
      typeLabels: Record<string, string>;
    };
  };
  devices: {
    title: string;
    subtitle: string;
    deviceShareTitle: string;
    osShareTitle: string;
    deviceTrendTitle: string;
    osTrendTitle: string;
    screenDistributionTitle: string;
    screenDistributionSubtitle: string;
    screenBucketTitle: string;
    screenPreviewTitle: string;
    selectedViewportLabel: string;
    openSiteLabel: string;
    previewUnavailableLabel: string;
    browserByDeviceTitle: string;
    osByDeviceTitle: string;
    otherLabel: string;
    screenBucketLabels: {
      phoneCompact: string;
      phone: string;
      tablet: string;
      laptop: string;
      desktopWide: string;
      unclassified: string;
    };
  };
  browsers: {
    title: string;
    subtitle: string;
    trendTitle: string;
    engineTrendTitle: string;
    versionBreakdownTitle: string;
    osBreakdownTitle: string;
    deviceTypeBreakdownTitle: string;
    otherLabel: string;
    browserShareTitle: string;
    engineShareTitle: string;
    caniuseTitle: string;
    caniuseSubtitle: string;
    caniuseSearchPlaceholder: string;
    caniuseHotFeatures: string;
    caniuseTrendingFeatures: string;
    caniuseSiteSupport: string;
    caniuseGlobalSupport: string;
    caniuseClearSelection: string;
    caniuseNoMatch: string;
    caniuseFullSupport: string;
    caniusePartialSupport: string;
    caniuseNoSupport: string;
    radarTitle: string;
    radarSubtitle: string;
    radarDuration: string;
    radarEngagement: string;
    radarDepth: string;
    radarLoyalty: string;
    radarFrequency: string;
    radarTraffic: string;
  };
  performance: {
    title: string;
    subtitle: string;
    chartTitle: string;
    avgLabel: string;
    samplesLabel: string;
    p50Label: string;
    p75Label: string;
    p95Label: string;
    ttfb: string;
    fcp: string;
    lcp: string;
    cls: string;
    inp: string;
    ttfbDescription: string;
    fcpDescription: string;
    lcpDescription: string;
    clsDescription: string;
    inpDescription: string;
    msUnit: string;
    secondsUnit: string;
    clsUnit: string;
    score: string;
    scoreDescription: string;
    great: string;
    needsImprovement: string;
    poor: string;
    datasetTitle: string;
    interpretationTitle: string;
    currentReading: string;
    metricThresholdText: string;
    scoreThresholdText: string;
    countryHealthTitle: string;
    countryHealthSubtitle: string;
    pathsTitle: string;
    pathsAnalyzedLabel: string;
    metricValueColumn: string;
    statusColumn: string;
  };
  share: Record<string, never>;
  siteSettings: {
    title: string;
    subtitle: string;
    editTitle: string;
    editSubtitle: string;
    nameLabel: string;
    domainLabel: string;
    publicSharingTitle: string;
    publicSharingSubtitle: string;
    publicEnabledLabel: string;
    publicSlugLabel: string;
    publicSlugPlaceholder: string;
    publicSlugHint: string;
    publicLinkLabel: string;
    publicLinkHint: string;
    publicDisabledHint: string;
    copiedLink: string;
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
    ignoreDoNotTrackLabel: string;
    autoTrackGroupTitle: string;
    autoTrackGroupDescription: string;
    autoTrackOutboundLinksLabel: string;
    autoTrackOutboundLinksHint: string;
    performanceGroupTitle: string;
    performanceGroupDescription: string;
    performanceSampleRateLabel: string;
    performanceSampleRateHint: string;
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
  accountSettings: {
    title: string;
    subtitle: string;
    profileTitle: string;
    profileDescription: string;
    nicknameLabel: string;
    nicknamePlaceholder: string;
    usernameLabel: string;
    usernamePlaceholder: string;
    usernameDescription: string;
    emailLabel: string;
    emailPlaceholder: string;
    invalidProfile: string;
    profileSave: string;
    profileSaving: string;
    profileSaved: string;
    profileSaveFailed: string;
    passwordTitle: string;
    passwordDescription: string;
    currentPasswordLabel: string;
    newPasswordLabel: string;
    confirmPasswordLabel: string;
    currentPasswordRequired: string;
    passwordTooShort: string;
    passwordMismatch: string;
    passwordSave: string;
    passwordSaving: string;
    passwordSaved: string;
    passwordSaveFailed: string;
    preferredLanguageTitle: string;
    preferredLanguageDescription: string;
    preferredLanguageLabel: string;
    preferredLanguageDefault: string;
    preferredLanguageEnglish: string;
    preferredLanguageChinese: string;
    preferredLanguageJapanese: string;
    preferredLanguageSaved: string;
    preferredLanguageSaveFailed: string;
    timeZoneTitle: string;
    timeZoneDescription: string;
    activeTimeZone: string;
    browserTimeZone: string;
    browserUnavailable: string;
    browserSource: string;
    manualSource: string;
    preferenceLabel: string;
    preferenceDescription: string;
    useBrowser: string;
    useCustom: string;
    customTimeZoneLabel: string;
    customTimeZoneDescription: string;
    invalidTimeZone: string;
    save: string;
    saving: string;
    saved: string;
    saveFailed: string;
  };
  notificationCenter: {
    title: string;
    subtitle: string;
    empty: string;
    loading: string;
    markRead: string;
    markAllRead: string;
    refresh: string;
    attention: string;
    loadFailed: string;
    markReadFailed: string;
    markAllReadSuccess: string;
    markAllReadFailed: string;
    ruleFilterActive: string;
    ruleFilterClear: string;
    sections: {
      importantTitle: string;
      importantDescription: string;
      importantEmpty: string;
      reportsTitle: string;
      reportsDescription: string;
      reportsEmpty: string;
    };
    tabs: {
      all: string;
      unread: string;
      attention: string;
      report: string;
    };
    tabDescriptions: {
      all: string;
      unread: string;
      attention: string;
      report: string;
    };
    messageTypes: {
      report: string;
      milestone: string;
      threshold: string;
      change: string;
      health: string;
      system: string;
      test: string;
    };
    severities: {
      info: string;
      success: string;
      warning: string;
      critical: string;
    };
    deliveryStatuses: {
      created: string;
      sending: string;
      sent: string;
      partial: string;
      failed: string;
      skipped: string;
    };
    channels: {
      inApp: string;
      email: string;
    };
    channelStatuses: {
      sent: string;
      skipped: string;
      failed: string;
      created: string;
    };
    emailSkipReasons: {
      user_preference_disabled: string;
      system_email_unconfigured: string;
      recipient_email_invalid: string;
      secret_decryption_failed: string;
      provider_failed: string;
      network_failed: string;
      unknown: string;
    };
    emailAttempts: string;
    emailRetryCount: string;
    emailDuration: string;
    typeFilterLabel: string;
    severityFilterLabel: string;
    allTypes: string;
    allSeverities: string;
    preferencesTitle: string;
    preferencesDescription: string;
    emailNotificationsLabel: string;
    emailNotificationsDescription: string;
    reportsUnreadLabel: string;
    reportsUnreadDescription: string;
    milestonesUnreadLabel: string;
    milestonesUnreadDescription: string;
    alertsUnreadLabel: string;
    alertsUnreadDescription: string;
    preferencesSaved: string;
    preferencesSaveFailed: string;
    detailFields: Record<string, never>;
  };
  notificationEmail: {
    common: {
      brand: string;
      date: string;
      coreMetrics: string;
      topPages: string;
      topReferrers: string;
      views: string;
      visitors: string;
      sessions: string;
      visits: string;
      viewsUnit: string;
      direct: string;
      metric: string;
      window: string;
      currentValue: string;
      previousValue: string;
      threshold: string;
      milestone: string;
      change: string;
      mode: string;
      lastSeen: string;
      never: string;
      noPageData: string;
      noReferrerData: string;
      footer: string;
      fallbackSubject: string;
      trackingHint: string;
      severity: {
        info: string;
        success: string;
        warning: string;
        critical: string;
      };
    };
    test: {
      subject: string;
      title: string;
      summary: string;
      body: string;
    };
    report: {
      subject: string;
      title: string;
      summary: string;
      periodLabels: {
        daily: string;
        weekly: string;
        monthly: string;
        quarterly: string;
        yearly: string;
      };
    };
    milestone: {
      subject: string;
      title: string;
      summary: string;
    };
    threshold: {
      subject: string;
      title: string;
      summary: string;
      metricLabels: {
        views: string;
        visitors: string;
        sessions: string;
      };
      windows: {
        last_1h: string;
        last_24h: string;
        yesterday: string;
      };
    };
    health: {
      subject: string;
      title: string;
      noHistory: string;
    };
    change: {
      subject: string;
      title: string;
      summary: string;
    };
  };
  runtimeConfigError: {
    title: string;
    eyebrow: string;
    heading: string;
    description: string;
    requiredTitle: string;
    requiredDescription: string;
    secretHint: string;
    commandTitle: string;
    commandDescription: string;
    quickStartHint: string;
    docsLabel: string;
    homeLabel: string;
  };
  login: {
    title: string;
    subtitle: string;
    username: string;
    password: string;
    signIn: string;
    invalidCredentials: string;
  };
  accountLinks: {
    invite: {
      title: string;
      subtitle: string;
      loading: string;
      missingToken: string;
      loadFailed: string;
      accept: string;
      accepting: string;
      accepted: string;
      acceptFailed: string;
      signIn: string;
      signedInNotice: string;
      teamLabel: string;
      roleLabel: string;
      emailLabel: string;
      accountEmailLabel: string;
      anyEmail: string;
      expiresLabel: string;
      usernameLabel: string;
      nameLabel: string;
      passwordLabel: string;
      roles: {
        admin: string;
        member: string;
      };
    };
    resetPassword: {
      title: string;
      subtitle: string;
      loading: string;
      missingToken: string;
      loadFailed: string;
      reset: string;
      resetting: string;
      resetDone: string;
      resetFailed: string;
      signIn: string;
      accountLabel: string;
      emailLabel: string;
      expiresLabel: string;
      passwordLabel: string;
      confirmPasswordLabel: string;
      passwordTooShort: string;
      passwordMismatch: string;
    };
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
    switchToJapanese: string;
    switchToLight: string;
    switchToDark: string;
  };
  teamSelect: {
    groupLabel: string;
    groups: {
      created: string;
      managed: string;
      member: string;
      system: string;
    };
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
    stats: {
      sites: string;
      members: string;
    };
    toasts: {
      teamSaved: string;
      teamSaveFailed: string;
      teamDeleted: string;
      teamDeleteFailed: string;
      memberRemoved: string;
      memberRemoveFailed: string;
      roleChanged: string;
      roleChangeFailed: string;
      siteAccessChanged: string;
      siteAccessChangeFailed: string;
      invalidTeamName: string;
      inviteCreated: string;
      inviteCreateFailed: string;
      inviteRevoked: string;
      inviteRevokeFailed: string;
      inviteCopied: string;
      inviteCopyFailed: string;
      invalidInviteEmail: string;
      invalidInviteExpiry: string;
      ownerTransferred: string;
      ownerTransferFailed: string;
      invalidTransferTarget: string;
    };
    sites: {
      title: string;
      subtitle: string;
      aggregateTitle: string;
      pagesPerSession: string;
      noSites: string;
      openAnalytics: string;
    };
    widgets: {
      title: string;
      subtitle: string;
      underConstruction: string;
    };
    notifications: {
      title: string;
      subtitle: string;
      empty: string;
      forbiddenTitle: string;
      forbiddenDescription: string;
      rulesTitle: string;
      enabledCount: string;
      loadingRules: string;
      deliveryTestTitle: string;
      deliveryTestDescription: string;
      inAppTestHint: string;
      emailTestConfiguredHint: string;
      emailTestUnconfiguredHint: string;
      sendTestNotification: string;
      loadRulesFailed: string;
      testNotificationSent: string;
      sendTestNotificationFailed: string;
      createRule: string;
      editRule: string;
      dialogDescription: string;
      ruleInfoSection: string;
      scheduleSection: string;
      sendScheduleSection: string;
      checkSection: string;
      conditionSection: string;
      deliverySection: string;
      summarySection: string;
      liveSummaryDescription: string;
      nameLabel: string;
      siteLabel: string;
      chooseSite: string;
      ruleTypeLabel: string;
      recipientLabel: string;
      enabledLabel: string;
      enabledHint: string;
      scheduleLabel: string;
      timeLabel: string;
      timezoneLabel: string;
      intervalLabel: string;
      dayLabel: string;
      dayOfMonthLabel: string;
      monthLabel: string;
      reportPeriodLabel: string;
      milestoneEveryLabel: string;
      matchLabel: string;
      matchAll: string;
      matchAny: string;
      changeValueLabel: string;
      changeModeLabel: string;
      changeModePercent: string;
      changeModeAbsolute: string;
      addCondition: string;
      removeCondition: string;
      conditionItemTitle: string;
      metricLabel: string;
      windowLabel: string;
      operatorLabel: string;
      valueLabel: string;
      cooldownLabel: string;
      cooldownDescription: string;
      noDataHoursLabel: string;
      pleaseChooseSite: string;
      pleaseChooseRecipients: string;
      ruleCreated: string;
      ruleUpdated: string;
      createRuleFailed: string;
      updateRuleFailed: string;
      deleteConfirm: string;
      ruleDeleted: string;
      deleteRuleFailed: string;
      lastChecked: string;
      actions: string;
      edit: string;
      enable: string;
      disable: string;
      delete: string;
      saveRule: string;
      emailPreview: string;
      preview: string;
      runNow: string;
      previewFailed: string;
      runFailed: string;
      runResultToast: string;
      previewDialogTitle: string;
      previewDialogDescription: string;
      coolingDownUntil: string;
      scheduleDaily: string;
      scheduleWeekly: string;
      scheduleMonthly: string;
      scheduleQuarterly: string;
      scheduleYearly: string;
      scheduleInterval: string;
      scheduleCustom: string;
      conditionReport: string;
      conditionMilestone: string;
      conditionThreshold: string;
      conditionChange: string;
      conditionHealth: string;
      summaryWhenConditions: string;
      summaryWhenSingleCondition: string;
      summaryConditionThreshold: string;
      summaryConditionChange: string;
      summaryReportSchedule: string;
      summaryMilestoneCondition: string;
      summaryHealthCondition: string;
      defaultNames: {
        report: string;
        milestone: string;
        threshold: string;
        change: string;
        health: string;
      };
      columns: {
        name: string;
        type: string;
        site: string;
        recipient: string;
        schedule: string;
        condition: string;
        nextRun: string;
        status: string;
      };
      status: {
        enabled: string;
        disabled: string;
      };
      nextRunStates: {
        disabled: string;
        coolingDown: string;
        dueNow: string;
      };
      previewFields: {
        status: string;
        summary: string;
        title: string;
        htmlPreview: string;
        bodyText: string;
        data: string;
        createdAt: string;
        updatedAt: string;
        loadingContent: string;
        noHtmlPreview: string;
      };
      ruleTypes: {
        report: string;
        milestone: string;
        threshold: string;
        change: string;
        health: string;
        test: string;
      };
      ruleTypeDescriptions: {
        report: string;
        milestone: string;
        threshold: string;
        change: string;
        health: string;
      };
      recipientModes: {
        creator: string;
        team_admins: string;
        all_team_members: string;
        users: string;
      };
      recipientKindLabel: string;
      recipientPresetLabel: string;
      customRecipientsEmpty: string;
      noTeamMembers: string;
      recipientKinds: {
        preset: string;
        custom: string;
      };
      scheduleKinds: {
        daily: string;
        weekly: string;
        monthly: string;
        quarterly: string;
        yearly: string;
        interval: string;
      };
      reportPeriods: {
        daily: string;
        weekly: string;
        monthly: string;
        quarterly: string;
        yearly: string;
      };
      cooldownUnits: {
        minutes: string;
        hours: string;
        days: string;
      };
      intervalOptions: {
        every30Minutes: string;
        everyHour: string;
        every6Hours: string;
        every12Hours: string;
        everyDay: string;
        every7Days: string;
        every30Days: string;
      };
      weekDays: string[];
      metrics: {
        views: string;
        visitors: string;
        sessions: string;
      };
      windows: {
        last_1h: string;
        last_24h: string;
        yesterday: string;
      };
      emailPreviewPage: {
        title: string;
        subtitle: string;
        typeLabel: string;
        localeLabel: string;
        formatLabel: string;
        html: string;
        text: string;
        json: string;
        refresh: string;
        loading: string;
        loadFailed: string;
        subject: string;
      };
    };
    publicLinks: {
      title: string;
      subtitle: string;
      enabled: string;
      disabled: string;
      disabledHint: string;
      viewSettings: string;
      copyLink: string;
      linkCopied: string;
      noSites: string;
      columns: {
        site: string;
        domain: string;
        publicUrl: string;
        status: string;
        action: string;
      };
    };
    apiKeys: {
      title: string;
      subtitle: string;
      empty: string;
      create: string;
      creating: string;
      createTitle: string;
      createSubtitle: string;
      nameLabel: string;
      namePlaceholder: string;
      scopesTitle: string;
      scopesDescription: string;
      siteScopeTitle: string;
      siteScopeDescription: string;
      allSites: string;
      expirationLabel: string;
      expiration30: string;
      expiration90: string;
      expiration180: string;
      expiration365: string;
      expirationNever: string;
      oneTimeSecretTitle: string;
      oneTimeSecretDescription: string;
      copySecret: string;
      revoke: string;
      rotate: string;
      revokeConfirm: string;
      rotateConfirm: string;
      neverExpires: string;
      notUsed: string;
      loading: string;
      loadFailed: string;
      invalidInput: string;
      createFailed: string;
      revokeFailed: string;
      rotateFailed: string;
      copied: string;
      status: {
        active: string;
        expired: string;
        revoked: string;
      };
      scopes: {
        analyticsRead: string;
        siteRead: string;
        siteWrite: string;
        siteConfigRead: string;
        siteConfigWrite: string;
      };
      scopeDescriptions: {
        analyticsRead: string;
        siteRead: string;
        siteWrite: string;
        siteConfigRead: string;
        siteConfigWrite: string;
      };
      scopeGroups: {
        analytics: string;
        site: string;
        siteConfig: string;
      };
      columns: {
        name: string;
        scopes: string;
        sites: string;
        expires: string;
        lastUsed: string;
        status: string;
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
      transferTitle: string;
      transferSubtitle: string;
      transferTargetLabel: string;
      transferTargetPlaceholder: string;
      transfer: string;
      transferring: string;
      transferConfirm: string;
      noTransferableMembers: string;
    };
    members: {
      title: string;
      subtitle: string;
      remove: string;
      noMembers: string;
      invitesTitle: string;
      invitesSubtitle: string;
      inviteEmailLabel: string;
      inviteEmailPlaceholder: string;
      inviteExpiresLabel: string;
      createInvite: string;
      creatingInvite: string;
      copyInvite: string;
      inviteLinksTitle: string;
      inviteLinksSubtitle: string;
      noInvites: string;
      anyEmail: string;
      revokeInvite: string;
      siteAccessLabel: string;
      siteAccessAll: string;
      siteAccessRestricted: string;
      siteAccessSelected: string;
      siteAccessDescription: string;
      siteAccessAdmins: string;
      siteAccessDialogTitle: string;
      saveSiteAccess: string;
      cancelSiteAccess: string;
      noSitesForAccess: string;
      inviteStatuses: {
        active: string;
        used: string;
        revoked: string;
        expired: string;
      };
      columns: {
        name: string;
        username: string;
        email: string;
        inviteCode: string;
        role: string;
        siteAccess: string;
        joinedAt: string;
        createdAt: string;
        expiresAt: string;
        usedAt: string;
        status: string;
        action: string;
      };
      roleLabels: {
        owner: string;
        admin: string;
        member: string;
      };
    };
  };
  managementNav: {
    users: string;
    sites: string;
    teams: string;
    versionUpdates: string;
    scheduledTasks: string;
    requestObservation: string;
    systemPerformance: string;
    systemSettings: string;
  };
  managementPages: {
    versionUpdates: {
      subtitle: string;
      empty: string;
      currentVersion: string;
      latestVersion: string;
      currentCommit: string;
      releaseCount: string;
      publishedAt: string;
      author: string;
      commit: string;
      statusStable: string;
      statusPrerelease: string;
      statusDraft: string;
      currentVersionBadge: string;
      releaseNotes: string;
      openRelease: string;
      viewDetails: string;
      detailsTitle: string;
      detailsDescription: string;
      detailsLoading: string;
      detailsEmpty: string;
      detailsFailed: string;
      currentCommitBadge: string;
      openCompare: string;
      openCommit: string;
      commitCount: string;
      source: string;
      loadFailed: string;
      unknown: string;
    };
    scheduledTasks: {
      subtitle: string;
      empty: string;
      refresh: string;
      loadFailed: string;
      allStatuses: string;
      runs24h: string;
      successRate24h: string;
      successRateDescription: string;
      problemRuns24h: string;
      retentionPrefix: string;
      days: string;
      failed: string;
      partial: string;
      lastRun: string;
      staleRunning: string;
      noStaleRunning: string;
      taskListTitle: string;
      taskListDescription: string;
      task: string;
      schedule: string;
      enabled: string;
      enabledYes: string;
      enabledNo: string;
      lastStatus: string;
      runs30d: string;
      successRate30d: string;
      avgDuration: string;
      runHistoryTitle: string;
      runHistoryDescription: string;
      noRuns: string;
      scheduledAt: string;
      startedAt: string;
      finishedAt: string;
      trigger: string;
      tasks: string;
      taskCount: string;
      subtaskCount: string;
      taskResult: string;
      statusLabel: string;
      duration: string;
      sites: string;
      hours: string;
      rows: string;
      rulesScanned: string;
      messagesCreated: string;
      emailFailed: string;
      logs: string;
      viewLogs: string;
      logTitle: string;
      noRunSelected: string;
      noLogs: string;
      error: string;
      status: {
        running: string;
        success: string;
        partial: string;
        failed: string;
        skipped: string;
      };
      taskDefinitions: {
        visit_hourly_rollup: {
          name: string;
          description: string;
          schedule: string;
        };
        notification_tick: {
          name: string;
          description: string;
          schedule: string;
        };
      };
    };
  };
  adminUsers: {
    title: string;
    subtitle: string;
    createTitle: string;
    createTeamNotice: string;
    username: string;
    email: string;
    name: string;
    password: string;
    role: string;
    teamName: string;
    teamSlug: string;
    defaultTeamName: string;
    create: string;
    creating: string;
    delete: string;
    deleting: string;
    deleteConfirm: string;
    deleteSuccess: string;
    deleteFailed: string;
    generateResetLink: string;
    resetLinkCreated: string;
    resetLinkCreateFailed: string;
    resetLinkCopied: string;
    resetLinkCopyFailed: string;
    copyResetLink: string;
    resetLinkExpiresAt: string;
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
  requestObservation: {
    title: string;
    subtitle: string;
    tabs: {
      overview: string;
      abnormal: string;
      normal: string;
    };
    refresh: string;
    loadFailed: string;
    notConfiguredTitle: string;
    notConfiguredDescription: string;
    analyticsEngineDisabledTitle: string;
    analyticsEngineDisabledDescription: string;
    openAnalyticsEngine: string;
    openSettings: string;
    highConfidenceBots: string;
    affectedSites: string;
    uniqueCountries: string;
    noData: string;
    trendTitle: string;
    trendDescription: string;
    recentTitle: string;
    recentDescription: string;
    recentShowing: string;
    recentLoadedAll: string;
    detailTitle: string;
    detailSubtitle: string;
    client: string;
    edge: string;
    identifiers: string;
    fullUserAgent: string;
    id: string;
    metadata: string;
    time: string;
    site: string;
    location: string;
    network: string;
    reason: string;
    request: string;
    ip: string;
    userAgent: string;
    confidence: string;
    blocked: string;
    highConfidenceRequests: string;
    emptyValue: string;
    kind: string;
    botScoreBucket: string;
    verifiedBotCategory: string;
    hostname: string;
    pathname: string;
    origin: string;
    asOrganization: string;
    asn: string;
    country: string;
    region: string;
    city: string;
    colo: string;
    userAgentLengthBucket: string;
    ipPrefix: string;
    botReasonLabels: {
      missing_ua: string;
      ua_too_long: string;
      ua_isbot: string;
      script_ua: string;
      cf_bot_score_low: string;
      cf_verified_bot_category: string;
      hosting_asn: string;
      network_service_asn: string;
      transit_asn: string;
      access_asn: string;
      missing_browser_provenance: string;
      origin_hostname_mismatch: string;
      blocked_pathname: string;
    };
    requestKindLabels: {
      pageview: string;
      custom_event: string;
      request: string;
    };
    overviewLabels: {
      totalRequests: string;
      normalRequests: string;
      abnormalRequests: string;
      abnormalRatio: string;
      p50Latency: string;
      p75Latency: string;
      p95Latency: string;
      p99Latency: string;
      avgLatency: string;
      pageviews: string;
      customEvents: string;
      overviewTrendTitle: string;
      overviewTrendDescription: string;
      trafficCompositionTitle: string;
      trafficCompositionDescription: string;
      confidenceShareTitle: string;
      normalTrafficShare: string;
      lowConfidenceTraffic: string;
      mediumConfidenceTraffic: string;
      highConfidenceTraffic: string;
      latencyTitle: string;
      latencyDescription: string;
      abnormalSubtitle: string;
      normalSubtitle: string;
      requests: string;
      windowDays: string;
      latencyMilliseconds: string;
    };
    normalDetail: {
      title: string;
      subtitle: string;
      requestMethod: string;
      edgeLatency: string;
      eventAt: string;
      receivedAt: string;
      coordinates: string;
      continent: string;
    };
    recentNormal: {
      title: string;
      description: string;
    };
  };
  systemSettings: {
    title: string;
    subtitle: string;
    guide: string;
    botAnalyticsTitle: string;
    botAnalyticsDescription: string;
    botAnalyticsAccountIdLabel: string;
    botAnalyticsApiTokenLabel: string;
    botAnalyticsApiTokenPlaceholder: string;
    botAnalyticsSaved: string;
    botAnalyticsSaveFailed: string;
    botAnalyticsDeleted: string;
    botAnalyticsDeleteFailed: string;
    botAnalyticsDeleteConfirm: string;
    botAnalyticsEngineDisabledTitle: string;
    botAnalyticsEngineDisabledDescription: string;
    botAnalyticsEngineDisabledHint: string;
    botAnalyticsOpenCloudflare: string;
    botAnalyticsGuideTitle: string;
    botAnalyticsGuideDescription: string;
    botAnalyticsGuideSteps: string[];
    notificationEmailTitle: string;
    notificationEmailDescription: string;
    notificationEmailGuideTitle: string;
    notificationEmailGuideDescription: string;
    notificationEmailGuideSteps: string[];
    loginTurnstileTitle: string;
    loginTurnstileDescription: string;
    loginTurnstileEnabledLabel: string;
    loginTurnstileSiteKeyLabel: string;
    loginTurnstileSecretKeyLabel: string;
    loginTurnstileSecretKeyPlaceholder: string;
    loginTurnstileModeLabel: string;
    loginTurnstileModeInvisible: string;
    loginTurnstileTest: string;
    loginTurnstileTesting: string;
    loginTurnstileTestPassed: string;
    loginTurnstileTestRequired: string;
    loginTurnstileTestMissing: string;
    loginTurnstileTestFailed: string;
    loginTurnstileSaved: string;
    loginTurnstileSaveFailed: string;
    loginTurnstileDeleted: string;
    loginTurnstileDeleteFailed: string;
    loginTurnstileDeleteConfirm: string;
    loginTurnstileLoadFailed: string;
    loginTurnstilePrivacyNotice: string;
    loginTurnstileGuideTitle: string;
    loginTurnstileGuideDescription: string;
    loginTurnstileGuideSteps: string[];
    enabledLabel: string;
    enabledOn: string;
    enabledOff: string;
    providerLabel: string;
    providerResend: string;
    fromNameLabel: string;
    fromEmailLabel: string;
    replyToLabel: string;
    replyToPlaceholder: string;
    resendApiKeyLabel: string;
    resendApiKeyPlaceholder: string;
    testRecipientLabel: string;
    save: string;
    saving: string;
    test: string;
    testing: string;
    saved: string;
    saveFailed: string;
    delete: string;
    deleting: string;
    cancel: string;
    deleted: string;
    deleteFailed: string;
    deleteConfirm: string;
    testSent: string;
    testFailed: string;
    loadFailed: string;
  };
  systemPerformance: {
    title: string;
    subtitle: string;
    refresh: string;
    loadFailed: string;
    noData: string;
    range15m: string;
    range1h: string;
    range6h: string;
    range24h: string;
    totalEvents: string;
    p95Latency: string;
    p50Latency: string;
    p75Latency: string;
    p50Label: string;
    p75Label: string;
    p95Label: string;
    dataFreshness: string;
    noRecentWrite: string;
    clockAnomalies: string;
    delayed: string;
    future: string;
    latencyPercentileTrend: string;
    latencyPercentileTrendDescription: string;
    throughputTrend: string;
    throughputTrendDescription: string;
    visits: string;
    customEvents: string;
    anomalyBucket: string;
    openVisitHealth: string;
    openVisitHealthDescription: string;
    open: string;
    stale: string;
    timedOut: string;
    oldestOpen: string;
    latestActivity: string;
    latencySampleHealth: string;
    latencySampleHealthDescription: string;
    trustedSamples: string;
    topSitesTitle: string;
    topSitesDescription: string;
    events: string;
    avgLatency: string;
    slowestEventsTitle: string;
    slowestEventsDescription: string;
    eventTime: string;
    serverTime: string;
    estimatedDelay: string;
    doDiagnosticTitle: string;
    doDiagnosticDescription: string;
    doDiagnosticLoadFailed: string;
    doDiagnosticLoading: string;
    doDiagnosticRun: string;
    doDiagnosticEmpty: string;
    doDiagnosticUnreachable: string;
    doDiagnosticReachableSites: string;
    doDiagnosticTotalSites: string;
    doDiagnosticActiveAlarms: string;
    doDiagnosticBufferedVisits: string;
    doDiagnosticOpenVisits: string;
    doDiagnosticOpenStale: string;
    doDiagnosticOpenTimedOut: string;
    doDiagnosticOpenHardAged: string;
    doDiagnosticOpenFutureSkew: string;
    doDiagnosticStuckDirty: string;
    doDiagnosticMaxFlushAttempts: string;
    doDiagnosticBufferedCustomEvents: string;
    doDiagnosticOldestOpen: string;
    doDiagnosticFutureMaxActivity: string;
    doDiagnosticSiteList: string;
    doDiagnosticSiteListDescription: string;
    doDiagnosticSiteFailed: string;
    doDiagnosticSiteOpen: string;
    doDiagnosticSiteStuck: string;
    doDiagnosticSiteFuture: string;
    doDiagnosticSiteHardAged: string;
    doDiagnosticSiteAlarm: string;
    doDiagnosticSiteAlarmNone: string;
    doDiagnosticSiteAlarmDue: string;
    doDiagnosticSiteResponseMs: string;
    doDiagnosticThresholdsHint: string;
    doDiagnosticHealthy: string;
  };
  loginForm: {
    signingIn: string;
    verifyingSecurity: string;
    securityVerificationTitle: string;
    securityVerificationFailed: string;
    retrySecurityVerification: string;
    redirecting: string;
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

const enMessages = {
  appName: "InsightFlare",
  navigation: {
    overview: "Overview",
    realtime: "Real-time",
    pages: "Pages",
    referrers: "Referrers",
    sessions: "Sessions",
    events: "Events",
    funnels: "Funnels",
    campaigns: "Campaigns",
    visitors: "Visitors",
    retention: "Retention",
    geo: "Location",
    devices: "Devices",
    browsers: "Browsers",
    performance: "Performance",
    settings: "Settings",
  },
  common: {
    deviceLabels: {
      desktop: "Desktop",
      mobile: "Mobile",
      tablet: "Tablet",
    },
    timeRelativePair: "{absolute} ({relative})",
    id: "ID",
    views: "Views",
    sessions: "Sessions",
    visitors: "Visitors",
    bounceRate: "Bounce Rate",
    avgDuration: "Avg. Duration",
    path: "Path",
    title: "Title",
    hostname: "Hostname",
    referrerHost: "Referrer Host",
    entryPage: "Entry Page",
    exitPage: "Exit Page",
    referrer: "Referrer",
    startedAt: "Started",
    event: "Event",
    location: "Location",
    browser: "Browser",
    operatingSystem: "Operating System",
    deviceType: "Device Type",
    country: "Country",
    region: "Region",
    regionCode: "Region Code",
    city: "City",
    continent: "Continent",
    latitude: "Latitude",
    longitude: "Longitude",
    continentLabels: {
      AF: "Africa",
      AN: "Antarctica",
      AS: "Asia",
      EU: "Europe",
      NA: "North America",
      OC: "Oceania",
      SA: "South America",
      AFRICA: "Africa",
      ANTARCTICA: "Antarctica",
      ASIA: "Asia",
      EUROPE: "Europe",
      "NORTH AMERICA": "North America",
      OCEANIA: "Oceania",
      "SOUTH AMERICA": "South America",
    },
    timezone: "Time zone",
    organization: "Organization",
    screenSize: "Screen Size",
    loading: "Loading",
    noData: "No data",
    unknown: "Unknown",
    lastUpdated: "Last updated",
    site: "Site",
    team: "Team",
    management: "Management",
    backToTeam: "Back to Team",
    system: "System",
    account: "Account",
    theme: "Theme",
    language: "Language",
    role: "Role",
    admin: "Admin",
    user: "User",
    search: "Search",
    tableExport: {
      action: "Export",
      title: "Export CSV",
      description: "Download table data as a CSV file.",
      scopeLabel: "Scope",
      currentTab: "Current tab",
      allTabs: "All tabs",
      rowsLabel: "Data",
      currentView: "Current displayed data",
      rawRows: "Original data",
      fileNameLabel: "File name",
      download: "Export CSV",
      empty: "No rows available to export.",
      allTabsUnavailable:
        "All tabs can be exported after their data finishes loading.",
    },
    time: "Time",
    cycle: "Cycle",
    close: "Close",
    sitesFiltered: "{active} / {total} sites filtered",
    cumulativeTraffic: "Cumulative traffic",
  },
  ranges: {
    last30m: "30m",
    last1h: "1h",
    today: "Today",
    yesterday: "Yesterday",
    thisWeek: "This Week",
    thisMonth: "This Month",
    thisYear: "This Year",
    last24h: "Last 24 hours",
    last7d: "Last 7 days",
    last30d: "Last 30 days",
    last90d: "Last 90 days",
    last6m: "Last 6 months",
    last12m: "Last 12 months",
    allTime: "All Time",
    custom: "Custom Range",
  },
  intervals: {
    minute: "Minute",
    hour: "Hour",
    day: "Day",
    week: "Week",
    month: "Month",
  },
  dashboardHeader: {
    range: "Time Range",
    interval: "Interval",
    filters: "Filters",
    customRange: "Select Custom Range",
    customHint: "Please select a start and end date.",
    customPendingEnd: "Start date selected. Please pick an end date.",
    customApply: "Apply",
    rangeGroupQuick: "Quick Ranges",
    rangeGroupCalendar: "Calendar Periods",
    rangeGroupRolling: "Rolling Windows",
    rangeGroupAdvanced: "Advanced",
    intervalDisabledMinute: "Minute interval is only available within 1 hour.",
    intervalDisabledHour: "Hour interval is only available within 7 days.",
    intervalDisabledDay:
      "Day interval is only available within the last 90 days.",
    intervalDisabledWeek:
      "Week interval is only available within the last 12 months.",
    filterTitle: "Filters",
    filterSubtitle:
      "Filters are applied to current overview data queries in real time.",
    previousPeriod: "Previous period",
    nextPeriod: "Next period",
    customSelectionSummary: "Selected range: {from} to {to} ({days} days)",
  },
  filters: {
    country: "Country",
    device: "Device",
    browser: "Browser",
    all: "All",
    clear: "Clear",
  },
  filterBuilder: {
    fieldGroups: {
      page: "Page",
      session: "Session",
      referrer: "Referrer",
      campaign: "Campaign",
      client: "Client",
      geography: "Geography",
      event: "Event",
    },
    fieldLabels: {
      "page.path": "Page path",
      "page.title": "Page title",
      "page.hostname": "Page hostname",
      "page.query": "Query string",
      "page.hash": "Hash fragment",
      "session.entryPath": "Entry page",
      "session.exitPath": "Exit page",
      "referrer.domain": "Referrer domain",
      "referrer.url": "Referrer URL",
      "utm.source": "Campaign source",
      "utm.medium": "Campaign medium",
      "utm.campaign": "Campaign name",
      "utm.term": "Campaign term",
      "utm.content": "Campaign content",
      "client.browser": "Browser",
      "client.browserVersion": "Browser version",
      "client.browserEngine": "Browser engine",
      "client.os": "Operating system",
      "client.osVersion": "Operating system version",
      "client.deviceType": "Device type",
      "client.language": "Language",
      "client.screenSize": "Screen size",
      "geo.country": "Country",
      "geo.region": "Region",
      "geo.city": "City",
      "geo.continent": "Continent",
      "geo.timeZone": "Time zone",
      "geo.organization": "Organization",
      "event.name": "Event name",
      "event.payload": "Event payload",
    },
    operatorLabels: {
      eq: "Equals",
      neq: "Does not equal",
      in: "Is one of",
      notIn: "Is not one of",
      contains: "Contains",
      startsWith: "Starts with",
      endsWith: "Ends with",
      gt: "Greater than",
      gte: "Greater than or equal to",
      lt: "Less than",
      lte: "Less than or equal to",
      between: "Between",
      exists: "Exists",
      notExists: "Does not exist",
      isNull: "Is null",
      notNull: "Is not null",
      isEmpty: "Is empty",
      notEmpty: "Is not empty",
    },
    valueType: "Value type",
    valueKinds: {
      string: "Text",
      enum: "Option",
      number: "Number",
      boolean: "Boolean",
      date: "Date",
      datetime: "Date and time",
      "json-scalar": "JSON scalar",
    },
    booleanTrue: "True",
    booleanFalse: "False",
    valueUnset: "(Not set)",
    valueLoading: "Loading values",
    valueSearchPlaceholder: "Search or enter a value",
    valueListPlaceholder: "Search or enter a value, then press Enter",
    rangeStartPlaceholder: "Lower bound",
    rangeEndPlaceholder: "Upper bound",
    jsonPointer: "JSON Pointer",
    match: "Match",
    expression: "Filter expression",
    expressionPlaceholder: "Filter expression...",
    expressionInvalid: "Invalid expression. Click to view syntax help.",
    expressionHelpTitle: "Filter expression syntax",
    expressionHelpDescription:
      "Available fields and operators are generated from the active filter contract.",
    expressionHelpSyntax: "Syntax",
    expressionHelpLogicDescription:
      "AND binds more tightly than OR. Use parentheses for nesting; AND(...) and OR(...) preserve an explicit one-condition group.",
    expressionHelpValues: "Values",
    expressionHelpValuesDescription:
      "Strings use JSON double quotes. Numbers and booleans are unquoted. Use [value, value] for sets and exactly two ordered values with between.",
    expressionHelpOperators: "Available operators",
    expressionHelpUnaryOperators: "Operators without a value",
    expressionHelpFields: "Available fields",
    expressionHelpFieldType: "Type",
    expressionHelpFieldOperators: "Operators",
    expressionHelpOtherFields: "Other",
    apply: "Apply Filters",
    allConditions: "All conditions",
    anyCondition: "Any condition",
    condition: "Condition {index}",
    group: "Group {index}",
    invertCondition: "Invert this condition",
    exclude: "Exclude",
    addGroup: "Add group",
    invalid: "Complete each filter condition before applying.",
  },
  realtime: {
    title: "Real-time",
    subtitle: "View traffic from the last 30 minutes.",
    logTitleSeparator: ":",
    activeNow: "Active now",
    liveMetrics: "Active / 30m Visitors / 30m Views",
    connected: "Connected",
    connecting: "Connecting",
    reconnecting: "Reconnecting",
    failed: "Failed",
    recentEvents: "Recent live events",
    enterPage: "Enter page",
    leavePage: "Exit page",
    viewPage: "View page",
    customEvent: "Event",
    detailsTitle: "Event details",
    detailsSection: "Information",
    visitorHistorySection: "Visitor activity",
    visitorHistorySubtitle:
      "All records for this visitor in the current realtime window.",
    visitorHistoryEmpty:
      "No additional records are available for this visitor yet.",
    visitorMapSection: "Visitor location",
    visitorMapSubtitle:
      "Approximate location inferred from this event's coordinates.",
    visitorMapUnavailable: "This event does not include usable coordinates.",
    visitorId: "Visitor ID",
    sessionId: "Session ID",
    visitId: "Visit ID",
    eventType: "Event type",
    eventTime: "Event time",
  },
  overview: {
    title: "Traffic Overview",
    subtitle: "Monitor high-level performance and audience behavior.",
    trendTitle: "Traffic Trend",
    sourceTab: "Source",
    sourceDomainColumn: "Source (Domain)",
    sourceLinkTab: "Source Link",
    sourceLinkColumn: "Source Link",
    direct: "Direct",
    searchInTab: "Search {tab}",
  },
  pages: {
    title: "Pages",
    subtitle: "Most visited paths in the selected range.",
    pagesPerSession: "Pages / Session",
    untitled: "Untitled Page",
    empty: "No page data matches the current filters.",
    loadError: "Failed to load page data. Please try again later.",
    loadMoreError: "Failed to load more pages.",
    retry: "Retry",
    trendTitle: "Page Traffic Trend",
    otherPages: "Other Pages",
    hashTab: "Anchor",
    noHash: "No Anchor",
    queryTab: "Query Params",
    noQuery: "No Query Params",
    eventTab: "Events",
    eventsMetric: "Events",
    viewDetails: "View details",
  },
  referrers: {
    title: "Referrers",
    subtitle: "Where traffic comes from.",
    summaryTitle: "Source Summary",
    splitTitle: "Traffic Split",
    chartTitle: "Source Mix",
    radarTitle: "Top 24 Source Radar",
    radarSubtitle: "Compare the leading referrers across behavioral metrics.",
    radarDuration: "Duration",
    radarEngagement: "Engagement",
    radarDepth: "Depth",
    radarLoyalty: "Loyalty",
    radarFrequency: "Frequency",
    radarTraffic: "Traffic",
    directSourceNote:
      "This traffic arrived without an external referring website.",
    breakdownTitle: "Source Breakdown",
    directViews: "Direct Views",
    uniqueDomains: "Unique Domains",
    uniqueLinks: "Unique Links",
    topSource: "Top External Source",
    topSourceShare: "Share of Views",
    noExternalSource: "No external source",
    externalLabel: "External",
    nextSources: "Next 4 Sources",
    longTail: "Long Tail",
  },
  campaigns: {
    title: "Campaigns",
    subtitle: "UTM campaign performance and traffic attribution.",
    tabSource: "Source",
    tabMedium: "Medium",
    tabCampaign: "Campaign",
    tabTerm: "Term",
    tabContent: "Content",
    breakdownTitle: "UTM Breakdown",
    notSet: "Not set",
    noTaggedTraffic: "No tagged campaign traffic in the selected range.",
  },
  sessions: {
    title: "Sessions",
    subtitle: "Session-level detail for quality analysis.",
    search: "Search sessions...",
    started: "Start Time",
    sessionId: "Session ID",
    visitor: "Visitor",
    anonymous: "Anonymous",
    entryPage: "Entry Page",
    exitPage: "Exit Page",
    duration: "Duration",
    referrer: "Referrer",
    location: "Location",
    os: "OS",
    browser: "Browser",
    device: "Device",
    pageViews: "Page Views",
    loadError: "Unable to load sessions.",
    empty: "No sessions in this time range.",
  },
  sessionDetail: {
    anonymous: "Anonymous",
    back: "Back to sessions",
    missing: "Missing sessionId.",
    notFound: "Session not found.",
    loadError: "Unable to load session detail.",
    active: "Active",
    inactive: "Ended",
    status: "Status",
    duration: "Duration",
    screenViews: "Screen Views",
    events: "Events",
    bounce: "Bounce",
    entryPath: "Entry Path",
    exitPath: "Exit Path",
    referrerName: "Referrer Name",
    os: "OS",
    browser: "Browser",
    device: "Device",
    screen: "Screen",
    yes: "Yes",
    no: "No",
    uniquePages: "Unique Pages",
    firstEvent: "First Event",
    lastEvent: "Last Event",
    sessionStarted: "Session started",
    pageview: "Pageview",
    exitPage: "Exit page",
    customEvent: "Custom event",
    eventTitleSeparator: ": ",
    visitDetailsTitle: "Visit details",
    visitDetailsSubtitle:
      "Session start, pageviews, exits, and custom events in the order they happened.",
    location: "Location",
    visitorId: "Visitor ID",
    sessionId: "Session ID",
    referrerUrl: "Referrer URL",
    emptyEvents: "No events recorded.",
    emptyCustomEvents: "No custom events.",
    sincePrevious: "Since previous",
    geoLocationTitle: "Geo location",
    performanceTitle: "Current session performance",
    range: "Range",
  },
  events: {
    title: "Custom Events",
    subtitle:
      "Review event volume, context, payload fields, and raw trigger records.",
    detailTitle: "Event Detail",
    detailSubtitle: "Inspect a single event with its context and payload.",
    typeDetailSubtitle:
      "Review this event's trend, context distribution, payload schema, and trigger records.",
    backToEvents: "Back to Events",
    totalEvents: "Total Events",
    eventTypes: "Event Types",
    sessions: "Sessions",
    visitors: "Visitors",
    avgEventsPerSession: "Avg Events / Session",
    shareOfAllEvents: "Share of All Events",
    triggerCount: "Triggers",
    triggerVisitors: "Triggered Visitors",
    trendTitle: "Event Trend",
    topEvents: "Top Events",
    recordsTitle: "Event Records",
    fieldsTitle: "Payload Fields",
    fieldsSubtitle: "Select a field to inspect its values and metadata.",
    fieldValuesTitle: "Field Values",
    fieldValuesSubtitle:
      "Records and occurrence counts for the selected field. Click a row to filter.",
    fieldValuesEmpty: "No values recorded for this field.",
    payloadFilter: "Filter",
    payloadFilterTitle: "Payload Filters",
    payloadFilterSubtitle:
      "Add one condition per line. Combine filters with == or !=.",
    payloadFilterPlaceholder: 'path.value == "a"\nlevel != 0',
    payloadFilterApply: "Apply Filters",
    payloadFilterClear: "Clear Filters",
    payloadFilterInvalid:
      "Unable to parse the filter conditions. Check the field path, operator, and value.",
    expandField: "Expand field",
    collapseField: "Collapse field",
    breakdownTitle: "Context Breakdown",
    search: "Search event name, IDs, visitor, session, page...",
    eventName: "Event Name",
    eventId: "Event ID",
    occurredAt: "Occurred",
    receivedAt: "Received",
    page: "Page",
    context: "Context",
    visitor: "Visitor",
    visit: "Visit",
    referrer: "Referrer",
    location: "Location",
    browser: "Browser",
    os: "OS",
    device: "Device",
    payload: "Payload",
    payloadFields: "Payload Fields",
    values: "Values",
    nodes: "Nodes",
    occurrences: "Occurrences",
    openVisitor: "Open Visitor",
    openSession: "Open Session",
    copyJson: "Copy JSON",
    copiedJson: "JSON copied.",
    copyJsonFailed: "Unable to copy JSON.",
    copyValue: "Copy value",
    copiedValue: "Value copied.",
    copyValueFailed: "Failed to copy value.",
    loadError: "Unable to load event data.",
    empty: "No custom events in this range.",
    emptyFields: "No payload fields for this event.",
    noEventName: "Missing event name.",
    loading: "Loading",
    other: "Other",
  },
  funnels: {
    title: "Funnels",
    subtitle: "Measure conversion through multi-step user journeys.",
    listTitle: "Funnel definitions",
    listSubtitle:
      "Build a reusable sequence, then inspect conversion for the current dashboard window.",
    create: "New funnel",
    createTitle: "Create funnel",
    createDescription:
      "Define at least two ordered pageview or custom event steps.",
    nameLabel: "Name",
    namePlaceholder: "Signup activation",
    stepsLabel: "Steps",
    addStep: "Add step",
    removeStep: "Remove step",
    stepTypePageview: "Pageview",
    stepTypeEvent: "Event",
    stepValueLabel: "Value",
    pageviewPlaceholder: "/pricing",
    eventPlaceholder: "signup_started",
    save: "Create",
    creating: "Creating...",
    cancel: "Cancel",
    delete: "Delete",
    deleteTitle: "Delete funnel",
    deleteDescription:
      "This removes the saved funnel definition. Historical analytics data is not deleted.",
    deleteConfirm: "Delete funnel",
    deleting: "Deleting...",
    empty: "No funnels yet.",
    emptyHint:
      "Create a funnel from pageviews and custom events to track conversion.",
    loadError: "Unable to load funnels.",
    detailLoadError: "Unable to load funnel analysis.",
    invalidFunnel: "Add a name and at least two complete steps.",
    created: "Funnel created.",
    createFailed: "Unable to create funnel.",
    deleted: "Funnel deleted.",
    deleteFailed: "Unable to delete funnel.",
    overallConversion: "Overall conversion",
    startedSessions: "Started sessions",
    convertedSessions: "Converted sessions",
    convertedVisitors: "Converted visitors",
    largestDropOff: "Largest drop-off",
    noDropOff: "No drop-off",
    step: "Step",
    sessions: "Sessions",
    visitors: "Visitors",
    conversion: "Conversion",
    stepConversion: "Step conversion",
    dropOff: "Drop-off",
    updated: "Updated",
  },
  visitors: {
    title: "Visitors",
    subtitle: "Visitor-level breakdown and recency.",
    search: "Search visitors...",
    visitor: "Visitor",
    sessionId: "Session ID",
    anonymous: "Anonymous",
    referrer: "Referrer",
    location: "Location",
    os: "OS",
    browser: "Browser",
    device: "Device",
    firstSeen: "First Seen",
    lastSeen: "Last Seen",
    pageViews: "Page Views",
    sessions: "Sessions",
    loadError: "Unable to load visitors.",
    empty: "No visitors in this time range.",
  },
  visitorDetail: {
    anonymous: "Anonymous",
    back: "Back to visitors",
    missing: "Missing visitorId.",
    notFound: "Visitor not found.",
    loadError: "Unable to load visitor detail.",
    totalDuration: "Total Duration",
    events: "Events",
    views: "Pageviews",
    uniquePages: "Unique Pages",
    avgPagesPerSession: "Avg Pages/Session",
    avgEventsPerSession: "Avg Events/Session",
    avgStay: "Avg Stay",
    firstSeen: "First seen",
    lastSeen: "Last seen",
    daysActive: "Days Active",
    avgTimeBetweenSessions: "Avg Time Between Sessions",
    activity: "Activity",
    sessionRecords: "Session records",
    started: "Start Time",
    visitor: "Visitor",
    duration: "Duration",
    referrer: "Referrer",
    pageViews: "Page Views",
    visitDetailsTitle: "Visit details",
    visitDetailsSubtitle:
      "Session starts, pageviews, exits, and custom events for this visitor in the order they happened.",
    customEvents: "Custom events",
    emptyEvents: "No events recorded.",
    emptyCustomEvents: "No custom events.",
    emptySessions: "No sessions recorded.",
    visitorId: "Visitor ID",
    sessionId: "Session ID",
    referrerName: "Referrer Name",
    referrerUrl: "Referrer URL",
    location: "Location",
    browser: "Browser",
    os: "OS",
    device: "Device",
    screen: "Screen",
    entryPath: "Entry Path",
    exitPath: "Exit Path",
    sessionStarted: "Session started",
    pageview: "Pageview",
    exitPage: "Exit page",
    customEvent: "Custom event",
    eventTitleSeparator: ": ",
    sincePrevious: "Since previous",
    geoLocationTitle: "Geo location",
    performanceTitle: "Current visitor performance",
    range: "Range",
  },
  retention: {
    title: "Retention",
    subtitle: "Cohort-based visitor return analysis.",
    cohortDate: "Cohort",
    cohortSize: "Size",
    periodLabel: "Period {n}",
    matrixTitle: "Retention Matrix",
    matrixSubtitle:
      "Each row is a first-seen cohort; each column shows the share that returned in a later period.",
    cohortsMetric: "Cohorts",
    visitorsMetric: "Cohort Visitors",
    periodOneMetric: "First Return",
    averageReturnMetric: "Average Return",
    strongestCohortMetric: "Best Cohort",
    eligibleVisitors: "eligible visitors",
    periodsAnalyzed: "periods analyzed",
    noEligibleCohorts: "Not enough history",
    weightedAverage: "Weighted average",
    legendLow: "Low",
    legendHigh: "High",
    periodZero: "Initial",
    empty: "Not enough return data in this time range.",
    emptyHint:
      "Use a wider range or choose a coarser interval from the top selector to reveal the retention shape sooner.",
    loadError: "Unable to load retention data.",
    unavailableCell: "This cohort has not reached this period yet.",
    visitorsDetail: "Visitors",
    rateDetail: "Retention",
    cohortDetail: "Cohort",
    sizeDetail: "Size",
  },
  geo: {
    title: "Location Analysis",
    subtitle: "Study traffic performance for any location.",
    mapTitle: "Request Geo Distribution",
    countryLabel: "Country",
    regionLabel: "Region",
    cityLabel: "City",
    back: "Back",
    viewOnWikipedia: "View on Wikipedia",
    investigationNotice: "This data comes from the web and may contain errors.",
    timezoneDeltaVsLocal: "{delta} vs local",
    visitorCoordinates: "Visitor Coordinates",
    ipNotice:
      "Estimated location via IP. Coordinates are approximate and do not pinpoint a precise address.",
    multipleNotice:
      "Estimated locations via IP. Multi-session journeys may span multiple cities.",
    investigation: {
      countryScopedLabel: "Country {label}",
      capital: "Capital",
      population: "Population",
      gdp: "GDP",
      gdpPerCapita: "GDP per capita",
      marketPenetration: "Market Penetration",
      region: "Region",
      currency: "Currency",
      phonecode: "Phone code",
      timezone: "Time zone",
      type: "Type",
      iso: "ISO",
      coordinates: "Coordinates",
      unavailable: "N/A",
      gdpValue: "{value} million USD",
      gdpPerCapitaValue: "{value} USD/person",
      gdpPerCapitaNearAverage: "{value} USD/person (near the world average)",
      gdpPerCapitaAboveAverage: "{value} USD/person ({percent}% above average)",
      gdpPerCapitaBelowAverage: "{value} USD/person ({percent}% below average)",
      marketPenetrationWindow: "{label} ({days} days)",
      timezoneCount: "{count} time zones",
      typeLabels: {
        country: "Country",
        state: "State",
        province: "Province",
        prefecture: "Prefecture",
        city: "City",
        county: "County",
        district: "District",
        town: "Town",
        village: "Village",
        municipality: "Municipality",
        territory: "Territory",
        section: "Section",
        adm1: "Admin Level 1",
        adm2: "Admin Level 2",
        adm3: "Admin Level 3",
        adm4: "Admin Level 4",
        adm5: "Admin Level 5",
      },
    },
  },
  devices: {
    title: "Devices",
    subtitle:
      "Understand visitors by device type, operating system, and screen size.",
    deviceShareTitle: "Device Type Share",
    osShareTitle: "Operating System Share",
    deviceTrendTitle: "Device Type Trend",
    osTrendTitle: "Operating System Trend",
    screenDistributionTitle: "Screen Size Distribution",
    screenDistributionSubtitle:
      "Surface the most common viewports and responsive breakpoints.",
    screenBucketTitle: "Breakpoint Buckets",
    screenPreviewTitle: "Screen Preview",
    selectedViewportLabel: "Selected viewport",
    openSiteLabel: "Open site",
    previewUnavailableLabel:
      "No previewable screen sizes are available right now.",
    browserByDeviceTitle: "Device Type × Browser",
    osByDeviceTitle: "Device Type × Operating System",
    otherLabel: "Other",
    screenBucketLabels: {
      phoneCompact: "Compact Phone",
      phone: "Phone",
      tablet: "Tablet",
      laptop: "Laptop",
      desktopWide: "Wide Desktop",
      unclassified: "Unclassified",
    },
  },
  browsers: {
    title: "Browsers",
    subtitle: "Browser distribution and share.",
    trendTitle: "Browser Share Trend",
    engineTrendTitle: "Engine Share Trend",
    versionBreakdownTitle: "Browser Version Breakdown",
    osBreakdownTitle: "Browser × Operating System",
    deviceTypeBreakdownTitle: "Browser × Device Type",
    otherLabel: "Other",
    browserShareTitle: "Browser Share",
    engineShareTitle: "Engine Share",
    caniuseTitle: "Feature Compatibility",
    caniuseSubtitle:
      "Check browser support for web features based on your site's visitor data.",
    caniuseSearchPlaceholder: "Search web features...",
    caniuseHotFeatures: "Popular Features",
    caniuseTrendingFeatures: "Recently Changed",
    caniuseSiteSupport: "Your Site",
    caniuseGlobalSupport: "Global",
    caniuseClearSelection: "Clear",
    caniuseNoMatch: "No matching features found.",
    caniuseFullSupport: "Full Support",
    caniusePartialSupport: "Partial Support",
    caniuseNoSupport: "No Support",
    radarTitle: "Browser Performance Radar",
    radarSubtitle: "Compare top browsers across behavioral metrics.",
    radarDuration: "Duration",
    radarEngagement: "Engagement",
    radarDepth: "Depth",
    radarLoyalty: "Loyalty",
    radarFrequency: "Frequency",
    radarTraffic: "Traffic",
  },
  performance: {
    title: "Performance",
    subtitle: "Review real visitor performance by metric, trend, and path.",
    chartTitle: "Performance Trend",
    avgLabel: "Average",
    samplesLabel: "Samples",
    p50Label: "P50",
    p75Label: "P75",
    p95Label: "P95",
    ttfb: "Time to First Byte",
    fcp: "First Contentful Paint",
    lcp: "Largest Contentful Paint",
    cls: "Cumulative Layout Shift",
    inp: "Interaction to Next Paint",
    ttfbDescription:
      "Measures how long the browser waits before receiving the first byte from the server. It reflects backend latency, network delay, and cache effectiveness.",
    fcpDescription:
      "Measures when the first text or image is painted. It reflects how quickly visitors see that the page is starting to load.",
    lcpDescription:
      "Measures when the largest visible content element finishes rendering. It is the main loading speed signal for perceived page readiness.",
    clsDescription:
      "Measures unexpected layout movement during the page lifecycle. Lower values mean the page is visually stable.",
    inpDescription:
      "Measures the latency of user interactions before the next paint. It reflects how responsive the page feels after loading.",
    msUnit: "ms",
    secondsUnit: "s",
    clsUnit: "score",
    score: "Experience Score",
    scoreDescription:
      "Combines P75 loading, stability, and interaction metrics into a 0 to 100 experience score. Higher is better.",
    great: "Great",
    needsImprovement: "Needs Improvement",
    poor: "Poor",
    datasetTitle: "Dataset Overview",
    interpretationTitle: "Current Reading",
    currentReading:
      "{metric} P75 is {value}, with an experience score of {score} across {samples} samples. Current status: {status}.",
    metricThresholdText:
      "Great: {good} or lower; needs improvement: {good} to {poor}; poor: above {poor}.",
    scoreThresholdText:
      "Great: above 90; needs improvement: 50 to 90; poor: below 50.",
    countryHealthTitle: "Country Health",
    countryHealthSubtitle:
      "Boundary fill shows {metric} health by country or region.",
    pathsTitle: "Path Performance",
    pathsAnalyzedLabel: "Paths analyzed",
    metricValueColumn: "P75 value",
    statusColumn: "Status",
  },
  share: {},
  siteSettings: {
    title: "Site Settings",
    subtitle: "Configure this site's basic information and lifecycle.",
    editTitle: "Update Site Info",
    editSubtitle: "Keep display name and domain up to date.",
    nameLabel: "Site Name",
    domainLabel: "Domain",
    publicSharingTitle: "Public Sharing",
    publicSharingSubtitle:
      "Configure this site's public access link. When enabled, anyone with the link can view analytics data.",
    publicEnabledLabel: "Enable Public Access",
    publicSlugLabel: "Public Slug",
    publicSlugPlaceholder: "e.g. my-site",
    publicSlugHint:
      "Customize the URL path identifier. Leave blank to generate one.",
    publicLinkLabel: "Public Link",
    publicLinkHint:
      "Share analytics data with this link after public access is enabled.",
    publicDisabledHint:
      "The sharing link appears after public access is enabled.",
    copiedLink: "Link copied",
    trackingStrengthGroupTitle: "Tracking Strength",
    trackingStrengthDescription:
      "Choose how aggressively the tracker identifies visitors.",
    trackingStrengthLabel: "Tracking Strength Mode",
    trackingStrengthStrong: "Strong",
    trackingStrengthSmart: "Smart",
    trackingStrengthWeak: "Weak",
    trackingStrengthStrongDescription:
      "Always use high-precision visitor tracking. This may conflict with privacy regulations such as GDPR in some regions.",
    trackingStrengthSmartDescription:
      "Automatically switch tracking strength based on the visitor's country.",
    trackingStrengthWeakDescription:
      "Always reduce tracking precision. This can count the same visitor multiple times across visits and make retention impossible.",
    queryHashGroupTitle: "Query and Hash Tracking",
    queryHashGroupDescription:
      "Control how query strings, URL hashes, and Do Not Track are handled.",
    trackQueryParamsLabel: "Track Query Parameters",
    trackHashLabel: "Track URL Hash",
    domainWhitelistTitle: "Domain Whitelist",
    domainWhitelistDescription:
      "Events are sent only when the current hostname is in this list.",
    domainWhitelistLabel: "Domain Whitelist (one per line)",
    domainWhitelistPlaceholder: "example.com\nwww.example.com\n",
    domainWhitelistHint:
      "Leave empty to allow all domains; exact matches only (no subdomains).",
    pathBlacklistTitle: "Path Blacklist",
    pathBlacklistDescription:
      "Events are blocked when the current pathname matches a blocked prefix.",
    pathBlacklistLabel: "Path Blacklist (one per line)",
    pathBlacklistPlaceholder: "/admin\n/private\n",
    pathBlacklistHint:
      "Uses startsWith prefix matching; matched paths are not reported.",
    ignoreDoNotTrackLabel: "Ignore Browser Do Not Track",
    autoTrackGroupTitle: "Auto Tracking",
    autoTrackGroupDescription: "Control automatic event capture behavior.",
    autoTrackOutboundLinksLabel: "Auto-track outbound link clicks",
    autoTrackOutboundLinksHint:
      "When enabled, clicking links to external domains automatically reports outbound_click events.",
    performanceGroupTitle: "Performance Tracking",
    performanceGroupDescription:
      "Control Web performance metric collection with one sampling rate.",
    performanceSampleRateLabel: "Performance Sample Rate (%)",
    performanceSampleRateHint:
      "A sampled visit records TTFB, FCP, LCP, CLS, and INP on leave. Use 0 to disable sampling or 100 for full coverage.",
    booleanOn: "On",
    booleanOff: "Off",
    loadingSettings: "Loading script settings...",
    saveTracking: "Save Tracking Settings",
    savingTracking: "Saving Tracking Settings...",
    save: "Save Changes",
    saving: "Saving...",
    transferTitle: "Transfer to Another Team",
    transferSubtitle: "Move this site to another team you can manage.",
    transferTeamLabel: "Target Team",
    transfer: "Transfer Site",
    transferring: "Transferring...",
    scriptTitle: "Install Tracking Script",
    scriptSubtitle:
      "Add this script to your website to start collecting analytics.",
    scriptHint:
      "Recommended before </head>; if needed you can place it before </body>, but ensure it's loaded once per page.",
    copyScript: "Copy Script",
    copiedScript: "Script copied.",
    loadingScript: "Loading script...",
    scriptUnavailable: "Script is currently unavailable.",
    deleteTitle: "Delete Site",
    deleteSubtitle: "This action will remove the site from this team.",
    delete: "Delete Site",
    deleting: "Deleting...",
    deleteConfirm: "This action cannot be undone. Continue?",
    toasts: {
      saved: "Site settings saved.",
      saveFailed: "Failed to save site settings.",
      transferred: "Site transferred.",
      transferFailed: "Failed to transfer site.",
      scriptLoadFailed: "Failed to load script snippet.",
      settingsLoadFailed: "Failed to load script settings.",
      settingsPropagationHint:
        "Global propagation to edge nodes may take up to 1 hour.",
      deleted: "Site deleted.",
      deleteFailed: "Failed to delete site.",
      invalidInput: "Please provide a valid site name and domain.",
    },
  },
  accountSettings: {
    title: "Account Settings",
    subtitle:
      "Manage your personal details, login password, and dashboard time zone.",
    profileTitle: "Personal Details",
    profileDescription: "Update your display name, username, and email.",
    nicknameLabel: "Display name",
    nicknamePlaceholder: "e.g. Product Analyst",
    usernameLabel: "Username",
    usernamePlaceholder: "e.g. alex",
    usernameDescription: "Username can also be used to sign in.",
    emailLabel: "Email",
    emailPlaceholder: "name@example.com",
    invalidProfile: "Enter a valid username and email.",
    profileSave: "Save details",
    profileSaving: "Saving...",
    profileSaved: "Personal details saved.",
    profileSaveFailed: "Failed to save personal details.",
    passwordTitle: "Login Password",
    passwordDescription: "Change the password for your current account.",
    currentPasswordLabel: "Current password",
    newPasswordLabel: "New password",
    confirmPasswordLabel: "Confirm new password",
    currentPasswordRequired: "Enter your current password.",
    passwordTooShort: "New password must be at least 8 characters.",
    passwordMismatch: "New passwords do not match.",
    passwordSave: "Change password",
    passwordSaving: "Changing...",
    passwordSaved: "Password changed.",
    passwordSaveFailed: "Failed to change password.",
    preferredLanguageTitle: "Notification Language",
    preferredLanguageDescription:
      "Choose the language used for scheduled notification emails.",
    preferredLanguageLabel: "Email language",
    preferredLanguageDefault: "Default",
    preferredLanguageEnglish: "English",
    preferredLanguageChinese: "Chinese",
    preferredLanguageJapanese: "Japanese",
    preferredLanguageSaved: "Notification language saved.",
    preferredLanguageSaveFailed: "Failed to save notification language.",
    timeZoneTitle: "Reporting Time Zone",
    timeZoneDescription:
      "Calendar ranges and aggregation buckets use this time zone across the dashboard.",
    activeTimeZone: "Active time zone",
    browserTimeZone: "Browser time zone",
    browserUnavailable: "Not detected",
    browserSource: "Browser",
    manualSource: "Manual",
    preferenceLabel: "Time zone preference",
    preferenceDescription:
      "Browser mode follows this device. Manual mode keeps the same time zone on every device.",
    useBrowser: "Use browser time zone",
    useCustom: "Choose a time zone",
    customTimeZoneLabel: "Time zone",
    customTimeZoneDescription: "Choose from supported IANA time zones.",
    invalidTimeZone: "Please choose a valid IANA time zone.",
    save: "Save preference",
    saving: "Saving...",
    saved: "Time zone preference saved.",
    saveFailed: "Failed to save time zone preference.",
  },
  notificationCenter: {
    title: "Notification Center",
    subtitle: "Review all of your notifications and reports.",
    empty: "No notifications yet.",
    loading: "Loading notifications",
    markRead: "Mark read",
    markAllRead: "Mark all read",
    refresh: "Refresh",
    attention: "Attention",
    loadFailed: "Failed to load notifications.",
    markReadFailed: "Failed to mark notification as read.",
    markAllReadSuccess: "Notifications marked as read.",
    markAllReadFailed: "Failed to mark notifications as read.",
    ruleFilterActive: "Viewing notifications created by this rule.",
    ruleFilterClear: "Clear rule filter",
    sections: {
      importantTitle: "Important Notifications",
      importantDescription: "{count} unread attention items.",
      importantEmpty: "No important notifications right now.",
      reportsTitle: "Reports",
      reportsDescription:
        "Review recurring reports generated by notification rules.",
      reportsEmpty: "No reports right now.",
    },
    tabs: {
      all: "All",
      unread: "Unread",
      attention: "Attention",
      report: "Reports",
    },
    tabDescriptions: {
      all: "Total messages",
      unread: "Waiting for review",
      attention: "Needs attention",
      report: "Recurring reports",
    },
    messageTypes: {
      report: "Report",
      milestone: "Milestone",
      threshold: "Threshold",
      change: "Change",
      health: "Health",
      system: "System",
      test: "Test",
    },
    severities: {
      info: "Info",
      success: "Success",
      warning: "Warning",
      critical: "Critical",
    },
    deliveryStatuses: {
      created: "Created",
      sending: "Sending",
      sent: "Sent",
      partial: "Partial",
      failed: "Failed",
      skipped: "Skipped",
    },
    channels: {
      inApp: "In-app",
      email: "Email",
    },
    channelStatuses: {
      sent: "sent",
      skipped: "skipped",
      failed: "failed",
      created: "created",
    },
    emailSkipReasons: {
      user_preference_disabled: "email disabled by user preference",
      system_email_unconfigured: "system email is not configured",
      recipient_email_invalid: "recipient email is invalid",
      secret_decryption_failed: "saved email credentials cannot be decrypted",
      provider_failed: "provider rejected the message",
      network_failed: "unable to reach email provider",
      unknown: "unknown reason",
    },
    emailAttempts: "Attempts: {count}",
    emailRetryCount: "Retries: {count}",
    emailDuration: "{duration} ms",
    typeFilterLabel: "Type",
    severityFilterLabel: "Severity",
    allTypes: "All types",
    allSeverities: "All severities",
    preferencesTitle: "Notification preferences",
    preferencesDescription:
      "These settings control email delivery and which messages remain unread for attention.",
    emailNotificationsLabel: "Email notifications",
    emailNotificationsDescription: "Send email when a rule triggers.",
    reportsUnreadLabel: "Reports unread",
    reportsUnreadDescription: "Keep reports unread after creation.",
    milestonesUnreadLabel: "Milestones unread",
    milestonesUnreadDescription: "Reserve unread state for milestones.",
    alertsUnreadLabel: "Alerts unread",
    alertsUnreadDescription: "Keep threshold and health alerts unread.",
    preferencesSaved: "Notification preferences saved.",
    preferencesSaveFailed: "Failed to save notification preferences.",
    detailFields: {},
  },
  notificationEmail: {
    common: {
      brand: "InsightFlare",
      date: "Date",
      coreMetrics: "Core metrics",
      topPages: "Top pages",
      topReferrers: "Top referrers",
      views: "views",
      visitors: "visitors",
      sessions: "sessions",
      visits: "visits",
      viewsUnit: "views",
      direct: "Direct",
      metric: "Metric",
      window: "Window",
      currentValue: "Current value",
      previousValue: "Previous value",
      threshold: "Threshold",
      milestone: "Milestone",
      change: "Change",
      mode: "Mode",
      lastSeen: "Last seen",
      never: "Never",
      noPageData: "No page data yet.",
      noReferrerData: "No referrer data yet.",
      footer: "This email was sent by the InsightFlare notification system.",
      fallbackSubject: "InsightFlare notification",
      trackingHint:
        "Check whether the tracking script is installed correctly or whether the site still has traffic.",
      severity: {
        info: "Info",
        success: "Success",
        warning: "Warning",
        critical: "Critical",
      },
    },
    test: {
      subject: "InsightFlare notification test",
      title: "InsightFlare notification test",
      summary: "This is a test notification from InsightFlare.",
      body: "This is a test notification from InsightFlare. If email is configured and enabled, it also verifies Resend delivery.",
    },
    report: {
      subject: "{site} {periodLabel} traffic report",
      title: "{site} {periodLabel} traffic report",
      summary: "{date}: {visitors} visitors and {views} views.",
      periodLabels: {
        daily: "daily",
        weekly: "weekly",
        monthly: "monthly",
        quarterly: "quarterly",
        yearly: "yearly",
      },
    },
    milestone: {
      subject: "{site} reached {bucket} {metric}",
      title: "{site} reached {bucket} {metric}",
      summary: "Traffic milestone reached: {bucket} {metric}.",
    },
    threshold: {
      subject: "{site} traffic threshold reached",
      title: "{site} traffic threshold reached",
      summary:
        "{metric} for {window} is {value}, matching threshold {operator} {target}.",
      metricLabels: {
        views: "views",
        visitors: "visitors",
        sessions: "sessions",
      },
      windows: {
        last_1h: "Last 1 hour",
        last_24h: "Last 24 hours",
        yesterday: "Yesterday",
      },
    },
    health: {
      subject: "{site} has not received traffic data for {hours} hours",
      title: "{site} has not received traffic data for {hours} hours",
      noHistory:
        "No historical traffic data is available. Check whether the tracking script is installed correctly.",
    },
    change: {
      subject: "{site} traffic change alert",
      title: "{site} traffic change alert",
      summary: "{metric} for {window} changed by {change}.",
    },
  },
  runtimeConfigError: {
    title: "Runtime configuration required",
    eyebrow: "Deployment paused",
    heading:
      "InsightFlare needs one runtime secret before the dashboard can load.",
    description:
      "The app has started, but the current runtime environment could not read the required root secret, so dashboard access is temporarily blocked.",
    requiredTitle: "Required runtime secret",
    requiredDescription:
      "Set at least one of the following values in your Cloudflare runtime secrets.",
    secretHint:
      "MAIN_SECRET is recommended. Existing deployments can continue using DAILY_SALT_SECRET.",
    commandTitle: "Cloudflare command",
    commandDescription:
      "Use the project helper command to write the recommended secret, then redeploy.",
    quickStartHint:
      "Or see the Quick Start section in the GitHub README to configure this variable.",
    docsLabel: "Open GitHub",
    homeLabel: "Retry dashboard",
  },
  login: {
    title: "Sign in",
    subtitle: "Use your InsightFlare account.",
    username: "Username or Email",
    password: "Password",
    signIn: "Sign in",
    invalidCredentials: "Invalid username or password.",
  },
  accountLinks: {
    invite: {
      title: "Team invitation",
      subtitle: "Accept the invitation to join this team.",
      loading: "Loading invitation...",
      missingToken: "Invitation token is missing.",
      loadFailed: "Failed to load invitation.",
      accept: "Accept invitation",
      accepting: "Accepting...",
      accepted: "Invitation accepted.",
      acceptFailed: "Failed to accept invitation.",
      signIn: "Sign in to accept",
      signedInNotice:
        "You are signed in. Accepting will add your account to this team.",
      teamLabel: "Team",
      roleLabel: "Role",
      emailLabel: "Invite email",
      accountEmailLabel: "Account email",
      anyEmail: "Any account",
      expiresLabel: "Expires",
      usernameLabel: "Username",
      nameLabel: "Display name",
      passwordLabel: "Password",
      roles: {
        admin: "Admin",
        member: "Member",
      },
    },
    resetPassword: {
      title: "Reset password",
      subtitle: "Set a new password for this account.",
      loading: "Loading reset link...",
      missingToken: "Reset token is missing.",
      loadFailed: "Failed to load reset link.",
      reset: "Reset password",
      resetting: "Resetting...",
      resetDone: "Password reset. Sign in with the new password.",
      resetFailed: "Failed to reset password.",
      signIn: "Back to sign in",
      accountLabel: "Account",
      emailLabel: "Email",
      expiresLabel: "Expires",
      passwordLabel: "New password",
      confirmPasswordLabel: "Confirm password",
      passwordTooShort: "Password must be at least 8 characters.",
      passwordMismatch: "Passwords do not match.",
    },
  },
  empty: {
    noTeams: "No team available yet.",
    noSites: "No site is available under this team.",
    siteNotFound: "Team or site not found.",
  },
  actions: {
    logout: "Logout",
    switchToEnglish: "English",
    switchToChinese: "中文",
    switchToJapanese: "日本語",
    switchToLight: "Light",
    switchToDark: "Dark",
  },
  teamSelect: {
    groupLabel: "Team",
    groups: {
      created: "Created teams",
      managed: "Managed teams",
      member: "Member teams",
      system: "System teams",
    },
    createHint: "Create team",
    createTitle: "Create Team",
    createDescription: "You will be switched to the new team after creation.",
    nameLabel: "Team Name",
    namePlaceholder: "e.g. Growth Team",
    slugLabel: "Team Slug (optional)",
    slugPlaceholder: "e.g. growth-team",
    create: "Create",
    creating: "Creating...",
    cancel: "Cancel",
    invalidName: "Team name must be at least 2 characters.",
    createFailed: "Failed to create team. Please try again.",
    createSuccess: "Team created.",
  },
  teamManagement: {
    stats: {
      sites: "Sites",
      members: "Members",
    },
    toasts: {
      teamSaved: "Team settings saved.",
      teamSaveFailed: "Failed to save team settings.",
      teamDeleted: "Team deleted.",
      teamDeleteFailed: "Failed to delete team.",
      memberRemoved: "Member removed.",
      memberRemoveFailed: "Failed to remove member.",
      roleChanged: "Member role updated.",
      roleChangeFailed: "Failed to update member role.",
      siteAccessChanged: "Member site access updated.",
      siteAccessChangeFailed: "Failed to update site access.",
      invalidTeamName: "Team name must be at least 2 characters.",
      inviteCreated: "Invite link created.",
      inviteCreateFailed: "Failed to create invite link.",
      inviteRevoked: "Invite revoked.",
      inviteRevokeFailed: "Failed to revoke invite.",
      inviteCopied: "Invite link copied.",
      inviteCopyFailed: "Failed to copy invite link.",
      invalidInviteEmail: "Please provide a valid invite email.",
      invalidInviteExpiry: "Invite expiry must be at least 1 hour.",
      ownerTransferred: "Ownership transferred.",
      ownerTransferFailed: "Failed to transfer ownership.",
      invalidTransferTarget: "Please choose a new owner.",
    },
    sites: {
      title: "Site Dashboard",
      subtitle: "Aggregated traffic view across all sites in this team.",
      aggregateTitle: "Total Visits",
      pagesPerSession: "Pages / Session",
      noSites: "No site is available under this team.",
      openAnalytics: "Open analytics",
    },
    widgets: {
      title: "Widgets",
      subtitle: "Widget functionality is being built.",
      underConstruction: "Under construction",
    },
    notifications: {
      title: "Event Notifications",
      subtitle: "Manage event notification rules for this team.",
      empty: "This team has no event notification rules yet.",
      forbiddenTitle: "Notification rules are managed by team admins",
      forbiddenDescription:
        "You can still view your own notifications and update your personal notification preferences.",
      rulesTitle: "Notification Rules",
      enabledCount: "{count} enabled rules in this team.",
      loadingRules: "Loading notification rules",
      deliveryTestTitle: "Delivery Test",
      deliveryTestDescription:
        "Creates one in-app notification for you and attempts email when available.",
      inAppTestHint: "We will send you an in-app notification.",
      emailTestConfiguredHint: "We will send you a test email.",
      emailTestUnconfiguredHint:
        "Email sending is not configured for this system. Contact an administrator to add it.",
      sendTestNotification: "Send test notification",
      loadRulesFailed: "Failed to load notification rules.",
      testNotificationSent: "Test notification sent.",
      sendTestNotificationFailed: "Failed to send test notification.",
      createRule: "Create rule",
      editRule: "Edit rule",
      dialogDescription: "Configure a basic notification rule for this team.",
      ruleInfoSection: "Rule info",
      scheduleSection: "Schedule",
      sendScheduleSection: "Send time",
      checkSection: "Check frequency",
      conditionSection: "Conditions",
      deliverySection: "Delivery",
      summarySection: "Summary",
      liveSummaryDescription: "Confirm how this rule will run.",
      nameLabel: "Name",
      siteLabel: "Site",
      chooseSite: "Choose site",
      ruleTypeLabel: "Rule type",
      recipientLabel: "Recipient",
      enabledLabel: "Enabled",
      enabledHint: "Run this rule",
      scheduleLabel: "Schedule",
      timeLabel: "Time",
      timezoneLabel: "Time zone",
      intervalLabel: "Interval",
      dayLabel: "Day",
      dayOfMonthLabel: "Day of month",
      monthLabel: "Month",
      reportPeriodLabel: "Report period",
      milestoneEveryLabel: "Every milestone",
      matchLabel: "Match",
      matchAll: "All",
      matchAny: "Any",
      changeValueLabel: "Change value",
      changeModeLabel: "Change mode",
      changeModePercent: "Percent",
      changeModeAbsolute: "Absolute",
      addCondition: "Add condition",
      removeCondition: "Remove",
      conditionItemTitle: "Condition {index}",
      metricLabel: "Metric",
      windowLabel: "Window",
      operatorLabel: "Operator",
      valueLabel: "Value",
      cooldownLabel: "Cooldown",
      cooldownDescription:
        "Reports will not be sent again during this cooldown window.",
      noDataHoursLabel: "No data hours",
      pleaseChooseSite: "Please choose a site.",
      pleaseChooseRecipients: "Please choose at least one recipient.",
      ruleCreated: "Rule created.",
      ruleUpdated: "Rule updated.",
      createRuleFailed: "Failed to create rule.",
      updateRuleFailed: "Failed to update rule.",
      deleteConfirm: 'Delete "{name}"?',
      ruleDeleted: "Rule deleted.",
      deleteRuleFailed: "Failed to delete rule.",
      lastChecked: "Last checked",
      actions: "Actions",
      edit: "Edit",
      enable: "Enable",
      disable: "Disable",
      delete: "Delete",
      saveRule: "Save rule",
      emailPreview: "Email preview",
      preview: "Preview",
      runNow: "Run now",
      previewFailed: "Failed to preview rule.",
      runFailed: "Failed to run rule.",
      runResultToast:
        "Created {messages} messages. Email sent {sent}, failed {failed}.",
      previewDialogTitle: "Rule preview",
      previewDialogDescription:
        "Evaluate this rule without creating messages or sending email.",
      coolingDownUntil: "Cooling down until {time}",
      scheduleDaily: "Daily {time}",
      scheduleWeekly: "Weekly {day} {time}",
      scheduleMonthly: "Monthly day {day} {time}",
      scheduleQuarterly: "Quarterly day {day} {time}",
      scheduleYearly: "Yearly {month}/{day} {time}",
      scheduleInterval: "Every {minutes} min",
      scheduleCustom: "Custom",
      conditionReport: "{period} report",
      conditionMilestone: "{metric} every {step}",
      conditionThreshold: "{window} {metric} {operator} {value}",
      conditionChange: "{window} {metric} change {operator} {value}",
      conditionHealth: "No data for {hours}h",
      summaryWhenConditions:
        "When {combinator} of the following conditions match, send a {type} notification:",
      summaryWhenSingleCondition:
        "When this condition matches, send a {type} notification:",
      summaryConditionThreshold: "{window} {metric} {operator} {value}",
      summaryConditionChange:
        "{window} {metric} {mode} change {operator} {value}",
      summaryReportSchedule: "{period}: {schedule}",
      summaryMilestoneCondition: "{metric} reaches every {step}",
      summaryHealthCondition: "No data for {hours} hours",
      defaultNames: {
        report: "{site} daily report",
        milestone: "{site} traffic milestone",
        threshold: "{site} traffic threshold",
        change: "{site} traffic change",
        health: "{site} health check",
      },
      columns: {
        name: "Name",
        type: "Type",
        site: "Site",
        recipient: "Recipient",
        schedule: "Schedule",
        condition: "Condition",
        nextRun: "Next Run",
        status: "Status",
      },
      status: {
        enabled: "Enabled",
        disabled: "Disabled",
      },
      nextRunStates: {
        disabled: "Disabled",
        coolingDown: "Cooling down",
        dueNow: "Due now",
      },
      previewFields: {
        status: "Status",
        summary: "Summary",
        title: "Title",
        htmlPreview: "HTML preview",
        bodyText: "Body text",
        data: "Data",
        createdAt: "Created at",
        updatedAt: "Updated at",
        loadingContent: "Loading evaluated report content",
        noHtmlPreview: "This preview has no HTML content.",
      },
      ruleTypes: {
        report: "Report",
        milestone: "Milestone",
        threshold: "Threshold",
        change: "Change",
        health: "Health",
        test: "Test",
      },
      ruleTypeDescriptions: {
        report: "Send a site overview on a schedule",
        milestone: "Notify when a metric reaches each step",
        threshold: "Notify when a metric crosses a limit",
        change: "Notify on period-over-period movement",
        health: "Notify when tracking goes quiet",
      },
      recipientModes: {
        creator: "Creator",
        team_admins: "Team admins",
        all_team_members: "All members",
        users: "Selected users",
      },
      recipientKindLabel: "Recipient type",
      recipientPresetLabel: "Preset",
      customRecipientsEmpty: "No recipients selected",
      noTeamMembers: "No team members available.",
      recipientKinds: {
        preset: "Preset",
        custom: "Custom",
      },
      scheduleKinds: {
        daily: "Daily",
        weekly: "Weekly",
        monthly: "Monthly",
        quarterly: "Quarterly",
        yearly: "Yearly",
        interval: "Interval",
      },
      reportPeriods: {
        daily: "Daily report",
        weekly: "Weekly report",
        monthly: "Monthly report",
        quarterly: "Quarterly report",
        yearly: "Yearly report",
      },
      cooldownUnits: {
        minutes: "minutes",
        hours: "hours",
        days: "days",
      },
      intervalOptions: {
        every30Minutes: "Every 30 minutes",
        everyHour: "Every hour",
        every6Hours: "Every 6 hours",
        every12Hours: "Every 12 hours",
        everyDay: "Every day",
        every7Days: "Every 7 days",
        every30Days: "Every 30 days",
      },
      weekDays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      metrics: {
        views: "Views",
        visitors: "Visitors",
        sessions: "Sessions",
      },
      windows: {
        last_1h: "Last 1h",
        last_24h: "Last 24h",
        yesterday: "Yesterday",
      },
      emailPreviewPage: {
        title: "Notification email preview",
        subtitle:
          "Render notification emails without creating messages or sending through Resend.",
        typeLabel: "Preview type",
        localeLabel: "Preview locale",
        formatLabel: "Preview format",
        html: "HTML",
        text: "Plain text",
        json: "JSON",
        refresh: "Preview",
        loading: "Rendering preview...",
        loadFailed: "Failed to render email preview.",
        subject: "Subject",
      },
    },
    publicLinks: {
      title: "Public Links",
      subtitle: "Manage publicly accessible sharing links for this team.",
      enabled: "Enabled",
      disabled: "Disabled",
      disabledHint:
        "Public access is disabled. Open site settings to enable it.",
      viewSettings: "View Settings",
      copyLink: "Copy Link",
      linkCopied: "Link copied",
      noSites: "This team has no sites yet.",
      columns: {
        site: "Site",
        domain: "Domain",
        publicUrl: "Public Link",
        status: "Status",
        action: "Action",
      },
    },
    apiKeys: {
      title: "API Keys",
      subtitle: "Manage API access keys for this team.",
      empty: "This team has no API keys yet.",
      create: "Create key",
      creating: "Creating...",
      createTitle: "Create API key",
      createSubtitle: "Choose the least privileges this integration needs.",
      nameLabel: "Key name",
      namePlaceholder: "Production sync",
      scopesTitle: "Permissions",
      scopesDescription:
        "API keys can never manage members, users, ownership, or other keys.",
      siteScopeTitle: "Site access",
      siteScopeDescription:
        "No selection means every current and future site in this team.",
      allSites: "All sites",
      expirationLabel: "Expires",
      expiration30: "30 days",
      expiration90: "90 days",
      expiration180: "180 days",
      expiration365: "365 days",
      expirationNever: "Never",
      oneTimeSecretTitle: "Copy this key now",
      oneTimeSecretDescription:
        "This full key is shown once. Store it before closing this dialog.",
      copySecret: "Copy key",
      revoke: "Revoke",
      rotate: "Rotate",
      revokeConfirm: "Revoke this API key immediately?",
      rotateConfirm:
        "Rotate this API key? The old key will be revoked immediately.",
      neverExpires: "Never expires",
      notUsed: "Not used",
      loading: "Loading API keys...",
      loadFailed: "Failed to load API keys.",
      invalidInput: "Enter a name and choose at least one permission.",
      createFailed: "Failed to create API key.",
      revokeFailed: "Failed to revoke API key.",
      rotateFailed: "Failed to rotate API key.",
      copied: "Copied",
      status: {
        active: "Active",
        expired: "Expired",
        revoked: "Revoked",
      },
      scopes: {
        analyticsRead: "Analytics read",
        siteRead: "Site read",
        siteWrite: "Site write",
        siteConfigRead: "Config read",
        siteConfigWrite: "Config write",
      },
      scopeDescriptions: {
        analyticsRead:
          "View visits, visitors, page views, and other analytics data",
        siteRead: "View site list and site details",
        siteWrite: "Create, update, or delete sites",
        siteConfigRead:
          "View site settings like tracking code and domain whitelist",
        siteConfigWrite:
          "Modify site settings like tracking strength and path blacklist",
      },
      scopeGroups: {
        analytics: "Analytics",
        site: "Site",
        siteConfig: "Site Configuration",
      },
      columns: {
        name: "Name",
        scopes: "Permissions",
        sites: "Sites",
        expires: "Expires",
        lastUsed: "Last used",
        status: "Status",
        action: "Action",
      },
    },
    settings: {
      title: "Settings",
      subtitle: "Update this team's display name and slug.",
      nameLabel: "Team Display Name",
      slugLabel: "Team Slug",
      save: "Save settings",
      saving: "Saving...",
      delete: "Delete team",
      deleting: "Deleting...",
      deleteConfirm:
        "Delete this team and all its data? This action cannot be undone.",
      transferTitle: "Transfer Ownership",
      transferSubtitle:
        "Transfer team ownership to another member. The current owner will be demoted to admin.",
      transferTargetLabel: "New Owner",
      transferTargetPlaceholder: "Choose a team member",
      transfer: "Transfer ownership",
      transferring: "Transferring...",
      transferConfirm:
        "This action cannot be undone. You will lose ownership but keep admin access. Continue?",
      noTransferableMembers:
        "No other members are available to transfer to. Add a member first.",
    },
    members: {
      title: "Members",
      subtitle: "Invite members or remove existing members.",
      remove: "Remove",
      noMembers: "No members found for this team.",
      invitesTitle: "Create invite link",
      invitesSubtitle: "Users join this team only after accepting an invite.",
      inviteEmailLabel: "Email restriction (optional)",
      inviteEmailPlaceholder: "user@example.com",
      inviteExpiresLabel: "Expires in hours",
      createInvite: "Create invite link",
      creatingInvite: "Creating...",
      copyInvite: "Copy link",
      inviteLinksTitle: "Invite links",
      inviteLinksSubtitle: "Review invite status and revoke active links.",
      noInvites: "This team has no invite links yet.",
      anyEmail: "Any email",
      revokeInvite: "Revoke invite",
      siteAccessLabel: "Site access",
      siteAccessAll: "All sites",
      siteAccessRestricted: "Restricted",
      siteAccessSelected: "Selected {count} sites",
      siteAccessDescription:
        "Leave this set to all sites, or choose the specific sites this member can access.",
      siteAccessAdmins: "Admins can access every site in this team.",
      siteAccessDialogTitle: "Edit site access",
      saveSiteAccess: "Save access",
      cancelSiteAccess: "Cancel",
      noSitesForAccess: "This team has no sites yet.",
      inviteStatuses: {
        active: "Active",
        used: "Used",
        revoked: "Revoked",
        expired: "Expired",
      },
      columns: {
        name: "Name",
        username: "Username",
        email: "Email",
        inviteCode: "Invite token",
        role: "Role",
        siteAccess: "Site access",
        joinedAt: "Joined",
        createdAt: "Created",
        expiresAt: "Expires",
        usedAt: "Used",
        status: "Status",
        action: "Action",
      },
      roleLabels: {
        owner: "Owner",
        admin: "Admin",
        member: "Member",
      },
    },
  },
  managementNav: {
    users: "User Management",
    sites: "Site Management",
    teams: "Team Management",
    versionUpdates: "Version Updates",
    scheduledTasks: "Scheduled Tasks",
    requestObservation: "Request Observability",
    systemPerformance: "System Performance",
    systemSettings: "System Settings",
  },
  managementPages: {
    versionUpdates: {
      subtitle: "Review published InsightFlare releases and the running build.",
      empty: "No version update records yet.",
      currentVersion: "Current version",
      latestVersion: "Latest release",
      currentCommit: "Current commit",
      releaseCount: "Releases",
      publishedAt: "Published",
      author: "Author",
      commit: "Commit",
      statusStable: "Stable",
      statusPrerelease: "Prerelease",
      statusDraft: "Draft",
      currentVersionBadge: "Current version",
      releaseNotes: "Release notes",
      openRelease: "Open release",
      viewDetails: "View detailed changes",
      detailsTitle: "Detailed changes",
      detailsDescription: "Commits included in {range}.",
      detailsLoading: "Loading detailed changes...",
      detailsEmpty: "No previous release is available for this version yet.",
      detailsFailed: "Failed to load detailed changes.",
      currentCommitBadge: "Current deployment",
      openCompare: "Open compare",
      openCommit: "Open commit",
      commitCount: "Commits",
      source: "Data source",
      loadFailed: "Failed to load GitHub Releases.",
      unknown: "Unknown",
    },
    scheduledTasks: {
      subtitle: "View and manage system scheduled tasks.",
      empty: "No scheduled tasks yet.",
      refresh: "Refresh",
      loadFailed: "Failed to load scheduled tasks.",
      allStatuses: "All statuses",
      runs24h: "24h runs",
      successRate24h: "24h success rate",
      successRateDescription: "Counts only successful runs.",
      problemRuns24h: "Problem runs",
      retentionPrefix: "Retained for",
      days: "days",
      failed: "Failed",
      partial: "Partial",
      lastRun: "Last run",
      staleRunning: "Stale running",
      noStaleRunning: "No stale running runs",
      taskListTitle: "Tasks",
      taskListDescription:
        "Registered scheduled tasks and 30-day health status.",
      task: "Task",
      schedule: "Schedule",
      enabled: "State",
      enabledYes: "Enabled",
      enabledNo: "Disabled",
      lastStatus: "Last status",
      runs30d: "30d runs",
      successRate30d: "30d success rate",
      avgDuration: "Avg duration",
      runHistoryTitle: "Run history",
      runHistoryDescription: "Task runs retained over the last 30 days.",
      noRuns: "No runs yet.",
      scheduledAt: "Scheduled",
      startedAt: "Started",
      finishedAt: "Finished",
      trigger: "Trigger",
      tasks: "Tasks",
      taskCount: "Tasks",
      subtaskCount: "Subtasks",
      taskResult: "Task result",
      statusLabel: "Status",
      duration: "Duration",
      sites: "Sites",
      hours: "Hours",
      rows: "Rows",
      rulesScanned: "Rules",
      messagesCreated: "Messages",
      emailFailed: "Email failed",
      logs: "Logs",
      viewLogs: "View",
      logTitle: "Run logs",
      noRunSelected: "Select a run to inspect logs.",
      noLogs: "No logs for this run.",
      error: "Error",
      status: {
        running: "Running",
        success: "Success",
        partial: "Partial",
        failed: "Failed",
        skipped: "Skipped",
      },
      taskDefinitions: {
        visit_hourly_rollup: {
          name: "Hourly visit aggregation",
          description:
            "Aggregates closed visit rows into hourly rollups for dashboard counters and trends.",
          schedule: "Every hour",
        },
        notification_tick: {
          name: "Notification dispatch",
          description: "Evaluates notification rules and dispatches messages.",
          schedule: "Every hour",
        },
      },
    },
  },
  adminUsers: {
    title: "User Management",
    subtitle: "Only system admins can create and manage dashboard users.",
    createTitle: "Create User",
    createTeamNotice:
      "Creating a user here will also create a new Team owned by that user. To add someone to an existing team, create an invite link from that team's settings.",
    username: "Username",
    email: "Email",
    name: "Display Name (optional)",
    password: "Password (min 8 chars)",
    role: "System Role",
    teamName: "Team Name",
    teamSlug: "Team Slug (optional)",
    defaultTeamName: "{name}'s team",
    create: "Create User",
    creating: "Creating...",
    delete: "Delete",
    deleting: "Deleting...",
    deleteConfirm: "Delete this user account?",
    deleteSuccess: "User deleted.",
    deleteFailed: "Failed to delete user.",
    generateResetLink: "Generate password reset link",
    resetLinkCreated: "Password reset link generated.",
    resetLinkCreateFailed: "Failed to generate password reset link.",
    resetLinkCopied: "Password reset link copied.",
    resetLinkCopyFailed: "Failed to copy password reset link.",
    copyResetLink: "Copy link",
    resetLinkExpiresAt: "Expires",
    listTitle: "Users",
    listSubtitle: "All users in the system.",
    noData: "No users found.",
    loadFailed: "Failed to load users.",
    createSuccess: "User created.",
    createFailed: "Failed to create user.",
    invalidInput: "Please provide valid username, email and password.",
    columns: {
      name: "Name",
      username: "Username",
      email: "Email",
      role: "Role",
      teams: "Teams",
      created: "Created",
      action: "Action",
    },
  },
  adminSites: {
    title: "Site Management",
    subtitle: "Manage sites under the current team.",
    team: "Team",
    createTitle: "Create Site",
    createSubtitle: "The new site can be opened immediately.",
    name: "Site Name",
    domain: "Domain",
    publicSlug: "Public Slug (optional)",
    create: "Create Site",
    creating: "Creating...",
    listTitle: "Sites",
    listSubtitle: "All sites under the current team.",
    noData: "No site found.",
    loadFailed: "Failed to load sites.",
    createSuccess: "Site created.",
    createFailed: "Failed to create site.",
    invalidInput: "Please provide a valid site name and domain.",
    open: "Open analytics",
    columns: {
      name: "Name",
      domain: "Domain",
      slug: "Slug",
      created: "Created",
      action: "Action",
    },
  },
  adminTeams: {
    title: "Team Management",
    subtitle: "Only system admins can create and view all teams.",
    createTitle: "Create Team",
    createSubtitle: "After creation, you can manage settings and members.",
    name: "Team Name",
    slug: "Team Slug (optional)",
    create: "Create Team",
    creating: "Creating...",
    listTitle: "Teams",
    listSubtitle: "All teams in the system.",
    noData: "No teams found.",
    loadFailed: "Failed to load teams.",
    createSuccess: "Team created.",
    createFailed: "Failed to create team.",
    invalidInput: "Team name must be at least 2 characters.",
    open: "Open team",
    settings: "Settings",
    columns: {
      name: "Name",
      slug: "Slug",
      sites: "Sites",
      members: "Members",
      created: "Created",
      action: "Action",
    },
  },
  requestObservation: {
    title: "Request Observability",
    subtitle:
      "Monitor total requests, anomaly routing, and the normal collection pipeline from Analytics Engine.",
    tabs: {
      overview: "Overview",
      abnormal: "Abnormal Requests",
      normal: "Normal Requests",
    },
    refresh: "Refresh",
    loadFailed: "Failed to load request observability data.",
    notConfiguredTitle: "Analytics Engine reader is not configured",
    notConfiguredDescription:
      "Add a Cloudflare Account ID and API token in System Settings to read the request-observation Analytics Engine datasets.",
    analyticsEngineDisabledTitle: "Analytics Engine is not enabled",
    analyticsEngineDisabledDescription:
      "This deployment was published without the Analytics Engine binding because the Cloudflare account has not enabled Analytics Engine. Enable it in Cloudflare, then redeploy to collect request-observation data.",
    openAnalyticsEngine: "Open Analytics Engine",
    openSettings: "Open settings",
    highConfidenceBots: "High-confidence Bots",
    affectedSites: "Affected Sites",
    uniqueCountries: "Countries",
    noData: "No request data in this window.",
    trendTitle: "Routing Trend",
    trendDescription:
      "Normal requests, abnormal requests, and diversion ratio by interval.",
    recentTitle: "Recent Bot Requests",
    recentDescription:
      "Detailed records written only to the bot Analytics Engine dataset.",
    recentShowing: "Showing",
    recentLoadedAll: "All records loaded",
    detailTitle: "Bot Request Detail",
    detailSubtitle:
      "Inspect detection signals, network context, and client data for this diverted request.",
    client: "Client",
    edge: "Edge",
    identifiers: "Identifiers",
    fullUserAgent: "Full User-Agent",
    id: "ID",
    metadata: "Metadata",
    time: "Time",
    site: "Site",
    location: "Location",
    network: "Network",
    reason: "Reason",
    request: "Request",
    ip: "IP",
    userAgent: "User agent",
    confidence: "Confidence",
    blocked: "Blocked",
    highConfidenceRequests: "High-confidence Requests",
    emptyValue: "Unknown",
    kind: "Type",
    botScoreBucket: "Bot Score Bucket",
    verifiedBotCategory: "Verified Bot Category",
    hostname: "Hostname",
    pathname: "Path",
    origin: "Origin",
    asOrganization: "ASN Organization",
    asn: "ASN",
    country: "Country",
    region: "Region",
    city: "City",
    colo: "Colo",
    userAgentLengthBucket: "User-Agent Length",
    ipPrefix: "IP Prefix",
    botReasonLabels: {
      missing_ua: "Missing User-Agent",
      ua_too_long: "User-Agent too long",
      ua_isbot: "User-Agent matches bot",
      script_ua: "Script client User-Agent",
      cf_bot_score_low: "Low Cloudflare Bot Score",
      cf_verified_bot_category: "Cloudflare verified bot category",
      hosting_asn: "Hosting ASN",
      network_service_asn: "Network service ASN",
      transit_asn: "Transit ASN",
      access_asn: "Access ASN",
      missing_browser_provenance: "Missing browser provenance",
      origin_hostname_mismatch: "Origin and hostname mismatch",
      blocked_pathname: "Blocked pathname",
    },
    requestKindLabels: {
      pageview: "Pageview",
      custom_event: "Custom Event",
      request: "Request",
    },
    overviewLabels: {
      totalRequests: "Total requests",
      normalRequests: "Normal requests",
      abnormalRequests: "Abnormal requests",
      abnormalRatio: "Abnormal request ratio",
      p50Latency: "P50 edge latency",
      p75Latency: "P75 edge latency",
      p95Latency: "P95 edge latency",
      p99Latency: "P99 edge latency",
      avgLatency: "Average edge latency",
      pageviews: "Pageviews",
      customEvents: "Custom events",
      overviewTrendTitle: "Request routing trend",
      overviewTrendDescription:
        "Normal requests, abnormal requests, and abnormal ratio bucketed by the top-bar interval.",
      trafficCompositionTitle: "Request composition",
      trafficCompositionDescription:
        "Normal requests, abnormal requests, and page events on the same timeline.",
      confidenceShareTitle: "Request confidence breakdown",
      normalTrafficShare: "Normal traffic",
      lowConfidenceTraffic: "Low-confidence traffic",
      mediumConfidenceTraffic: "Medium-confidence traffic",
      highConfidenceTraffic: "High-confidence traffic",
      latencyTitle: "Edge latency trend",
      latencyDescription:
        "P50 / P75 / P95 / P99 edge latency recorded when normal requests are written to AE.",
      abnormalSubtitle:
        "Focus on diverted abnormal requests. Maps and tables show only red abnormal traffic.",
      normalSubtitle:
        "Focus on requests that entered the normal collection pipeline. Maps and tables show only normal traffic.",
      requests: "Requests",
      windowDays: "Last {days} days",
      latencyMilliseconds: "{value} ms",
    },
    normalDetail: {
      title: "Normal Request Detail",
      subtitle:
        "Inspect pipeline, location, and latency fields recorded for a normal request in AE.",
      requestMethod: "Request method",
      edgeLatency: "Edge latency",
      eventAt: "Event time",
      receivedAt: "Received at",
      coordinates: "Coordinates",
      continent: "Continent",
    },
    recentNormal: {
      title: "Recent Normal Requests",
      description:
        "Detailed records written only to the normal request Analytics Engine dataset.",
    },
  },
  systemSettings: {
    title: "System Settings",
    subtitle:
      "Manage instance-wide configuration for this InsightFlare deployment.",
    guide: "Guide",
    botAnalyticsTitle: "Analytics Engine",
    botAnalyticsDescription:
      "Configure the Cloudflare credentials used to read Analytics Engine data for Bot Protection and other analysis features.",
    botAnalyticsAccountIdLabel: "Cloudflare Account ID",
    botAnalyticsApiTokenLabel: "Cloudflare API token",
    botAnalyticsApiTokenPlaceholder:
      "View the guide to get a Cloudflare API token",
    botAnalyticsSaved: "Analytics Engine configuration saved.",
    botAnalyticsSaveFailed: "Failed to save Analytics Engine configuration.",
    botAnalyticsDeleted: "Analytics Engine configuration deleted.",
    botAnalyticsDeleteFailed:
      "Failed to delete Analytics Engine configuration.",
    botAnalyticsDeleteConfirm:
      "Delete the Analytics Engine read configuration? Features that depend on Analytics Engine will show configuration required until it is restored.",
    botAnalyticsEngineDisabledTitle: "Analytics Engine is not enabled",
    botAnalyticsEngineDisabledDescription:
      "This deployment automatically disabled the Analytics Engine binding because the Cloudflare account has not enabled Analytics Engine. Enable Analytics Engine in Cloudflare, then redeploy InsightFlare to activate related analysis features.",
    botAnalyticsEngineDisabledHint:
      "Analytics Engine settings are locked until Analytics Engine is enabled and the Worker is redeployed.",
    botAnalyticsOpenCloudflare: "Open Cloudflare Analytics Engine",
    botAnalyticsGuideTitle: "Get Analytics Engine credentials",
    botAnalyticsGuideDescription:
      "Analytics Engine needs Cloudflare account details and an API token that can read Analytics Engine data.",
    botAnalyticsGuideSteps: [
      "Open the Cloudflare Dashboard, enter the target account, and copy the Account ID.",
      "Enable Analytics Engine under Workers & Pages; the bot and normal request datasets are created and bound automatically during deployment.",
      "Go to My Profile → API Tokens and create a Custom token.",
      "Grant the token Account Analytics read access and scope it to the current account.",
      "Copy the token, then enter the Account ID and API token here.",
    ],
    notificationEmailTitle: "Email Notifications",
    notificationEmailDescription:
      "Configure the email service used for reports, alerts, and test messages.",
    notificationEmailGuideTitle: "Get Resend email settings",
    notificationEmailGuideDescription:
      "To send system email through Resend, prepare a verified sender domain and an API key.",
    notificationEmailGuideSteps: [
      "Open the Resend Dashboard and confirm the sender domain has passed DNS verification.",
      "Create a new API key from the API Keys page.",
      "Choose the permissions required to send email, then copy the generated API key.",
      "Enter the sender name, sender email, Reply-To, and Resend API key here.",
      "Save the configuration, then send a test email to confirm delivery works.",
    ],
    loginTurnstileTitle: "Login Turnstile Protection",
    loginTurnstileDescription:
      "When enabled, the login page runs Cloudflare Turnstile Invisible verification in the background and the server enforces it during sign-in.",
    loginTurnstileEnabledLabel: "Enable login protection",
    loginTurnstileSiteKeyLabel: "Site Key",
    loginTurnstileSecretKeyLabel: "Secret Key",
    loginTurnstileSecretKeyPlaceholder:
      "View the guide to get a Turnstile Secret Key",
    loginTurnstileModeLabel: "Verification mode",
    loginTurnstileModeInvisible: "Invisible",
    loginTurnstileTest: "Test verification",
    loginTurnstileTesting: "Verifying...",
    loginTurnstileTestPassed: "Verification passed",
    loginTurnstileTestRequired: "New Secret Key must be tested first",
    loginTurnstileTestMissing: "Enter both Site Key and Secret Key first.",
    loginTurnstileTestFailed:
      "Verification failed. Check the Site Key and Secret Key.",
    loginTurnstileSaved: "Login Turnstile configuration saved.",
    loginTurnstileSaveFailed: "Failed to save login Turnstile configuration.",
    loginTurnstileDeleted: "Login Turnstile configuration deleted.",
    loginTurnstileDeleteFailed:
      "Failed to delete login Turnstile configuration.",
    loginTurnstileDeleteConfirm:
      "Delete the login Turnstile configuration? Login protection will be disabled.",
    loginTurnstileLoadFailed: "Failed to load login Turnstile configuration.",
    loginTurnstilePrivacyNotice:
      "Create an Invisible widget in the Cloudflare Turnstile console. For self-hosted deployments, confirm your privacy policy matches Cloudflare Turnstile requirements.",
    loginTurnstileGuideTitle: "Get Turnstile credentials",
    loginTurnstileGuideDescription:
      "Login protection needs a Cloudflare Turnstile Site Key and Secret Key.",
    loginTurnstileGuideSteps: [
      "Open the Cloudflare Dashboard and go to Turnstile.",
      "Create a new widget and choose Invisible mode.",
      "Add the current InsightFlare login domain to the allowed hostnames.",
      "Copy the Site Key and Secret Key after the widget is created.",
      "Enter the Site Key and Secret Key here, run the verification test, then save the configuration.",
    ],
    enabledLabel: "Enable email sending",
    enabledOn: "Enabled",
    enabledOff: "Disabled",
    providerLabel: "Email service",
    providerResend: "Resend",
    fromNameLabel: "Sender name",
    fromEmailLabel: "Sender email",
    replyToLabel: "Reply-To email",
    replyToPlaceholder: "Optional, defaults to sender email",
    resendApiKeyLabel: "Resend API Key",
    resendApiKeyPlaceholder: "View the guide to get a Resend API key",
    testRecipientLabel: "Test recipient",
    save: "Save configuration",
    saving: "Saving...",
    test: "Send test email",
    testing: "Sending...",
    saved: "Email configuration saved.",
    saveFailed: "Failed to save email configuration.",
    delete: "Delete configuration",
    deleting: "Deleting...",
    cancel: "Cancel",
    deleted: "Email configuration deleted.",
    deleteFailed: "Failed to delete email configuration.",
    deleteConfirm:
      "Delete the email notification configuration? The system will treat email as unconfigured and disabled.",
    testSent: "Test email sent.",
    testFailed: "Failed to send test email.",
    loadFailed: "Failed to load email configuration.",
  },
  systemPerformance: {
    title: "System Performance",
    subtitle:
      "Monitor InsightFlare collection, buffering, and write health from existing analytics rows.",
    refresh: "Refresh",
    loadFailed: "Failed to load system performance data.",
    noData: "No system performance data in this window.",
    range15m: "Last 15 minutes",
    range1h: "Last 1 hour",
    range6h: "Last 6 hours",
    range24h: "Last 24 hours",
    totalEvents: "Accepted Events",
    p95Latency: "P95 Estimated Delay",
    p50Latency: "P50",
    p75Latency: "P75",
    p50Label: "P50",
    p75Label: "P75",
    p95Label: "P95",
    dataFreshness: "Data Freshness",
    noRecentWrite: "No recent write",
    clockAnomalies: "Clock / Delay Anomalies",
    delayed: "Delayed",
    future: "Future clock",
    latencyPercentileTrend: "Latency Percentile Trend",
    latencyPercentileTrendDescription:
      "View estimated P50, P75, and P95 delay for received events.",
    throughputTrend: "Accepted Event Throughput",
    throughputTrendDescription: "View the throughput of received events.",
    visits: "Visits",
    customEvents: "Custom Events",
    anomalyBucket: "Anomaly bucket",
    openVisitHealth: "Open Visit Backlog",
    openVisitHealthDescription:
      "Open rows that have not been closed by leave, route change, or timeout finalization.",
    open: "Open",
    stale: "Stale",
    timedOut: "Timed out",
    oldestOpen: "Oldest open",
    latestActivity: "Latest activity",
    latencySampleHealth: "Latency Sample Health",
    latencySampleHealthDescription: "View the delay of trusted events.",
    trustedSamples: "Trusted samples",
    topSitesTitle: "Top Sites by System Load",
    topSitesDescription: "Sites receiving the most events in the current view.",
    events: "Events",
    avgLatency: "Avg delay",
    slowestEventsTitle: "Slowest Estimated Events",
    slowestEventsDescription:
      "Highest positive write-time minus event-time gaps in the selected window.",
    eventTime: "Event time",
    serverTime: "Server write time",
    estimatedDelay: "Estimated delay",
    doDiagnosticTitle: "DO Buffer Diagnostic",
    doDiagnosticDescription:
      "Diagnoses data stagnation in each site's dedicated Durable Object.",
    doDiagnosticLoadFailed: "Failed to load DO diagnostic data.",
    doDiagnosticLoading: "Fetching DO state per site…",
    doDiagnosticRun: "Run DO diagnostic",
    doDiagnosticEmpty: "No DO state available.",
    doDiagnosticUnreachable: "Some DOs unreachable",
    doDiagnosticReachableSites: "Reachable DOs",
    doDiagnosticTotalSites: "Total sites",
    doDiagnosticActiveAlarms: "Active alarms",
    doDiagnosticBufferedVisits: "Buffered visits",
    doDiagnosticOpenVisits: "Buffered open rows",
    doDiagnosticOpenStale: "Open idle >30m",
    doDiagnosticOpenTimedOut: "Open idle >12h",
    doDiagnosticOpenHardAged: "Started >36h ago",
    doDiagnosticOpenFutureSkew: "Future timestamps",
    doDiagnosticStuckDirty: "Stuck dirty",
    doDiagnosticMaxFlushAttempts: "Max retry attempts",
    doDiagnosticBufferedCustomEvents: "Buffered custom events",
    doDiagnosticOldestOpen: "Oldest open started_at",
    doDiagnosticFutureMaxActivity: "Farthest future last_activity",
    doDiagnosticSiteList: "Top risk sites",
    doDiagnosticSiteListDescription:
      "Top 20 sites by risk score, snapshotted from per-DO buffered state.",
    doDiagnosticSiteFailed: "Unreachable",
    doDiagnosticSiteOpen: "open",
    doDiagnosticSiteStuck: "stuck",
    doDiagnosticSiteFuture: "future",
    doDiagnosticSiteHardAged: "aged",
    doDiagnosticSiteAlarm: "Alarm",
    doDiagnosticSiteAlarmNone: "none",
    doDiagnosticSiteAlarmDue: "due",
    doDiagnosticSiteResponseMs: "Response time",
    doDiagnosticThresholdsHint:
      "Thresholds — stale {stale}, timeout {timeout}, hardAged {hardAged}, stuck flush_attempts ≥ {stuck}",
    doDiagnosticHealthy: "No abnormal buffered rows detected.",
  },
  loginForm: {
    signingIn: "Signing in...",
    verifyingSecurity: "Verifying security...",
    securityVerificationTitle: "Security verification failed",
    securityVerificationFailed:
      "Security verification failed. Please try again.",
    retrySecurityVerification: "Retry verification",
    redirecting: "Redirecting...",
    failed: "Sign in failed. Please try again.",
  },
  logoutAction: {
    pending: "Signing out...",
    success: "Signed out.",
    failed: "Failed to sign out. Please try again.",
  },
  sidebarFooter: {
    loggingOut: "Signing out...",
    logoutSuccess: "Signed out.",
    logoutFailed: "Failed to sign out. Please try again.",
  },
  teamEntry: {
    title: "Choose a Team",
    description: "You have access to multiple teams. Choose where to continue.",
  },
} as AppMessages;

const zhMessages = {
  appName: "InsightFlare",
  navigation: {
    overview: "总览",
    realtime: "实时",
    pages: "页面",
    referrers: "来源",
    sessions: "会话",
    events: "事件",
    funnels: "漏斗",
    campaigns: "推广",
    visitors: "访客",
    retention: "留存",
    geo: "位置",
    devices: "设备",
    browsers: "浏览器",
    performance: "性能",
    settings: "设置",
  },
  common: {
    deviceLabels: {
      desktop: "桌面端",
      mobile: "移动端",
      tablet: "平板端",
    },
    timeRelativePair: "{absolute}（{relative}）",
    id: "ID",
    views: "浏览量",
    sessions: "会话数",
    visitors: "访客数",
    bounceRate: "跳出率",
    avgDuration: "平均停留",
    path: "路径",
    title: "标题",
    hostname: "主机名",
    referrerHost: "来源主机",
    entryPage: "入口页面",
    exitPage: "出口页面",
    referrer: "来源",
    startedAt: "开始时间",
    event: "事件",
    location: "地区",
    browser: "浏览器",
    operatingSystem: "操作系统",
    deviceType: "设备类型",
    country: "国家",
    region: "地区",
    regionCode: "地区代码",
    city: "城市",
    continent: "大陆",
    latitude: "纬度",
    longitude: "经度",
    continentLabels: {
      AF: "非洲",
      AN: "南极洲",
      AS: "亚洲",
      EU: "欧洲",
      NA: "北美洲",
      OC: "大洋洲",
      SA: "南美洲",
      AFRICA: "非洲",
      ANTARCTICA: "南极洲",
      ASIA: "亚洲",
      EUROPE: "欧洲",
      "NORTH AMERICA": "北美洲",
      OCEANIA: "大洋洲",
      "SOUTH AMERICA": "南美洲",
    },
    timezone: "时区",
    organization: "运营商组织",
    screenSize: "屏幕大小",
    loading: "加载中",
    noData: "暂无数据",
    unknown: "未知",
    lastUpdated: "更新时间",
    site: "站点",
    team: "团队",
    management: "管理",
    backToTeam: "返回团队",
    system: "系统",
    account: "账户",
    theme: "主题",
    language: "语言",
    role: "角色",
    admin: "管理员",
    user: "普通用户",
    search: "搜索",
    tableExport: {
      action: "导出",
      title: "导出 CSV",
      description: "将表格数据下载为 CSV 文件。",
      scopeLabel: "导出范围",
      currentTab: "当前标签页",
      allTabs: "全部标签页",
      rowsLabel: "数据",
      currentView: "当前显示数据",
      rawRows: "原始数据",
      fileNameLabel: "文件名",
      download: "导出 CSV",
      empty: "当前没有可导出的行。",
      allTabsUnavailable: "全部标签页需要在数据加载后才可导出。",
    },
    time: "时间",
    cycle: "周期",
    close: "关闭",
    sitesFiltered: "已筛选 {active} / {total} 个站点",
    cumulativeTraffic: "全部周期累计流量",
  },
  ranges: {
    last30m: "30分钟",
    last1h: "1小时",
    today: "今天",
    yesterday: "昨天",
    thisWeek: "本周",
    thisMonth: "本月",
    thisYear: "今年",
    last24h: "最近 24 小时",
    last7d: "最近 7 天",
    last30d: "最近 30 天",
    last90d: "最近 90 天",
    last6m: "最近 6 个月",
    last12m: "最近 12 个月",
    allTime: "所有时间",
    custom: "自定义时间段",
  },
  intervals: {
    minute: "分钟",
    hour: "小时",
    day: "日",
    week: "周",
    month: "月",
  },
  dashboardHeader: {
    range: "时间范围",
    interval: "时间间隔",
    filters: "筛选",
    customRange: "选择自定义区间",
    customHint: "请选择开始和结束日期。",
    customPendingEnd: "已选择开始日期，请继续选择结束日期。",
    customApply: "确定",
    rangeGroupQuick: "快速范围",
    rangeGroupCalendar: "自然周期",
    rangeGroupRolling: "滚动窗口",
    rangeGroupAdvanced: "高级",
    intervalDisabledMinute: "仅在 1 小时内可选分钟间隔。",
    intervalDisabledHour: "仅在 7 天内可选小时间隔。",
    intervalDisabledDay: "仅在最近 90 天内可选日间隔。",
    intervalDisabledWeek: "仅在最近 12 个月内可选周间隔。",
    filterTitle: "筛选条件",
    filterSubtitle: "筛选条件会实时参与当前总览数据查询。",
    previousPeriod: "上个周期",
    nextPeriod: "下个周期",
    customSelectionSummary: "当前选择：{from} 至 {to}（共 {days} 天）",
  },
  filters: {
    country: "国家",
    device: "设备",
    browser: "浏览器",
    all: "全部",
    clear: "清除",
  },
  filterBuilder: {
    fieldGroups: {
      page: "页面",
      session: "会话",
      referrer: "来源",
      campaign: "营销活动",
      client: "客户端",
      geography: "地理位置",
      event: "事件",
    },
    fieldLabels: {
      "page.path": "页面路径",
      "page.title": "页面标题",
      "page.hostname": "页面主机名",
      "page.query": "查询字符串",
      "page.hash": "Hash 片段",
      "session.entryPath": "入口页面",
      "session.exitPath": "出口页面",
      "referrer.domain": "来源域名",
      "referrer.url": "来源 URL",
      "utm.source": "活动来源",
      "utm.medium": "活动媒介",
      "utm.campaign": "活动名称",
      "utm.term": "活动关键词",
      "utm.content": "活动内容",
      "client.browser": "浏览器",
      "client.browserVersion": "浏览器版本",
      "client.browserEngine": "浏览器引擎",
      "client.os": "操作系统",
      "client.osVersion": "操作系统版本",
      "client.deviceType": "设备类型",
      "client.language": "语言",
      "client.screenSize": "屏幕尺寸",
      "geo.country": "国家/地区",
      "geo.region": "地区",
      "geo.city": "城市",
      "geo.continent": "大洲",
      "geo.timeZone": "时区",
      "geo.organization": "组织",
      "event.name": "事件名称",
      "event.payload": "事件载荷",
    },
    operatorLabels: {
      eq: "等于",
      neq: "不等于",
      in: "属于任一值",
      notIn: "不属于任一值",
      contains: "包含",
      startsWith: "以此开头",
      endsWith: "以此结尾",
      gt: "大于",
      gte: "大于或等于",
      lt: "小于",
      lte: "小于或等于",
      between: "介于两者之间",
      exists: "存在",
      notExists: "不存在",
      isNull: "为 NULL",
      notNull: "不为 NULL",
      isEmpty: "为空字符串",
      notEmpty: "不为空字符串",
    },
    valueType: "值类型",
    valueKinds: {
      string: "文本",
      enum: "枚举",
      number: "数字",
      boolean: "布尔值",
      date: "日期",
      datetime: "日期和时间",
      "json-scalar": "JSON 标量",
    },
    booleanTrue: "是",
    booleanFalse: "否",
    valueUnset: "(未设置)",
    valueLoading: "正在加载值",
    valueSearchPlaceholder: "搜索或输入值",
    valueListPlaceholder: "搜索或输入值后按 Enter 添加",
    rangeStartPlaceholder: "下限",
    rangeEndPlaceholder: "上限",
    jsonPointer: "JSON 指针",
    match: "匹配方式",
    expression: "筛选表达式",
    expressionPlaceholder: "筛选表达式...",
    expressionInvalid: "表达式无效，点击查看语法帮助",
    expressionHelpTitle: "筛选表达式语法",
    expressionHelpDescription: "可用字段和操作符由当前筛选契约动态生成。",
    expressionHelpSyntax: "语法",
    expressionHelpLogicDescription:
      "AND 的优先级高于 OR。使用括号表达嵌套；AND(...) 和 OR(...) 可保留显式的单条件分组。",
    expressionHelpValues: "值",
    expressionHelpValuesDescription:
      "字符串使用 JSON 双引号；数字和布尔值不加引号。集合使用 [值, 值]，between 必须使用两个有序的值。",
    expressionHelpOperators: "可用操作符",
    expressionHelpUnaryOperators: "无需值的操作符",
    expressionHelpFields: "可用字段",
    expressionHelpFieldType: "类型",
    expressionHelpFieldOperators: "操作符",
    expressionHelpOtherFields: "其他",
    apply: "应用筛选",
    allConditions: "全部条件均满足",
    anyCondition: "满足任一条件",
    condition: "条件 {index}",
    group: "组 {index}",
    invertCondition: "反转此条件",
    exclude: "排除",
    addGroup: "添加分组",
    invalid: "请先完成每一条筛选条件。",
  },
  realtime: {
    title: "实时",
    subtitle: "查看最近 30 分钟的访问情况",
    logTitleSeparator: "：",
    activeNow: "当前在线",
    liveMetrics: "在线 / 30 分钟访客 / 30 分钟访问",
    connected: "已连接",
    connecting: "连接中",
    reconnecting: "重连中",
    failed: "连接失败",
    recentEvents: "实时事件",
    enterPage: "进入页面",
    leavePage: "退出页面",
    viewPage: "访问页面",
    customEvent: "事件",
    detailsTitle: "事件详情",
    detailsSection: "信息",
    visitorHistorySection: "访客记录",
    visitorHistorySubtitle: "查看该访客在当前实时窗口内的全部访问记录。",
    visitorHistoryEmpty: "当前还没有更多该访客的访问记录。",
    visitorMapSection: "访客位置",
    visitorMapSubtitle: "根据当前事件里的经纬度展示该访客的大致位置。",
    visitorMapUnavailable: "当前事件没有可用的定位坐标。",
    visitorId: "访客 ID",
    sessionId: "会话 ID",
    visitId: "访问 ID",
    eventType: "事件类型",
    eventTime: "事件时间",
  },
  overview: {
    title: "访问总览",
    subtitle: "查看核心指标与访问趋势。",
    trendTitle: "访问趋势",
    sourceTab: "来源",
    sourceDomainColumn: "来源（域名）",
    sourceLinkTab: "来源链接",
    sourceLinkColumn: "来源链接",
    direct: "直接访问",
    searchInTab: "搜索{tab}",
  },
  pages: {
    title: "页面分析",
    subtitle: "选定时间范围内访问最多的路径。",
    pagesPerSession: "每会话页面数",
    untitled: "未命名页面",
    empty: "当前筛选条件下暂无页面数据。",
    loadError: "页面数据加载失败，请稍后重试。",
    loadMoreError: "加载更多页面失败。",
    retry: "重试",
    trendTitle: "页面访问趋势",
    otherPages: "其他页面",
    hashTab: "锚点",
    noHash: "无锚点",
    queryTab: "查询参数",
    noQuery: "无查询参数",
    eventTab: "事件",
    eventsMetric: "事件数",
    viewDetails: "查看详情",
  },
  referrers: {
    title: "来源分析",
    subtitle: "流量来源渠道分布。",
    summaryTitle: "来源概览",
    splitTitle: "来源拆分",
    chartTitle: "来源结构",
    radarTitle: "前 24 来源雷达图",
    radarSubtitle: "对比头部来源在多项行为指标上的表现",
    radarDuration: "停留时长",
    radarEngagement: "互动率",
    radarDepth: "浏览深度",
    radarLoyalty: "回访率",
    radarFrequency: "访问频次",
    radarTraffic: "流量占比",
    directSourceNote: "这部分流量没有外部来源站点，属于直接访问。",
    breakdownTitle: "来源明细",
    directViews: "直接访问量",
    uniqueDomains: "来源域名数",
    uniqueLinks: "来源链接数",
    topSource: "头部外部来源",
    topSourceShare: "访问占比",
    noExternalSource: "暂无外部来源",
    externalLabel: "外部来源",
    nextSources: "后续 4 个来源",
    longTail: "长尾来源",
  },
  campaigns: {
    title: "推广活动",
    subtitle: "UTM 推广活动表现与流量归因。",
    tabSource: "来源",
    tabMedium: "媒介",
    tabCampaign: "活动",
    tabTerm: "关键词",
    tabContent: "内容",
    breakdownTitle: "UTM 明细",
    notSet: "未设置",
    noTaggedTraffic: "当前筛选范围内暂无带 UTM 标签的流量。",
  },
  sessions: {
    title: "会话列表",
    subtitle: "用于分析访问质量的会话明细。",
    search: "搜索会话...",
    started: "开始时间",
    sessionId: "会话 ID",
    visitor: "访客",
    anonymous: "匿名访客",
    entryPage: "入口页面",
    exitPage: "出口页面",
    duration: "时长",
    referrer: "来源",
    location: "地区",
    os: "系统",
    browser: "浏览器",
    device: "设备",
    pageViews: "页面浏览",
    loadError: "无法加载会话数据。",
    empty: "当前时间范围内没有会话。",
  },
  sessionDetail: {
    anonymous: "匿名访客",
    back: "返回会话",
    missing: "缺少 sessionId。",
    notFound: "没有找到这个会话。",
    loadError: "无法加载会话详情。",
    active: "进行中",
    inactive: "已结束",
    status: "状态",
    duration: "时长",
    screenViews: "页面浏览",
    events: "事件",
    bounce: "跳出",
    entryPath: "入口路径",
    exitPath: "退出路径",
    referrerName: "来源名称",
    os: "系统",
    browser: "浏览器",
    device: "设备",
    screen: "屏幕",
    yes: "是",
    no: "否",
    uniquePages: "唯一页面",
    firstEvent: "首个事件",
    lastEvent: "最后事件",
    sessionStarted: "会话开始",
    pageview: "访问页面",
    exitPage: "退出页面",
    customEvent: "自定义事件",
    eventTitleSeparator: "：",
    visitDetailsTitle: "访问明细",
    visitDetailsSubtitle:
      "按发生顺序展示该会话内的开始、页面访问、退出和自定义事件。",
    location: "位置",
    visitorId: "访客 ID",
    sessionId: "会话 ID",
    referrerUrl: "来源链接",
    emptyEvents: "没有事件记录。",
    emptyCustomEvents: "暂无自定义事件",
    sincePrevious: "距上个事件",
    geoLocationTitle: "地理位置",
    performanceTitle: "当前会话性能",
    range: "范围",
  },
  events: {
    title: "自定义事件",
    subtitle: "查看事件规模、上下文、Payload 字段与原始触发记录。",
    detailTitle: "事件详情",
    detailSubtitle: "查看单次事件的上下文与 payload。",
    typeDetailSubtitle:
      "查看该事件的趋势、上下文分布、Payload 结构与触发记录。",
    backToEvents: "返回事件总览",
    totalEvents: "事件总数",
    eventTypes: "事件类型",
    sessions: "触发会话",
    visitors: "触发访客",
    avgEventsPerSession: "平均事件/会话",
    shareOfAllEvents: "事件占比",
    triggerCount: "触发量",
    triggerVisitors: "触发人数",
    trendTitle: "事件趋势",
    topEvents: "事件排行",
    recordsTitle: "事件记录",
    fieldsTitle: "Payload 字段",
    fieldsSubtitle: "选择字段后查看其值分布和元数据。",
    fieldValuesTitle: "字段值",
    fieldValuesSubtitle: "展示当前字段的记录及出现次数，点击以进行筛选。",
    fieldValuesEmpty: "当前字段暂无记录。",
    payloadFilter: "筛选",
    payloadFilterTitle: "Payload 筛选",
    payloadFilterSubtitle: "每行一个条件，可使用 == 或 != 组合筛选。",
    payloadFilterPlaceholder: 'path.value == "a"\nlevel != 0',
    payloadFilterApply: "应用筛选",
    payloadFilterClear: "清空筛选",
    payloadFilterInvalid: "无法解析筛选条件，请检查字段路径、操作符和值。",
    expandField: "展开字段",
    collapseField: "收起字段",
    breakdownTitle: "上下文分布",
    search: "搜索事件名、ID、访客、会话、页面...",
    eventName: "事件名",
    eventId: "事件 ID",
    occurredAt: "发生时间",
    receivedAt: "接收时间",
    page: "页面",
    context: "上下文",
    visitor: "访客",
    visit: "访问",
    referrer: "来源",
    location: "地区",
    browser: "浏览器",
    os: "系统",
    device: "设备",
    payload: "Payload",
    payloadFields: "Payload 字段",
    values: "值",
    nodes: "节点",
    occurrences: "出现次数",
    openVisitor: "打开访客",
    openSession: "打开会话",
    copyJson: "复制 JSON",
    copiedJson: "JSON 已复制。",
    copyJsonFailed: "无法复制 JSON。",
    copyValue: "复制值",
    copiedValue: "值已复制。",
    copyValueFailed: "复制值失败。",
    loadError: "无法加载事件数据。",
    empty: "当前筛选范围内没有自定义事件。",
    emptyFields: "当前事件暂无 payload 字段。",
    noEventName: "缺少事件名。",
    loading: "加载中",
    other: "其他",
  },
  funnels: {
    title: "漏斗分析",
    subtitle: "衡量多步骤用户旅程的转化情况。",
    listTitle: "漏斗定义",
    listSubtitle: "构建可复用的步骤序列，并按当前看板时间窗查看转化。",
    create: "新建漏斗",
    createTitle: "创建漏斗",
    createDescription: "至少定义两个有顺序的页面浏览或自定义事件步骤。",
    nameLabel: "名称",
    namePlaceholder: "注册激活",
    stepsLabel: "步骤",
    addStep: "添加步骤",
    removeStep: "移除步骤",
    stepTypePageview: "页面浏览",
    stepTypeEvent: "事件",
    stepValueLabel: "值",
    pageviewPlaceholder: "/pricing",
    eventPlaceholder: "signup_started",
    save: "创建",
    creating: "创建中...",
    cancel: "取消",
    delete: "删除",
    deleteTitle: "删除漏斗",
    deleteDescription: "这会移除已保存的漏斗定义，不会删除历史分析数据。",
    deleteConfirm: "删除漏斗",
    deleting: "删除中...",
    empty: "暂无漏斗。",
    emptyHint: "使用页面浏览和自定义事件创建漏斗来跟踪转化。",
    loadError: "无法加载漏斗。",
    detailLoadError: "无法加载漏斗分析。",
    invalidFunnel: "请填写名称，并至少补全两个步骤。",
    created: "漏斗已创建。",
    createFailed: "创建漏斗失败。",
    deleted: "漏斗已删除。",
    deleteFailed: "删除漏斗失败。",
    overallConversion: "总转化率",
    startedSessions: "起始会话",
    convertedSessions: "转化会话",
    convertedVisitors: "转化访客",
    largestDropOff: "最大流失",
    noDropOff: "无流失",
    step: "步骤",
    sessions: "会话",
    visitors: "访客",
    conversion: "转化率",
    stepConversion: "步骤转化",
    dropOff: "流失",
    updated: "更新于",
  },
  visitors: {
    title: "访客分析",
    subtitle: "访客级别明细与最近活跃情况。",
    search: "搜索访客...",
    visitor: "访客",
    sessionId: "会话 ID",
    anonymous: "匿名访客",
    referrer: "来源",
    location: "地区",
    os: "系统",
    browser: "浏览器",
    device: "设备",
    firstSeen: "首次出现",
    lastSeen: "上次出现",
    pageViews: "页面浏览",
    sessions: "会话数",
    loadError: "无法加载访客数据。",
    empty: "当前时间范围内没有访客。",
  },
  visitorDetail: {
    anonymous: "匿名访客",
    back: "返回访客",
    missing: "缺少 visitorId。",
    notFound: "没有找到这个访客。",
    loadError: "无法加载访客详情。",
    totalDuration: "总时长",
    events: "事件",
    views: "页面浏览",
    uniquePages: "唯一页面",
    avgPagesPerSession: "平均页面/会话",
    avgEventsPerSession: "平均事件/会话",
    avgStay: "平均停留",
    firstSeen: "首次出现",
    lastSeen: "最近出现",
    daysActive: "活跃天数",
    avgTimeBetweenSessions: "平均会话间隔",
    activity: "活跃记录",
    sessionRecords: "会话记录",
    started: "开始时间",
    visitor: "访客",
    duration: "时长",
    referrer: "来源",
    pageViews: "页面浏览",
    visitDetailsTitle: "访问明细",
    visitDetailsSubtitle:
      "按发生顺序展示该访客的会话开始、页面访问、退出和自定义事件。",
    customEvents: "自定义事件",
    emptyEvents: "没有事件记录。",
    emptyCustomEvents: "暂无自定义事件",
    emptySessions: "没有会话记录。",
    visitorId: "访客 ID",
    sessionId: "会话 ID",
    referrerName: "来源名称",
    referrerUrl: "来源链接",
    location: "位置",
    browser: "浏览器",
    os: "系统",
    device: "设备",
    screen: "屏幕",
    entryPath: "入口路径",
    exitPath: "退出路径",
    sessionStarted: "会话开始",
    pageview: "访问页面",
    exitPage: "退出页面",
    customEvent: "自定义事件",
    eventTitleSeparator: "：",
    sincePrevious: "距上个事件",
    geoLocationTitle: "地理位置",
    performanceTitle: "当前访客性能",
    range: "范围",
  },
  retention: {
    title: "留存分析",
    subtitle: "基于群组的访客回访分析。",
    cohortDate: "群组",
    cohortSize: "人数",
    periodLabel: "第 {n} 期",
    matrixTitle: "留存矩阵",
    matrixSubtitle:
      "每一行是首次进入该周期的访客群组，每一列是后续周期的回访比例。",
    cohortsMetric: "群组数",
    visitorsMetric: "群组访客",
    periodOneMetric: "首期回访",
    averageReturnMetric: "平均回访",
    strongestCohortMetric: "最佳群组",
    eligibleVisitors: "符合统计的访客",
    periodsAnalyzed: "已分析周期",
    noEligibleCohorts: "暂无足够历史",
    weightedAverage: "加权平均",
    legendLow: "低",
    legendHigh: "高",
    periodZero: "初始",
    empty: "当前时间范围内没有足够的回访数据。",
    emptyHint:
      "扩大时间范围，或在顶部选择更粗的时间间隔，可以更快看到留存形态。",
    loadError: "无法加载留存数据。",
    unavailableCell: "该群组还没有进入这个周期。",
    visitorsDetail: "访客",
    rateDetail: "留存率",
    cohortDetail: "群组",
    sizeDetail: "人数",
  },
  geo: {
    title: "位置分析",
    subtitle: "研究任意地点的访问效果",
    mapTitle: "请求地理分布",
    countryLabel: "国家/地区",
    regionLabel: "州/省",
    cityLabel: "市/县",
    back: "返回上一级",
    viewOnWikipedia: "查看维基百科",
    investigationNotice: "这些数据来源于网络，可能存在错误。",
    timezoneDeltaVsLocal: "较本地 {delta}",
    visitorCoordinates: "访客坐标",
    ipNotice: "估算的 IP 位置，坐标为粗略范围，不代表精确家庭或办公地址。",
    multipleNotice: "多个估算的 IP 位置，跨会话旅程可能涉及多个城市。",
    investigation: {
      countryScopedLabel: "国家{label}",
      capital: "首都",
      population: "人口",
      gdp: "GDP",
      gdpPerCapita: "人均 GDP",
      marketPenetration: "市场渗透率",
      region: "所属区域",
      currency: "货币",
      phonecode: "电话区号",
      timezone: "时区",
      type: "类型",
      iso: "ISO",
      coordinates: "坐标",
      unavailable: "暂无",
      gdpValue: "{value} 百万美元",
      gdpPerCapitaValue: "{value} 美元/人",
      gdpPerCapitaNearAverage: "{value} 美元/人（接近全球平均）",
      gdpPerCapitaAboveAverage: "{value} 美元/人（高于平均 {percent}%）",
      gdpPerCapitaBelowAverage: "{value} 美元/人（低于平均 {percent}%）",
      marketPenetrationWindow: "{label}({days}天)",
      timezoneCount: "{count} 个时区",
      typeLabels: {
        country: "国家",
        state: "州",
        province: "省",
        prefecture: "地级市",
        city: "市",
        county: "县",
        district: "区",
        town: "镇",
        village: "村",
        municipality: "市镇",
        territory: "地区",
        section: "片区",
        adm1: "一级行政区",
        adm2: "二级行政区",
        adm3: "三级行政区",
        adm4: "四级行政区",
        adm5: "五级行政区",
      },
    },
  },
  devices: {
    title: "设备分析",
    subtitle: "从设备类型、系统和屏幕尺寸观察访客结构。",
    deviceShareTitle: "设备类型占比",
    osShareTitle: "操作系统占比",
    deviceTrendTitle: "设备类型趋势",
    osTrendTitle: "操作系统趋势",
    screenDistributionTitle: "屏幕尺寸分布",
    screenDistributionSubtitle: "识别最常见的视口尺寸和响应式断点。",
    screenBucketTitle: "断点分桶",
    screenPreviewTitle: "屏幕预览",
    selectedViewportLabel: "当前视口",
    openSiteLabel: "打开站点",
    previewUnavailableLabel: "当前没有可预览的屏幕尺寸。",
    browserByDeviceTitle: "设备类型 × 浏览器",
    osByDeviceTitle: "设备类型 × 操作系统",
    otherLabel: "其他",
    screenBucketLabels: {
      phoneCompact: "小屏手机",
      phone: "手机",
      tablet: "平板",
      laptop: "笔记本",
      desktopWide: "宽屏桌面",
      unclassified: "未归类",
    },
  },
  browsers: {
    title: "浏览器分析",
    subtitle: "按浏览器查看访问分布。",
    trendTitle: "浏览器占比趋势",
    engineTrendTitle: "内核占比趋势",
    versionBreakdownTitle: "浏览器版本分布",
    osBreakdownTitle: "浏览器 × 系统",
    deviceTypeBreakdownTitle: "浏览器 × 设备类型",
    otherLabel: "其他",
    browserShareTitle: "浏览器占比",
    engineShareTitle: "内核占比",
    caniuseTitle: "特性兼容性",
    caniuseSubtitle: "根据站点访客数据检查 Web 特性的浏览器支持情况。",
    caniuseSearchPlaceholder: "搜索 Web 特性…",
    caniuseHotFeatures: "热门特性",
    caniuseTrendingFeatures: "近期变动",
    caniuseSiteSupport: "本站支持率",
    caniuseGlobalSupport: "全球支持率",
    caniuseClearSelection: "清除",
    caniuseNoMatch: "未找到匹配的特性。",
    caniuseFullSupport: "完全支持",
    caniusePartialSupport: "部分支持",
    caniuseNoSupport: "不支持",
    radarTitle: "浏览器行为雷达图",
    radarSubtitle: "对比主流浏览器在多项行为指标上的表现",
    radarDuration: "停留时长",
    radarEngagement: "互动率",
    radarDepth: "浏览深度",
    radarLoyalty: "回访率",
    radarFrequency: "访问频次",
    radarTraffic: "流量占比",
  },
  performance: {
    title: "性能追踪",
    subtitle: "按指标、趋势与路径查看真实访客性能。",
    chartTitle: "性能趋势",
    avgLabel: "平均值",
    samplesLabel: "样本数",
    p50Label: "P50",
    p75Label: "P75",
    p95Label: "P95",
    ttfb: "首字节时间",
    fcp: "首次内容绘制",
    lcp: "最大内容绘制",
    cls: "累积布局偏移",
    inp: "下次绘制交互",
    ttfbDescription:
      "衡量浏览器在收到服务器第一个字节前等待了多久，反映后端响应、网络延迟和缓存效果。",
    fcpDescription:
      "衡量页面首次绘制文本或图片的时间，反映访客多久能看到页面开始加载。",
    lcpDescription:
      "衡量视口内最大内容元素完成渲染的时间，是感知加载速度的核心指标。",
    clsDescription:
      "衡量页面生命周期中非预期布局位移的程度，数值越低表示视觉越稳定。",
    inpDescription:
      "衡量用户交互到下一次绘制之间的延迟，反映页面加载后的响应能力。",
    msUnit: "毫秒",
    secondsUnit: "秒",
    clsUnit: "分值",
    score: "体验评分",
    scoreDescription:
      "将加载、稳定性和交互指标的 P75 数值合成为 0 到 100 的体验评分，分数越高越好。",
    great: "优秀",
    needsImprovement: "需要改进",
    poor: "较差",
    datasetTitle: "数据集概览",
    interpretationTitle: "当前解读",
    currentReading:
      "{metric} 当前 P75 为 {value}，体验评分为 {score}，覆盖 {samples} 个样本。当前判定：{status}。",
    metricThresholdText:
      "优秀为不高于 {good}；需要改进为 {good} 到 {poor}；较差为高于 {poor}。",
    scoreThresholdText: "优秀为高于 90，需要改进为 50 到 90，较差为低于 50。",
    countryHealthTitle: "国家和地区健康度",
    countryHealthSubtitle: "根据 {metric} 对国家或地区边界进行健康度着色。",
    pathsTitle: "路径性能",
    pathsAnalyzedLabel: "已分析路径",
    metricValueColumn: "P75 数值",
    statusColumn: "状态",
  },
  share: {},
  siteSettings: {
    title: "站点设置",
    subtitle: "管理当前站点的基础信息与生命周期。",
    editTitle: "修改站点信息",
    editSubtitle: "更新站点名称和域名。",
    nameLabel: "站点名称",
    domainLabel: "域名",
    publicSharingTitle: "公开分享",
    publicSharingSubtitle:
      "配置站点的公开访问链接，启用后任何人可通过链接查看分析数据。",
    publicEnabledLabel: "启用公开访问",
    publicSlugLabel: "公开 Slug",
    publicSlugPlaceholder: "例如 my-site",
    publicSlugHint: "自定义 URL 路径标识。留空将自动生成。",
    publicLinkLabel: "公开链接",
    publicLinkHint: "启用公开访问后，可通过此链接分享分析数据。",
    publicDisabledHint: "启用公开访问后将显示分享链接。",
    copiedLink: "链接已复制",
    trackingStrengthGroupTitle: "跟踪强度",
    trackingStrengthDescription: "选择脚本对访客标识与统计精度的处理方式。",
    trackingStrengthLabel: "跟踪强度策略",
    trackingStrengthStrong: "强",
    trackingStrengthSmart: "智能",
    trackingStrengthWeak: "弱",
    trackingStrengthStrongDescription:
      "始终进行针对访客的高精度追踪。这可能违反某些国家的法规，例如 GDPR。",
    trackingStrengthSmartDescription: "自动根据访客所处国家切换追踪强度。",
    trackingStrengthWeakDescription:
      "始终降低对访客的追踪精度。这可能导致同一访客在不同时间访问时被计数多次、且无法计算留存率。",
    queryHashGroupTitle: "查询参数与 Hash 跟踪",
    queryHashGroupDescription:
      "控制 URL 查询参数、Hash 与 Do Not Track 的处理方式。",
    trackQueryParamsLabel: "开启查询参数跟踪",
    trackHashLabel: "开启 Hash 跟踪",
    domainWhitelistTitle: "域名白名单",
    domainWhitelistDescription: "仅当当前域名命中白名单时才会上报事件。",
    domainWhitelistLabel: "域名白名单（每行一个）",
    domainWhitelistPlaceholder: "example.com\nwww.example.com\n",
    domainWhitelistHint: "留空表示不限制域名；仅支持精确匹配，不匹配子域名。",
    pathBlacklistTitle: "路径黑名单",
    pathBlacklistDescription: "当前路径命中前缀规则时将阻止事件上报。",
    pathBlacklistLabel: "路径黑名单（每行一个）",
    pathBlacklistPlaceholder: "/admin\n/private\n",
    pathBlacklistHint: "采用 startsWith 前缀匹配；命中后不发送采集事件。",
    ignoreDoNotTrackLabel: "忽略浏览器 Do Not Track",
    autoTrackGroupTitle: "自动追踪",
    autoTrackGroupDescription: "控制自动事件捕获行为。",
    autoTrackOutboundLinksLabel: "自动追踪外链点击",
    autoTrackOutboundLinksHint:
      "开启后，点击指向外部域名的链接将自动上报 outbound_click 事件。",
    performanceGroupTitle: "性能追踪",
    performanceGroupDescription: "通过一个采样率控制 Web 性能指标采集。",
    performanceSampleRateLabel: "性能采样率（%）",
    performanceSampleRateHint:
      "被采样的访问会在离开页面时记录 TTFB、FCP、LCP、CLS 和 INP。填 0 表示不采样，100 表示全量采集。",
    booleanOn: "开启",
    booleanOff: "关闭",
    loadingSettings: "正在加载脚本设置...",
    saveTracking: "保存追踪设置",
    savingTracking: "保存追踪设置中...",
    save: "保存修改",
    saving: "保存中...",
    transferTitle: "转移到其他团队",
    transferSubtitle: "将当前站点迁移到你可管理的其他团队。",
    transferTeamLabel: "目标团队",
    transfer: "转移站点",
    transferring: "转移中...",
    scriptTitle: "安装统计脚本",
    scriptSubtitle: "将此脚本添加到你的网站后即可开始采集分析数据。",
    scriptHint:
      "推荐放在 </head> 结束标签前；若不方便，也可放在 </body> 前，但请确保每页只加载一次。",
    copyScript: "复制脚本",
    copiedScript: "脚本已复制。",
    loadingScript: "正在加载脚本...",
    scriptUnavailable: "当前无法获取脚本。",
    deleteTitle: "删除站点",
    deleteSubtitle: "此操作会将当前站点从团队中移除。",
    delete: "删除站点",
    deleting: "删除中...",
    deleteConfirm: "该操作不可撤销，是否继续？",
    toasts: {
      saved: "站点设置已保存。",
      saveFailed: "站点设置保存失败。",
      transferred: "站点已转移。",
      transferFailed: "站点转移失败。",
      scriptLoadFailed: "加载脚本片段失败。",
      settingsLoadFailed: "加载脚本设置失败。",
      settingsPropagationHint: "设置分发到全球节点可能需要最多 1 小时。",
      deleted: "站点已删除。",
      deleteFailed: "删除站点失败。",
      invalidInput: "请填写有效的站点名称和域名。",
    },
  },
  accountSettings: {
    title: "账户设置",
    subtitle: "管理你的个人信息、登录密码和仪表盘时区。",
    profileTitle: "个人信息",
    profileDescription: "更新昵称、用户名和邮箱。",
    nicknameLabel: "昵称",
    nicknamePlaceholder: "例如：产品分析师",
    usernameLabel: "用户名",
    usernamePlaceholder: "例如：alex",
    usernameDescription: "用户名也可用于登录。",
    emailLabel: "邮箱",
    emailPlaceholder: "name@example.com",
    invalidProfile: "请填写有效的用户名和邮箱。",
    profileSave: "保存个人信息",
    profileSaving: "保存中...",
    profileSaved: "个人信息已保存。",
    profileSaveFailed: "保存个人信息失败。",
    passwordTitle: "登录密码",
    passwordDescription: "修改当前账号的登录密码。",
    currentPasswordLabel: "当前密码",
    newPasswordLabel: "新密码",
    confirmPasswordLabel: "确认新密码",
    currentPasswordRequired: "请输入当前密码。",
    passwordTooShort: "新密码至少需要 8 个字符。",
    passwordMismatch: "两次输入的新密码不一致。",
    passwordSave: "修改密码",
    passwordSaving: "修改中...",
    passwordSaved: "密码已修改。",
    passwordSaveFailed: "修改密码失败。",
    preferredLanguageTitle: "通知语言",
    preferredLanguageDescription: "选择定时通知邮件使用的语言。",
    preferredLanguageLabel: "邮件语言",
    preferredLanguageDefault: "默认",
    preferredLanguageEnglish: "English",
    preferredLanguageChinese: "中文",
    preferredLanguageJapanese: "日本語",
    preferredLanguageSaved: "通知语言已保存。",
    preferredLanguageSaveFailed: "保存通知语言失败。",
    timeZoneTitle: "报表时区",
    timeZoneDescription: "仪表盘里的自然日期范围和聚合分桶都会使用这个时区。",
    activeTimeZone: "当前生效时区",
    browserTimeZone: "浏览器时区",
    browserUnavailable: "未检测到",
    browserSource: "跟随浏览器",
    manualSource: "手动设置",
    preferenceLabel: "时区偏好",
    preferenceDescription:
      "跟随浏览器会使用当前设备时区；手动设置会在所有设备上保持同一时区。",
    useBrowser: "跟随浏览器时区",
    useCustom: "选择时区",
    customTimeZoneLabel: "时区",
    customTimeZoneDescription: "从支持的 IANA 时区中选择。",
    invalidTimeZone: "请选择有效的 IANA 时区。",
    save: "保存偏好",
    saving: "保存中...",
    saved: "时区偏好已保存。",
    saveFailed: "保存时区偏好失败。",
  },
  notificationCenter: {
    title: "通知中心",
    subtitle: "查看你的全部通知和报告。",
    empty: "暂无通知。",
    loading: "正在加载通知",
    markRead: "标记已读",
    markAllRead: "全部标记已读",
    refresh: "刷新",
    attention: "重点",
    loadFailed: "加载通知失败。",
    markReadFailed: "标记通知已读失败。",
    markAllReadSuccess: "通知已全部标记为已读。",
    markAllReadFailed: "全部标记已读失败。",
    ruleFilterActive: "正在查看此规则产生的通知。",
    ruleFilterClear: "清除筛选",
    sections: {
      importantTitle: "重要通知",
      importantDescription: "{count} 条未读重点通知。",
      importantEmpty: "当前没有重要通知。",
      reportsTitle: "报告",
      reportsDescription: "查看通知规则生成的定期报告。",
      reportsEmpty: "当前没有报告。",
    },
    tabs: {
      all: "全部",
      unread: "未读",
      attention: "重点",
      report: "报告",
    },
    tabDescriptions: {
      all: "全部消息",
      unread: "等待查看",
      attention: "需要关注",
      report: "定期报告",
    },
    messageTypes: {
      report: "报告",
      milestone: "里程碑",
      threshold: "阈值",
      change: "变化",
      health: "健康",
      system: "系统",
      test: "测试",
    },
    severities: {
      info: "信息",
      success: "成功",
      warning: "警告",
      critical: "严重",
    },
    deliveryStatuses: {
      created: "已创建",
      sending: "发送中",
      sent: "已发送",
      partial: "部分完成",
      failed: "失败",
      skipped: "已跳过",
    },
    channels: {
      inApp: "站内",
      email: "邮件",
    },
    channelStatuses: {
      sent: "已发送",
      skipped: "已跳过",
      failed: "失败",
      created: "已创建",
    },
    emailSkipReasons: {
      user_preference_disabled: "用户已关闭邮件通知",
      system_email_unconfigured: "系统邮件尚未配置",
      recipient_email_invalid: "收件人邮箱无效",
      secret_decryption_failed: "保存的邮件凭据无法解密",
      provider_failed: "邮件服务商拒绝发送",
      network_failed: "无法连接邮件服务商",
      unknown: "未知原因",
    },
    emailAttempts: "尝试次数：{count}",
    emailRetryCount: "重试次数：{count}",
    emailDuration: "{duration} 毫秒",
    typeFilterLabel: "类型",
    severityFilterLabel: "严重程度",
    allTypes: "全部类型",
    allSeverities: "全部严重程度",
    preferencesTitle: "通知偏好",
    preferencesDescription:
      "这些设置控制邮件投递，以及哪些消息会保持未读以提醒关注。",
    emailNotificationsLabel: "邮件通知",
    emailNotificationsDescription: "规则触发时发送邮件。",
    reportsUnreadLabel: "报告保持未读",
    reportsUnreadDescription: "报告创建后保持未读状态。",
    milestonesUnreadLabel: "里程碑保持未读",
    milestonesUnreadDescription: "将未读状态保留给里程碑消息。",
    alertsUnreadLabel: "告警保持未读",
    alertsUnreadDescription: "阈值和健康告警保持未读。",
    preferencesSaved: "通知偏好已保存。",
    preferencesSaveFailed: "保存通知偏好失败。",
    detailFields: {},
  },
  notificationEmail: {
    common: {
      brand: "InsightFlare",
      date: "日期",
      coreMetrics: "核心指标",
      topPages: "热门页面",
      topReferrers: "主要来源",
      views: "浏览量",
      visitors: "访客数",
      sessions: "会话数",
      visits: "次访问",
      viewsUnit: "次浏览",
      direct: "直接访问",
      metric: "指标",
      window: "时间窗口",
      currentValue: "当前值",
      previousValue: "上一值",
      threshold: "阈值",
      milestone: "里程碑",
      change: "变化",
      mode: "模式",
      lastSeen: "最后收到数据",
      never: "从未收到",
      noPageData: "暂无页面数据。",
      noReferrerData: "暂无来源数据。",
      footer: "这封邮件由 InsightFlare 通知系统发送。",
      fallbackSubject: "InsightFlare 通知",
      trackingHint: "请检查统计脚本是否正常安装，或确认站点是否仍有流量。",
      severity: {
        info: "信息",
        success: "成功",
        warning: "警告",
        critical: "严重",
      },
    },
    test: {
      subject: "InsightFlare 通知测试",
      title: "InsightFlare 通知测试",
      summary: "这是一条来自 InsightFlare 的测试通知。",
      body: "这是一条来自 InsightFlare 的测试通知。如果邮件已配置并启用，它也会验证 Resend 投递是否正常。",
    },
    report: {
      subject: "{site} {periodLabel}访问报告",
      title: "{site} {periodLabel}访问报告",
      summary: "{date}：{visitors} 位访客，{views} 次浏览。",
      periodLabels: {
        daily: "每日",
        weekly: "每周",
        monthly: "每月",
        quarterly: "每季度",
        yearly: "每年",
      },
    },
    milestone: {
      subject: "{site} 达到 {bucket} {metric}",
      title: "{site} 达到 {bucket} {metric}",
      summary: "已达到流量里程碑：{bucket} {metric}。",
    },
    threshold: {
      subject: "{site} 访问量达到阈值",
      title: "{site} 访问量达到阈值",
      summary: "{window}的{metric}为 {value}，已匹配阈值 {operator} {target}。",
      metricLabels: {
        views: "浏览量",
        visitors: "访客数",
        sessions: "会话数",
      },
      windows: {
        last_1h: "过去 1 小时",
        last_24h: "过去 24 小时",
        yesterday: "昨天",
      },
    },
    health: {
      subject: "{site} 已超过 {hours} 小时没有收到访问数据",
      title: "{site} 已超过 {hours} 小时没有收到访问数据",
      noHistory: "当前没有历史访问数据。请检查统计脚本是否已正确安装。",
    },
    change: {
      subject: "{site} 流量变化提醒",
      title: "{site} 流量变化提醒",
      summary: "{window}的{metric}变化了 {change}。",
    },
  },
  runtimeConfigError: {
    title: "需要运行时配置",
    eyebrow: "部署已暂停",
    heading: "InsightFlare 需要一个运行时密钥后才能加载控制台。",
    description:
      "应用已经启动，但当前运行环境没有读取到必需的 root secret，因此暂时阻止进入控制台。",
    requiredTitle: "必需的运行时密钥",
    requiredDescription: "请在 Cloudflare 运行时密钥中至少设置以下其中一个值。",
    secretHint: "推荐使用 MAIN_SECRET。旧部署仍可继续使用 DAILY_SALT_SECRET。",
    commandTitle: "Cloudflare 命令",
    commandDescription: "使用项目内置命令写入推荐密钥，然后重新部署。",
    quickStartHint:
      "或者，请查看 GitHub README 的“快速开始”章节来设置这个变量。",
    docsLabel: "打开 GitHub",
    homeLabel: "重试控制台",
  },
  login: {
    title: "登录",
    subtitle: "使用 InsightFlare 账号登录。",
    username: "用户名或邮箱",
    password: "密码",
    signIn: "登录",
    invalidCredentials: "用户名或密码错误。",
  },
  accountLinks: {
    invite: {
      title: "团队邀请",
      subtitle: "接受邀请后加入该团队。",
      loading: "正在加载邀请...",
      missingToken: "缺少邀请 token。",
      loadFailed: "加载邀请失败。",
      accept: "接受邀请",
      accepting: "正在接受...",
      accepted: "已接受邀请。",
      acceptFailed: "接受邀请失败。",
      signIn: "登录后接受",
      signedInNotice: "当前已登录。接受后会将当前账号加入该团队。",
      teamLabel: "团队",
      roleLabel: "角色",
      emailLabel: "邀请邮箱",
      accountEmailLabel: "账号邮箱",
      anyEmail: "任意账号",
      expiresLabel: "过期时间",
      usernameLabel: "用户名",
      nameLabel: "显示名称",
      passwordLabel: "密码",
      roles: {
        admin: "管理员",
        member: "成员",
      },
    },
    resetPassword: {
      title: "重置密码",
      subtitle: "为该账号设置新密码。",
      loading: "正在加载重置链接...",
      missingToken: "缺少重置 token。",
      loadFailed: "加载重置链接失败。",
      reset: "重置密码",
      resetting: "正在重置...",
      resetDone: "密码已重置，请使用新密码登录。",
      resetFailed: "重置密码失败。",
      signIn: "返回登录",
      accountLabel: "账号",
      emailLabel: "邮箱",
      expiresLabel: "过期时间",
      passwordLabel: "新密码",
      confirmPasswordLabel: "确认密码",
      passwordTooShort: "密码至少 8 个字符。",
      passwordMismatch: "两次输入的密码不一致。",
    },
  },
  empty: {
    noTeams: "当前账号还没有可访问的团队。",
    noSites: "该团队下暂无可访问站点。",
    siteNotFound: "未找到对应团队或站点。",
  },
  actions: {
    logout: "退出登录",
    switchToEnglish: "English",
    switchToChinese: "中文",
    switchToJapanese: "日本語",
    switchToLight: "浅色",
    switchToDark: "深色",
  },
  teamSelect: {
    groupLabel: "团队",
    groups: {
      created: "创建的团队",
      managed: "管理的团队",
      member: "所属的团队",
      system: "系统全部团队",
    },
    createHint: "新建团队",
    createTitle: "新建团队",
    createDescription: "创建后会自动切换到新团队。",
    nameLabel: "团队名称",
    namePlaceholder: "例如：增长团队",
    slugLabel: "团队 Slug（可选）",
    slugPlaceholder: "例如：growth-team",
    create: "创建",
    creating: "创建中...",
    cancel: "取消",
    invalidName: "团队名称至少 2 个字符。",
    createFailed: "创建失败，请稍后重试。",
    createSuccess: "团队已创建。",
  },
  teamManagement: {
    stats: {
      sites: "站点",
      members: "成员",
    },
    toasts: {
      teamSaved: "团队设置已保存。",
      teamSaveFailed: "团队设置保存失败。",
      teamDeleted: "团队已删除。",
      teamDeleteFailed: "删除团队失败。",
      memberRemoved: "成员已移除。",
      memberRemoveFailed: "移除成员失败。",
      roleChanged: "成员角色已更新。",
      roleChangeFailed: "更新成员角色失败。",
      siteAccessChanged: "成员站点权限已更新。",
      siteAccessChangeFailed: "更新站点权限失败。",
      invalidTeamName: "团队名称至少 2 个字符。",
      inviteCreated: "邀请链接已创建。",
      inviteCreateFailed: "创建邀请链接失败。",
      inviteRevoked: "邀请已撤销。",
      inviteRevokeFailed: "撤销邀请失败。",
      inviteCopied: "邀请链接已复制。",
      inviteCopyFailed: "复制邀请链接失败。",
      invalidInviteEmail: "请输入有效的邀请邮箱。",
      invalidInviteExpiry: "邀请有效期至少为 1 小时。",
      ownerTransferred: "所有权已转移。",
      ownerTransferFailed: "转移所有权失败。",
      invalidTransferTarget: "请选择新的所有者。",
    },
    sites: {
      title: "仪表盘",
      subtitle: "聚合查看该团队下所有站点的访问表现。",
      aggregateTitle: "总访问量",
      pagesPerSession: "每会话页面数",
      noSites: "当前团队还没有站点。",
      openAnalytics: "查看分析",
    },
    widgets: {
      title: "小组件",
      subtitle: "小组件功能正在开发中。",
      underConstruction: "正在施工中",
    },
    notifications: {
      title: "事件通知",
      subtitle: "管理当前团队的事件通知规则。",
      empty: "当前团队还没有事件通知规则。",
      forbiddenTitle: "通知规则由团队管理员管理",
      forbiddenDescription:
        "你仍然可以查看自己的通知消息，并修改个人通知偏好。",
      rulesTitle: "通知规则",
      enabledCount: "当前团队已启用 {count} 条规则。",
      loadingRules: "正在加载通知规则",
      deliveryTestTitle: "投递测试",
      deliveryTestDescription:
        "为你创建一条站内通知；如果可用，也会尝试发送邮件。",
      inAppTestHint: "我们会向你发送一条站内通知。",
      emailTestConfiguredHint: "我们会向你发送一条测试邮件。",
      emailTestUnconfiguredHint:
        "当前系统未设置邮件发送服务，请联系管理员添加。",
      sendTestNotification: "发送测试通知",
      loadRulesFailed: "加载通知规则失败。",
      testNotificationSent: "测试通知已发送。",
      sendTestNotificationFailed: "发送测试通知失败。",
      createRule: "创建规则",
      editRule: "编辑规则",
      dialogDescription: "为当前团队配置一条基础通知规则。",
      ruleInfoSection: "规则信息",
      scheduleSection: "计划",
      sendScheduleSection: "发送时间",
      checkSection: "检查频率",
      conditionSection: "条件",
      deliverySection: "投递",
      summarySection: "摘要",
      liveSummaryDescription: "实时确认这条规则会如何运行。",
      nameLabel: "名称",
      siteLabel: "站点",
      chooseSite: "选择站点",
      ruleTypeLabel: "规则类型",
      recipientLabel: "接收人",
      enabledLabel: "启用",
      enabledHint: "运行这条规则",
      scheduleLabel: "计划",
      timeLabel: "时间",
      timezoneLabel: "时区",
      intervalLabel: "间隔",
      dayLabel: "星期",
      dayOfMonthLabel: "日期",
      monthLabel: "月份",
      reportPeriodLabel: "报告周期",
      milestoneEveryLabel: "每个里程碑",
      matchLabel: "匹配",
      matchAll: "全部",
      matchAny: "任一",
      changeValueLabel: "变化值",
      changeModeLabel: "变化方式",
      changeModePercent: "百分比",
      changeModeAbsolute: "绝对值",
      addCondition: "添加条件",
      removeCondition: "移除",
      conditionItemTitle: "条件 {index}",
      metricLabel: "指标",
      windowLabel: "时间窗口",
      operatorLabel: "操作符",
      valueLabel: "阈值",
      cooldownLabel: "冷却时间",
      cooldownDescription: "在这段时间内，不会重复发送报告。",
      noDataHoursLabel: "无数据小时数",
      pleaseChooseSite: "请选择一个站点。",
      pleaseChooseRecipients: "请至少选择一个接收人。",
      ruleCreated: "规则已创建。",
      ruleUpdated: "规则已更新。",
      createRuleFailed: "创建规则失败。",
      updateRuleFailed: "更新规则失败。",
      deleteConfirm: "确认删除「{name}」？",
      ruleDeleted: "规则已删除。",
      deleteRuleFailed: "删除规则失败。",
      lastChecked: "上次检查",
      actions: "操作",
      edit: "编辑",
      enable: "启用",
      disable: "停用",
      delete: "删除",
      saveRule: "保存规则",
      emailPreview: "邮件预览",
      preview: "预览",
      runNow: "立即运行",
      previewFailed: "预览规则失败。",
      runFailed: "运行规则失败。",
      runResultToast:
        "已创建 {messages} 条消息。邮件发送 {sent} 条，失败 {failed} 条。",
      previewDialogTitle: "规则预览",
      previewDialogDescription: "仅评估规则，不创建消息，也不发送邮件。",
      coolingDownUntil: "冷却至 {time}",
      scheduleDaily: "每天 {time}",
      scheduleWeekly: "每周{day} {time}",
      scheduleMonthly: "每月 {day} 日 {time}",
      scheduleQuarterly: "每季度 {day} 日 {time}",
      scheduleYearly: "每年 {month}/{day} {time}",
      scheduleInterval: "每 {minutes} 分钟",
      scheduleCustom: "自定义",
      conditionReport: "{period}报告",
      conditionMilestone: "{metric} 每 {step} 触发",
      conditionThreshold: "{window} {metric} {operator} {value}",
      conditionChange: "{window} {metric} 变化 {operator} {value}",
      conditionHealth: "{hours} 小时无数据",
      summaryWhenConditions: "当满足下列{combinator}条件时，发送{type}通知：",
      summaryWhenSingleCondition: "当满足此条件时，发送{type}通知：",
      summaryConditionThreshold: "{window}{metric}{operator}{value}",
      summaryConditionChange: "{window}{metric}{mode}变化{operator}{value}",
      summaryReportSchedule: "{period}：{schedule}",
      summaryMilestoneCondition: "{metric} 每达到 {step} 触发",
      summaryHealthCondition: "{hours} 小时无数据",
      defaultNames: {
        report: "{site} 每日报告",
        milestone: "{site} 流量里程碑",
        threshold: "{site} 访问阈值",
        change: "{site} 流量变化",
        health: "{site} 健康检查",
      },
      columns: {
        name: "名称",
        type: "类型",
        site: "站点",
        recipient: "接收人",
        schedule: "计划",
        condition: "条件",
        nextRun: "下次运行",
        status: "状态",
      },
      status: {
        enabled: "已启用",
        disabled: "未启用",
      },
      nextRunStates: {
        disabled: "未启用",
        coolingDown: "冷却中",
        dueNow: "现在到期",
      },
      previewFields: {
        status: "状态",
        summary: "摘要",
        title: "标题",
        htmlPreview: "HTML 预览",
        bodyText: "正文",
        data: "数据",
        createdAt: "创建时间",
        updatedAt: "更新时间",
        loadingContent: "正在加载实际报告内容",
        noHtmlPreview: "当前预览没有 HTML 内容。",
      },
      ruleTypes: {
        report: "报告",
        milestone: "里程碑",
        threshold: "阈值",
        change: "变化",
        health: "健康",
        test: "测试",
      },
      ruleTypeDescriptions: {
        report: "定期发送站点概览",
        milestone: "指标达到阶段值时通知",
        threshold: "指标高于或低于阈值时通知",
        change: "指标相对上个周期变化时通知",
        health: "长时间无数据时通知",
      },
      recipientModes: {
        creator: "创建者",
        team_admins: "团队管理员",
        all_team_members: "全部团队成员",
        users: "指定用户",
      },
      recipientKindLabel: "接收人类型",
      recipientPresetLabel: "预设",
      customRecipientsEmpty: "未选择接收人",
      noTeamMembers: "当前没有可选团队成员。",
      recipientKinds: {
        preset: "预设",
        custom: "自定义",
      },
      scheduleKinds: {
        daily: "每天",
        weekly: "每周",
        monthly: "每月",
        quarterly: "每季度",
        yearly: "每年",
        interval: "间隔",
      },
      reportPeriods: {
        daily: "日报",
        weekly: "周报",
        monthly: "月报",
        quarterly: "季度报告",
        yearly: "年报",
      },
      cooldownUnits: {
        minutes: "分钟",
        hours: "小时",
        days: "天",
      },
      intervalOptions: {
        every30Minutes: "每 30 分钟",
        everyHour: "每小时",
        every6Hours: "每 6 小时",
        every12Hours: "每 12 小时",
        everyDay: "每天",
        every7Days: "每 7 天",
        every30Days: "每 30 天",
      },
      weekDays: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
      metrics: {
        views: "浏览量",
        visitors: "访客",
        sessions: "会话",
      },
      windows: {
        last_1h: "最近 1 小时",
        last_24h: "最近 24 小时",
        yesterday: "昨天",
      },
      emailPreviewPage: {
        title: "通知邮件预览",
        subtitle: "不创建消息、不调用 Resend，直接渲染通知邮件。",
        typeLabel: "预览类型",
        localeLabel: "预览语言",
        formatLabel: "预览格式",
        html: "HTML",
        text: "纯文本",
        json: "JSON",
        refresh: "预览",
        loading: "正在渲染预览...",
        loadFailed: "渲染邮件预览失败。",
        subject: "主题",
      },
    },
    publicLinks: {
      title: "公开链接",
      subtitle: "管理当前团队可公开访问的分享链接。",
      enabled: "已启用",
      disabled: "未启用",
      disabledHint: "未启用公开访问。前往站点设置开启。",
      viewSettings: "查看设置",
      copyLink: "复制链接",
      linkCopied: "链接已复制",
      noSites: "当前团队还没有站点。",
      columns: {
        site: "站点",
        domain: "域名",
        publicUrl: "公开链接",
        status: "状态",
        action: "操作",
      },
    },
    apiKeys: {
      title: "API 密钥",
      subtitle: "管理当前团队用于接口访问的密钥。",
      empty: "当前团队还没有 API 密钥。",
      create: "创建密钥",
      creating: "创建中...",
      createTitle: "创建 API 密钥",
      createSubtitle: "只授予这个集成真正需要的最小权限。",
      nameLabel: "密钥名称",
      namePlaceholder: "生产同步任务",
      scopesTitle: "权限",
      scopesDescription: "API 密钥永远不能管理成员、用户、所有权或其他密钥。",
      siteScopeTitle: "站点范围",
      siteScopeDescription: "不选择站点表示当前团队所有现有和未来站点。",
      allSites: "全部站点",
      expirationLabel: "过期时间",
      expiration30: "30 天",
      expiration90: "90 天",
      expiration180: "180 天",
      expiration365: "365 天",
      expirationNever: "永不过期",
      oneTimeSecretTitle: "立即复制这个密钥",
      oneTimeSecretDescription: "完整密钥只显示一次，关闭弹窗后无法再次查看。",
      copySecret: "复制密钥",
      revoke: "撤销",
      rotate: "轮换",
      revokeConfirm: "确认立即撤销这个 API 密钥吗？",
      rotateConfirm: "确认轮换这个 API 密钥吗？旧密钥会被立即撤销。",
      neverExpires: "永不过期",
      notUsed: "未使用",
      loading: "正在加载 API 密钥...",
      loadFailed: "API 密钥加载失败。",
      invalidInput: "请输入名称并至少选择一个权限。",
      createFailed: "API 密钥创建失败。",
      revokeFailed: "API 密钥撤销失败。",
      rotateFailed: "API 密钥轮换失败。",
      copied: "已复制",
      status: {
        active: "有效",
        expired: "已过期",
        revoked: "已撤销",
      },
      scopes: {
        analyticsRead: "读取分析",
        siteRead: "读取站点",
        siteWrite: "写入站点",
        siteConfigRead: "读取配置",
        siteConfigWrite: "写入配置",
      },
      scopeDescriptions: {
        analyticsRead: "查看访问量、访客、页面浏览等分析数据",
        siteRead: "查看站点列表和站点详情",
        siteWrite: "创建、更新或删除站点",
        siteConfigRead: "查看站点配置，如跟踪代码、域名白名单等",
        siteConfigWrite: "修改站点配置，如跟踪强度、路径黑名单等",
      },
      scopeGroups: {
        analytics: "分析",
        site: "站点",
        siteConfig: "站点配置",
      },
      columns: {
        name: "名称",
        scopes: "权限",
        sites: "站点",
        expires: "过期",
        lastUsed: "最近使用",
        status: "状态",
        action: "操作",
      },
    },
    settings: {
      title: "团队设置",
      subtitle: "更新团队显示名和 slug。",
      nameLabel: "团队显示名",
      slugLabel: "团队 Slug",
      save: "保存设置",
      saving: "保存中...",
      delete: "删除团队",
      deleting: "删除中...",
      deleteConfirm: "确认删除该团队及其所有数据吗？此操作不可撤销。",
      transferTitle: "转移所有权",
      transferSubtitle:
        "将团队所有权转移给另一位成员。当前所有者会自动降为管理员。",
      transferTargetLabel: "新的所有者",
      transferTargetPlaceholder: "选择团队成员",
      transfer: "转移所有权",
      transferring: "转移中...",
      transferConfirm:
        "此操作不可撤销，你将失去对该团队的所有权（仍保留管理员权限）。确认继续吗？",
      noTransferableMembers: "当前团队没有其他可转移的成员，请先添加成员。",
    },
    members: {
      title: "成员管理",
      subtitle: "创建邀请链接或移除现有成员。",
      remove: "移除",
      noMembers: "当前团队暂无成员。",
      invitesTitle: "创建邀请链接",
      invitesSubtitle: "用户接受邀请后才会加入此团队。",
      inviteEmailLabel: "邮箱限制（可选）",
      inviteEmailPlaceholder: "user@example.com",
      inviteExpiresLabel: "有效期（小时）",
      createInvite: "创建邀请链接",
      creatingInvite: "创建中...",
      copyInvite: "复制链接",
      inviteLinksTitle: "邀请链接",
      inviteLinksSubtitle: "查看邀请状态并撤销有效链接。",
      noInvites: "当前团队暂无邀请链接。",
      anyEmail: "任意邮箱",
      revokeInvite: "撤销邀请",
      siteAccessLabel: "站点权限",
      siteAccessAll: "全部站点",
      siteAccessRestricted: "限定站点",
      siteAccessSelected: "已选择 {count} 个站点",
      siteAccessDescription: "保持为全部站点，或选择此成员可以访问的具体站点。",
      siteAccessAdmins: "管理员可以访问此团队内的全部站点。",
      siteAccessDialogTitle: "编辑站点权限",
      saveSiteAccess: "保存权限",
      cancelSiteAccess: "取消",
      noSitesForAccess: "当前团队暂无站点。",
      inviteStatuses: {
        active: "有效",
        used: "已使用",
        revoked: "已撤销",
        expired: "已过期",
      },
      columns: {
        name: "名称",
        username: "用户名",
        email: "邮箱",
        inviteCode: "邀请码",
        role: "角色",
        siteAccess: "站点权限",
        joinedAt: "加入时间",
        createdAt: "创建时间",
        expiresAt: "过期时间",
        usedAt: "使用时间",
        status: "状态",
        action: "操作",
      },
      roleLabels: {
        owner: "所有者",
        admin: "管理员",
        member: "成员",
      },
    },
  },
  managementNav: {
    users: "用户管理",
    sites: "站点管理",
    teams: "团队管理",
    versionUpdates: "版本更新",
    scheduledTasks: "定时任务",
    requestObservation: "请求观测",
    systemPerformance: "系统性能",
    systemSettings: "系统设置",
  },
  managementPages: {
    versionUpdates: {
      subtitle: "查看 InsightFlare 已发布版本与当前运行构建。",
      empty: "暂无版本更新记录。",
      currentVersion: "当前版本",
      latestVersion: "最新版本",
      currentCommit: "当前提交",
      releaseCount: "发布数",
      publishedAt: "发布时间",
      author: "发布者",
      commit: "提交",
      statusStable: "正式版",
      statusPrerelease: "预发布",
      statusDraft: "草稿",
      currentVersionBadge: "当前版本",
      releaseNotes: "更新说明",
      openRelease: "打开 Release",
      viewDetails: "查看详细变更",
      detailsTitle: "详细变更",
      detailsDescription: "{range} 包含的提交。",
      detailsLoading: "正在加载详细变更...",
      detailsEmpty: "这个版本暂无可对比的上一个发布版本。",
      detailsFailed: "加载详细变更失败。",
      currentCommitBadge: "当前部署",
      openCompare: "打开对比",
      openCommit: "打开提交",
      commitCount: "提交数",
      source: "数据来源",
      loadFailed: "加载 GitHub Releases 失败。",
      unknown: "未知",
    },
    scheduledTasks: {
      subtitle: "查看和管理系统定时任务。",
      empty: "暂无定时任务。",
      refresh: "刷新",
      loadFailed: "加载定时任务失败。",
      allStatuses: "全部状态",
      runs24h: "24 小时运行",
      successRate24h: "24 小时成功率",
      successRateDescription: "只统计成功状态的运行。",
      problemRuns24h: "问题运行",
      retentionPrefix: "保留",
      days: "天",
      failed: "失败",
      partial: "部分完成",
      lastRun: "最近运行",
      staleRunning: "卡住的运行",
      noStaleRunning: "没有卡住的运行",
      taskListTitle: "任务",
      taskListDescription: "当前系统注册的定时任务和近 30 天健康状况。",
      task: "任务",
      schedule: "计划",
      enabled: "状态",
      enabledYes: "已启用",
      enabledNo: "未启用",
      lastStatus: "最近状态",
      runs30d: "30 天运行",
      successRate30d: "30 天成功率",
      avgDuration: "平均耗时",
      runHistoryTitle: "运行历史",
      runHistoryDescription: "最近 30 天内的任务运行记录。",
      noRuns: "暂无运行记录。",
      scheduledAt: "计划时间",
      startedAt: "开始时间",
      finishedAt: "结束时间",
      trigger: "触发",
      tasks: "任务",
      taskCount: "任务数",
      subtaskCount: "子任务数",
      taskResult: "任务结果",
      statusLabel: "状态",
      duration: "耗时",
      sites: "站点",
      hours: "小时",
      rows: "行数",
      rulesScanned: "规则",
      messagesCreated: "消息",
      emailFailed: "邮件失败",
      logs: "日志",
      viewLogs: "查看",
      logTitle: "运行日志",
      noRunSelected: "选择一次运行查看日志。",
      noLogs: "暂无日志。",
      error: "错误",
      status: {
        running: "运行中",
        success: "成功",
        partial: "部分完成",
        failed: "失败",
        skipped: "已跳过",
      },
      taskDefinitions: {
        visit_hourly_rollup: {
          name: "小时访问聚合",
          description:
            "将已关闭的访问记录聚合为小时汇总，用于仪表盘计数器和趋势。",
          schedule: "每小时",
        },
        notification_tick: {
          name: "通知分发",
          description: "检查通知规则并分发消息。",
          schedule: "每小时",
        },
      },
    },
  },
  adminUsers: {
    title: "用户管理",
    subtitle: "仅系统管理员可创建和管理后台用户。",
    createTitle: "新建用户",
    createTeamNotice:
      "在这里创建用户会同时创建一个由该用户拥有的新团队。如果只是想把用户加入现有团队，请前往对应团队设置中创建邀请链接。",
    username: "用户名",
    email: "邮箱",
    name: "名称（可选）",
    password: "密码（至少 8 位）",
    role: "系统角色",
    teamName: "团队名称",
    teamSlug: "团队 Slug（可选）",
    defaultTeamName: "{name} 的团队",
    create: "创建用户",
    creating: "创建中...",
    delete: "删除",
    deleting: "删除中...",
    deleteConfirm: "确认删除该用户账号吗？",
    deleteSuccess: "用户已删除。",
    deleteFailed: "删除用户失败。",
    generateResetLink: "生成重置密码链接",
    resetLinkCreated: "重置密码链接已生成。",
    resetLinkCreateFailed: "生成重置密码链接失败。",
    resetLinkCopied: "重置密码链接已复制。",
    resetLinkCopyFailed: "复制重置密码链接失败。",
    copyResetLink: "复制链接",
    resetLinkExpiresAt: "过期时间",
    listTitle: "用户列表",
    listSubtitle: "当前系统内所有用户。",
    noData: "暂无用户数据。",
    loadFailed: "加载用户列表失败。",
    createSuccess: "用户创建成功。",
    createFailed: "用户创建失败。",
    invalidInput: "请填写有效的用户名、邮箱和密码。",
    columns: {
      name: "名称",
      username: "用户名",
      email: "邮箱",
      role: "角色",
      teams: "团队数",
      created: "创建时间",
      action: "操作",
    },
  },
  adminSites: {
    title: "站点管理",
    subtitle: "管理当前团队下的站点。",
    team: "团队",
    createTitle: "新建站点",
    createSubtitle: "新建后可直接进入分析页面。",
    name: "站点名称",
    domain: "域名",
    publicSlug: "公开 Slug（可选）",
    create: "创建站点",
    creating: "创建中...",
    listTitle: "站点列表",
    listSubtitle: "当前团队下所有站点。",
    noData: "暂无站点数据。",
    loadFailed: "加载站点失败。",
    createSuccess: "站点创建成功。",
    createFailed: "站点创建失败。",
    invalidInput: "请填写有效的站点名称和域名。",
    open: "打开分析",
    columns: {
      name: "名称",
      domain: "域名",
      slug: "Slug",
      created: "创建时间",
      action: "操作",
    },
  },
  adminTeams: {
    title: "团队管理",
    subtitle: "仅系统管理员可创建与查看所有团队。",
    createTitle: "新建团队",
    createSubtitle: "创建后可进入团队配置与成员管理。",
    name: "团队名称",
    slug: "团队 Slug（可选）",
    create: "创建团队",
    creating: "创建中...",
    listTitle: "团队列表",
    listSubtitle: "系统中所有团队。",
    noData: "暂无团队数据。",
    loadFailed: "加载团队失败。",
    createSuccess: "团队创建成功。",
    createFailed: "团队创建失败。",
    invalidInput: "团队名称至少 2 个字符。",
    open: "进入团队",
    settings: "设置",
    columns: {
      name: "名称",
      slug: "Slug",
      sites: "站点数",
      members: "成员数",
      created: "创建时间",
      action: "操作",
    },
  },
  requestObservation: {
    title: "请求观测",
    subtitle: "基于 Analytics Engine 观察整体请求、异常分流与正常采集链路。",
    tabs: {
      overview: "总览",
      abnormal: "异常请求",
      normal: "正常请求",
    },
    refresh: "刷新",
    loadFailed: "加载请求观测数据失败。",
    notConfiguredTitle: "尚未配置 Analytics Engine 读取凭据",
    notConfiguredDescription:
      "请先在系统设置中填写 Cloudflare Account ID 和 API Token，用于读取请求观测 Analytics Engine 数据集。",
    analyticsEngineDisabledTitle: "Analytics Engine 尚未启用",
    analyticsEngineDisabledDescription:
      "当前部署未绑定 Analytics Engine，因为 Cloudflare 账户尚未启用 Analytics Engine。请先在 Cloudflare 中启用，然后重新部署以采集请求观测数据。",
    openAnalyticsEngine: "打开 Analytics Engine",
    openSettings: "打开设置",
    highConfidenceBots: "高置信机器人",
    affectedSites: "受影响站点",
    uniqueCountries: "国家/地区",
    noData: "当前时间窗口内没有请求数据。",
    trendTitle: "分流趋势",
    trendDescription: "按时间间隔显示正常请求、异常请求与分流比例。",
    recentTitle: "最近机器人请求",
    recentDescription: "这些详细记录只写入机器人 Analytics Engine 数据集。",
    recentShowing: "已显示",
    recentLoadedAll: "已加载全部记录",
    detailTitle: "机器人请求详情",
    detailSubtitle: "查看这次分流请求的检测信号、网络和客户端上下文。",
    client: "客户端",
    edge: "边缘",
    identifiers: "标识符",
    fullUserAgent: "完整 User-Agent",
    id: "ID",
    metadata: "Metadata",
    time: "时间",
    site: "站点",
    location: "位置",
    network: "网络",
    reason: "原因",
    request: "请求",
    ip: "IP",
    userAgent: "User-Agent",
    confidence: "置信度",
    blocked: "拦截",
    highConfidenceRequests: "高置信请求",
    emptyValue: "未知",
    kind: "类型",
    botScoreBucket: "Bot Score 区间",
    verifiedBotCategory: "验证机器人类别",
    hostname: "主机名",
    pathname: "路径",
    origin: "Origin",
    asOrganization: "ASN 组织",
    asn: "ASN",
    country: "国家/地区",
    region: "州/省",
    city: "城市",
    colo: "数据中心",
    userAgentLengthBucket: "User-Agent 长度",
    ipPrefix: "IP 前缀",
    botReasonLabels: {
      missing_ua: "缺少 User-Agent",
      ua_too_long: "User-Agent 过长",
      ua_isbot: "User-Agent 匹配机器人",
      script_ua: "脚本客户端 User-Agent",
      cf_bot_score_low: "Cloudflare Bot Score 偏低",
      cf_verified_bot_category: "Cloudflare 验证机器人类别",
      hosting_asn: "托管服务 ASN",
      network_service_asn: "网络服务 ASN",
      transit_asn: "中转网络 ASN",
      access_asn: "接入网络 ASN",
      missing_browser_provenance: "缺少浏览器来源信号",
      origin_hostname_mismatch: "Origin 与主机名不匹配",
      blocked_pathname: "命中路径黑名单",
    },
    requestKindLabels: {
      pageview: "页面浏览",
      custom_event: "自定义事件",
      request: "请求",
    },
    overviewLabels: {
      totalRequests: "总请求数",
      normalRequests: "正常请求",
      abnormalRequests: "异常请求",
      abnormalRatio: "异常请求比例",
      p50Latency: "P50 边缘耗时",
      p75Latency: "P75 边缘耗时",
      p95Latency: "P95 边缘耗时",
      p99Latency: "P99 边缘耗时",
      avgLatency: "平均边缘耗时",
      pageviews: "页面浏览",
      customEvents: "自定义事件",
      overviewTrendTitle: "请求分流趋势",
      overviewTrendDescription:
        "按顶栏时间间隔分桶显示正常与异常请求，以及异常请求比例。",
      trafficCompositionTitle: "请求构成",
      trafficCompositionDescription:
        "正常请求、异常请求和页面事件在同一时间轴上的变化。",
      confidenceShareTitle: "请求置信度占比",
      normalTrafficShare: "正常流量",
      lowConfidenceTraffic: "低置信度流量",
      mediumConfidenceTraffic: "中置信度流量",
      highConfidenceTraffic: "高置信度流量",
      latencyTitle: "边缘耗时趋势",
      latencyDescription:
        "正常请求写入 AE 时记录的 P50 / P75 / P95 / P99 边缘耗时。",
      abnormalSubtitle:
        "聚焦已分流的异常请求，地图和统计表只显示红色异常流量。",
      normalSubtitle:
        "聚焦进入正常采集链路的请求，地图和统计表只显示绿色正常流量。",
      requests: "请求数",
      windowDays: "最近 {days} 天",
      latencyMilliseconds: "{value} 毫秒",
    },
    normalDetail: {
      title: "正常请求详情",
      subtitle: "查看正常请求 AE 记录的链路、位置和耗时字段。",
      requestMethod: "请求方法",
      edgeLatency: "边缘耗时",
      eventAt: "事件时间",
      receivedAt: "接收时间",
      coordinates: "坐标",
      continent: "大洲",
    },
    recentNormal: {
      title: "最近正常请求",
      description: "这些详细记录只写入正常请求 Analytics Engine 数据集。",
    },
  },
  systemSettings: {
    title: "系统设置",
    subtitle: "管理当前 InsightFlare 实例的全站配置。",
    guide: "教程",
    botAnalyticsTitle: "分析引擎",
    botAnalyticsDescription:
      "配置用于读取 Analytics Engine 数据的 Cloudflare 凭据，供机器人防护等分析功能使用。",
    botAnalyticsAccountIdLabel: "Cloudflare Account ID",
    botAnalyticsApiTokenLabel: "Cloudflare API Token",
    botAnalyticsApiTokenPlaceholder: "查看教程以获取 Cloudflare API Token",
    botAnalyticsSaved: "分析引擎配置已保存。",
    botAnalyticsSaveFailed: "保存分析引擎配置失败。",
    botAnalyticsDeleted: "分析引擎配置已删除。",
    botAnalyticsDeleteFailed: "删除分析引擎配置失败。",
    botAnalyticsDeleteConfirm:
      "确认删除分析引擎读取配置吗？删除后依赖 Analytics Engine 的功能会显示需要配置。",
    botAnalyticsEngineDisabledTitle: "Analytics Engine 尚未启用",
    botAnalyticsEngineDisabledDescription:
      "当前部署已自动禁用 Analytics Engine 绑定，因为 Cloudflare 账户尚未启用 Analytics Engine。请先在 Cloudflare 中启用 Analytics Engine，然后重新部署 InsightFlare 以激活相关分析功能。",
    botAnalyticsEngineDisabledHint:
      "在启用 Analytics Engine 并重新部署 Worker 前，分析引擎设置不可修改。",
    botAnalyticsOpenCloudflare: "打开 Cloudflare Analytics Engine",
    botAnalyticsGuideTitle: "获取分析引擎配置",
    botAnalyticsGuideDescription:
      "分析引擎需要 Cloudflare 账号信息和一个可读取 Analytics Engine 的 API Token。",
    botAnalyticsGuideSteps: [
      "打开 Cloudflare Dashboard，进入目标账号并复制 Account ID。",
      "在 Workers & Pages 中启用 Analytics Engine；机器人和普通请求数据集会随部署自动创建并绑定。",
      "前往 My Profile → API Tokens，创建 Custom token。",
      "为 Token 添加 Account Analytics 读取权限，并限制到当前账号。",
      "保存后复制 Token，回到这里填写 Account ID 和 API Token。",
    ],
    notificationEmailTitle: "邮件通知",
    notificationEmailDescription:
      "配置系统用于发送报告、告警和测试邮件的邮件服务。",
    notificationEmailGuideTitle: "获取 Resend 邮件配置",
    notificationEmailGuideDescription:
      "使用 Resend 发送系统邮件前，需要准备发件域名和 API Key。",
    notificationEmailGuideSteps: [
      "打开 Resend Dashboard，并确认要作为发件人的域名已完成 DNS 验证。",
      "在 API Keys 页面创建新的 API Key。",
      "选择发送邮件所需的权限，并复制生成后的 API Key。",
      "回到这里填写发件人名称、发件邮箱、Reply-To 和 Resend API Key。",
      "保存后使用测试收件人发送一封测试邮件，确认投递链路正常。",
    ],
    loginTurnstileTitle: "登录 Turnstile 保护",
    loginTurnstileDescription:
      "启用后，登录页会在后台执行 Cloudflare Turnstile Invisible 验证，并在服务端登录流程中强制校验。",
    loginTurnstileEnabledLabel: "启用登录保护",
    loginTurnstileSiteKeyLabel: "Site Key",
    loginTurnstileSecretKeyLabel: "Secret Key",
    loginTurnstileSecretKeyPlaceholder: "查看教程以获取 Turnstile Secret Key",
    loginTurnstileModeLabel: "验证模式",
    loginTurnstileModeInvisible: "Invisible",
    loginTurnstileTest: "测试验证",
    loginTurnstileTesting: "验证中...",
    loginTurnstileTestPassed: "验证成功",
    loginTurnstileTestRequired: "新 Secret Key 需要先测试",
    loginTurnstileTestMissing: "请先填写 Site Key 和 Secret Key。",
    loginTurnstileTestFailed: "验证失败，请检查 Site Key 与 Secret Key。",
    loginTurnstileSaved: "登录 Turnstile 配置已保存。",
    loginTurnstileSaveFailed: "保存登录 Turnstile 配置失败。",
    loginTurnstileDeleted: "登录 Turnstile 配置已删除。",
    loginTurnstileDeleteFailed: "删除登录 Turnstile 配置失败。",
    loginTurnstileDeleteConfirm:
      "确认删除登录 Turnstile 配置吗？删除后登录保护将关闭。",
    loginTurnstileLoadFailed: "加载登录 Turnstile 配置失败。",
    loginTurnstilePrivacyNotice:
      "请在 Cloudflare Turnstile 控制台创建 Invisible widget。自托管站点启用后，请自行确认隐私政策与 Cloudflare Turnstile 要求匹配。",
    loginTurnstileGuideTitle: "获取 Turnstile 配置",
    loginTurnstileGuideDescription:
      "登录保护需要 Cloudflare Turnstile 的 Site Key 和 Secret Key。",
    loginTurnstileGuideSteps: [
      "打开 Cloudflare Dashboard，进入 Turnstile。",
      "新建一个 widget，并选择 Invisible 模式。",
      "添加当前 InsightFlare 登录域名到允许的主机名列表。",
      "创建后复制 Site Key 和 Secret Key。",
      "回到这里填写 Site Key 和 Secret Key，先运行测试验证，再保存配置。",
    ],
    enabledLabel: "启用邮件发送",
    enabledOn: "开启",
    enabledOff: "关闭",
    providerLabel: "邮件服务",
    providerResend: "Resend",
    fromNameLabel: "发件人名称",
    fromEmailLabel: "发件人邮箱",
    replyToLabel: "Reply-To 邮箱",
    replyToPlaceholder: "可选，默认使用发件人邮箱",
    resendApiKeyLabel: "Resend API Key",
    resendApiKeyPlaceholder: "查看教程以获取 Resend API Key",
    testRecipientLabel: "测试收件人",
    save: "保存配置",
    saving: "保存中...",
    test: "发送测试邮件",
    testing: "发送中...",
    saved: "邮件配置已保存。",
    saveFailed: "保存邮件配置失败。",
    delete: "删除配置",
    deleting: "删除中...",
    cancel: "取消",
    deleted: "邮件配置已删除。",
    deleteFailed: "删除邮件配置失败。",
    deleteConfirm:
      "确认删除邮件通知配置吗？删除后系统将视为未配置并关闭邮件发送。",
    testSent: "测试邮件已发送。",
    testFailed: "测试邮件发送失败。",
    loadFailed: "加载邮件配置失败。",
  },
  systemPerformance: {
    title: "系统性能",
    subtitle: "基于现有分析行监控 InsightFlare 的采集、缓冲和写入健康度。",
    refresh: "刷新",
    loadFailed: "加载系统性能数据失败。",
    noData: "当前时间窗口内暂无系统性能数据。",
    range15m: "最近 15 分钟",
    range1h: "最近 1 小时",
    range6h: "最近 6 小时",
    range24h: "最近 24 小时",
    totalEvents: "已接收事件",
    p95Latency: "P95 估算延迟",
    p50Latency: "P50",
    p75Latency: "P75",
    p50Label: "P50",
    p75Label: "P75",
    p95Label: "P95",
    dataFreshness: "数据新鲜度",
    noRecentWrite: "暂无最近写入",
    clockAnomalies: "时钟/延迟异常",
    delayed: "延迟",
    future: "未来时钟",
    latencyPercentileTrend: "延迟分位趋势",
    latencyPercentileTrendDescription:
      "查看接收事件的 P50、P75、P95 估算延迟。",
    throughputTrend: "已接收事件吞吐",
    throughputTrendDescription: "查看接收事件的吞吐情况。",
    visits: "访问",
    customEvents: "自定义事件",
    anomalyBucket: "异常分桶",
    openVisitHealth: "未关闭访问堆积",
    openVisitHealthDescription:
      "尚未被离开事件、路由切换或超时收尾关闭的访问行。",
    open: "未关闭",
    stale: "停滞",
    timedOut: "已超时",
    oldestOpen: "最早未关闭",
    latestActivity: "最近活动",
    latencySampleHealth: "延迟样本健康度",
    latencySampleHealthDescription: "查看可信事件的延迟情况。",
    trustedSamples: "可信样本",
    topSitesTitle: "系统负载最高的站点",
    topSitesDescription: "当前接收事件数量最多的站点。",
    events: "事件",
    avgLatency: "平均延迟",
    slowestEventsTitle: "估算最慢事件",
    slowestEventsDescription:
      "当前窗口内服务端写入时间与事件时间正向差值最大的记录。",
    eventTime: "事件时间",
    serverTime: "服务端写入时间",
    estimatedDelay: "估算延迟",
    doDiagnosticTitle: "DO 内部缓冲诊断",
    doDiagnosticDescription:
      "诊断每个站点的专用 Durable Object 中的数据停滞情况。",
    doDiagnosticLoadFailed: "加载 DO 诊断数据失败。",
    doDiagnosticLoading: "正在拉取每个 DO 的状态…",
    doDiagnosticRun: "运行 DO 诊断",
    doDiagnosticEmpty: "暂无站点 DO 状态。",
    doDiagnosticUnreachable: "部分站点 DO 不可达",
    doDiagnosticReachableSites: "可达 DO",
    doDiagnosticTotalSites: "总站点",
    doDiagnosticActiveAlarms: "活跃 Alarm 定时器",
    doDiagnosticBufferedVisits: "缓冲访问",
    doDiagnosticOpenVisits: "缓冲未关闭访问行",
    doDiagnosticOpenStale: "未关闭且停滞 >30 分钟",
    doDiagnosticOpenTimedOut: "未关闭且停滞 >12 小时",
    doDiagnosticOpenHardAged: "起始 >36 小时",
    doDiagnosticOpenFutureSkew: "未来时间戳",
    doDiagnosticStuckDirty: "未刷新卡住",
    doDiagnosticMaxFlushAttempts: "最大重试次数",
    doDiagnosticBufferedCustomEvents: "缓冲自定义事件",
    doDiagnosticOldestOpen: "最早未关闭起始",
    doDiagnosticFutureMaxActivity: "最远未来 last_activity",
    doDiagnosticSiteList: "风险靠前的站点",
    doDiagnosticSiteListDescription:
      "按风险评分排序，前 20 个站点的 DO 内部缓冲快照。",
    doDiagnosticSiteFailed: "不可达",
    doDiagnosticSiteOpen: "未关闭",
    doDiagnosticSiteStuck: "卡住",
    doDiagnosticSiteFuture: "未来",
    doDiagnosticSiteHardAged: "老旧",
    doDiagnosticSiteAlarm: "Alarm 状态",
    doDiagnosticSiteAlarmNone: "无",
    doDiagnosticSiteAlarmDue: "到期",
    doDiagnosticSiteResponseMs: "响应耗时",
    doDiagnosticThresholdsHint:
      "阈值：stale {stale}，timeout {timeout}，hardAged {hardAged}，stuck flush_attempts ≥ {stuck}",
    doDiagnosticHealthy: "当前未发现异常缓冲行。",
  },
  loginForm: {
    signingIn: "登录中...",
    verifyingSecurity: "正在安全验证...",
    securityVerificationTitle: "安全验证失败",
    securityVerificationFailed: "安全验证失败，请重试。",
    retrySecurityVerification: "重试验证",
    redirecting: "正在跳转...",
    failed: "登录失败，请稍后重试。",
  },
  logoutAction: {
    pending: "退出中...",
    success: "已退出登录。",
    failed: "退出登录失败，请稍后重试。",
  },
  sidebarFooter: {
    loggingOut: "退出中...",
    logoutSuccess: "已退出登录。",
    logoutFailed: "退出登录失败，请稍后重试。",
  },
  teamEntry: {
    title: "选择团队",
    description: "你当前可访问多个团队，请先选择要进入的团队。",
  },
} as AppMessages;

const jaMessages = {
  appName: "InsightFlare",
  navigation: {
    overview: "概要",
    realtime: "リアルタイム",
    pages: "ページ",
    referrers: "参照元",
    sessions: "セッション",
    events: "イベント",
    funnels: "ファネル",
    campaigns: "キャンペーン",
    visitors: "訪問者",
    retention: "リテンション",
    geo: "地域",
    devices: "デバイス",
    browsers: "ブラウザー",
    performance: "パフォーマンス",
    settings: "設定",
  },
  common: {
    deviceLabels: {
      desktop: "デスクトップ",
      mobile: "モバイル",
      tablet: "タブレット",
    },
    timeRelativePair: "{absolute}（{relative}）",
    id: "ID",
    views: "表示回数",
    sessions: "セッション",
    visitors: "訪問者",
    bounceRate: "直帰率",
    avgDuration: "平均滞在時間",
    path: "パス",
    title: "タイトル",
    hostname: "ホスト名",
    referrerHost: "参照元ホスト",
    entryPage: "入口ページ",
    exitPage: "離脱ページ",
    referrer: "参照元",
    startedAt: "開始",
    event: "イベント",
    location: "地域",
    browser: "ブラウザー",
    operatingSystem: "オペレーティングシステム",
    deviceType: "デバイス種別",
    country: "国",
    region: "地域",
    regionCode: "地域コード",
    city: "都市",
    continent: "大陸",
    latitude: "緯度",
    longitude: "経度",
    continentLabels: {
      AF: "アフリカ",
      AN: "南極",
      AS: "アジア",
      EU: "ヨーロッパ",
      NA: "北アメリカ",
      OC: "オセアニア",
      SA: "南アメリカ",
      AFRICA: "アフリカ",
      ANTARCTICA: "南極",
      ASIA: "アジア",
      EUROPE: "ヨーロッパ",
      "NORTH AMERICA": "北アメリカ",
      OCEANIA: "オセアニア",
      "SOUTH AMERICA": "南アメリカ",
    },
    timezone: "タイムゾーン",
    organization: "組織",
    screenSize: "画面サイズ",
    loading: "読み込み中",
    noData: "データなし",
    unknown: "不明",
    lastUpdated: "最終更新",
    site: "サイト",
    team: "チーム",
    management: "管理",
    backToTeam: "チームへ戻る",
    system: "システム",
    account: "アカウント",
    theme: "テーマ",
    language: "言語",
    role: "権限",
    admin: "管理者",
    user: "ユーザー",
    search: "検索",
    tableExport: {
      action: "エクスポート",
      title: "CSV をエクスポート",
      description: "テーブルデータを CSV ファイルとしてダウンロードします。",
      scopeLabel: "対象",
      currentTab: "現在のタブ",
      allTabs: "すべてのタブ",
      rowsLabel: "データ",
      currentView: "現在表示中のデータ",
      rawRows: "元データ",
      fileNameLabel: "ファイル名",
      download: "CSV をエクスポート",
      empty: "エクスポートできる行がありません。",
      allTabsUnavailable:
        "すべてのタブは、各データの読み込み後に利用できます。",
    },
    time: "時刻",
    cycle: "サイクル",
    close: "閉じる",
    sitesFiltered: "{active} / {total} サイトを絞り込み中",
    cumulativeTraffic: "期間累計トラフィック",
  },
  ranges: {
    last30m: "30分",
    last1h: "1時間",
    today: "今日",
    yesterday: "昨日",
    thisWeek: "今週",
    thisMonth: "今月",
    thisYear: "今年",
    last24h: "過去 24 時間",
    last7d: "過去 7 日",
    last30d: "過去 30 日",
    last90d: "過去 90 日",
    last6m: "過去 6 か月",
    last12m: "過去 12 か月",
    allTime: "全期間",
    custom: "カスタム範囲",
  },
  intervals: {
    minute: "分",
    hour: "時間",
    day: "日",
    week: "週",
    month: "月",
  },
  dashboardHeader: {
    range: "期間",
    interval: "間隔",
    filters: "フィルター",
    customRange: "カスタム範囲を選択",
    customHint: "開始日と終了日を選択してください。",
    customPendingEnd: "開始日が選択されました。終了日を選択してください。",
    customApply: "適用",
    rangeGroupQuick: "クイック範囲",
    rangeGroupCalendar: "カレンダー期間",
    rangeGroupRolling: "ローリング期間",
    rangeGroupAdvanced: "詳細",
    intervalDisabledMinute: "分単位の間隔は 1 時間以内でのみ利用できます。",
    intervalDisabledHour: "時間単位の間隔は 7 日以内でのみ利用できます。",
    intervalDisabledDay: "日単位の間隔は過去 90 日以内でのみ利用できます。",
    intervalDisabledWeek: "週単位の間隔は過去 12 か月以内でのみ利用できます。",
    filterTitle: "フィルター",
    filterSubtitle:
      "フィルターは現在の概要データクエリにリアルタイムで適用されます。",
    previousPeriod: "前の期間",
    nextPeriod: "次の期間",
    customSelectionSummary: "選択範囲：{from} から {to}（{days} 日）",
  },
  filters: {
    country: "国",
    device: "デバイス",
    browser: "ブラウザー",
    all: "すべて",
    clear: "クリア",
  },
  filterBuilder: {
    fieldGroups: {
      page: "ページ",
      session: "セッション",
      referrer: "リファラー",
      campaign: "キャンペーン",
      client: "クライアント",
      geography: "地域",
      event: "イベント",
    },
    fieldLabels: {
      "page.path": "ページパス",
      "page.title": "ページタイトル",
      "page.hostname": "ページホスト名",
      "page.query": "クエリ文字列",
      "page.hash": "ハッシュフラグメント",
      "session.entryPath": "入口ページ",
      "session.exitPath": "出口ページ",
      "referrer.domain": "リファラードメイン",
      "referrer.url": "リファラー URL",
      "utm.source": "キャンペーンソース",
      "utm.medium": "キャンペーンメディア",
      "utm.campaign": "キャンペーン名",
      "utm.term": "キャンペーン用語",
      "utm.content": "キャンペーンコンテンツ",
      "client.browser": "ブラウザー",
      "client.browserVersion": "ブラウザーのバージョン",
      "client.browserEngine": "ブラウザーエンジン",
      "client.os": "オペレーティングシステム",
      "client.osVersion": "オペレーティングシステムのバージョン",
      "client.deviceType": "デバイス種別",
      "client.language": "言語",
      "client.screenSize": "画面サイズ",
      "geo.country": "国・地域",
      "geo.region": "地域",
      "geo.city": "市区町村",
      "geo.continent": "大陸",
      "geo.timeZone": "タイムゾーン",
      "geo.organization": "組織",
      "event.name": "イベント名",
      "event.payload": "イベントペイロード",
    },
    operatorLabels: {
      eq: "等しい",
      neq: "等しくない",
      in: "いずれかに一致",
      notIn: "いずれにも一致しない",
      contains: "含む",
      startsWith: "で始まる",
      endsWith: "で終わる",
      gt: "より大きい",
      gte: "以上",
      lt: "より小さい",
      lte: "以下",
      between: "範囲内",
      exists: "存在する",
      notExists: "存在しない",
      isNull: "NULL である",
      notNull: "NULL ではない",
      isEmpty: "空文字列である",
      notEmpty: "空文字列ではない",
    },
    valueType: "値の種類",
    valueKinds: {
      string: "テキスト",
      enum: "選択肢",
      number: "数値",
      boolean: "真偽値",
      date: "日付",
      datetime: "日時",
      "json-scalar": "JSON スカラー",
    },
    booleanTrue: "真",
    booleanFalse: "偽",
    valueUnset: "（未設定）",
    valueLoading: "値を読み込み中",
    valueSearchPlaceholder: "値を検索または入力",
    valueListPlaceholder: "値を検索または入力して Enter で追加",
    rangeStartPlaceholder: "下限",
    rangeEndPlaceholder: "上限",
    jsonPointer: "JSON ポインター",
    match: "一致条件",
    expression: "フィルター式",
    expressionPlaceholder: "フィルター式...",
    expressionInvalid:
      "式が無効です。クリックして構文ヘルプを確認してください。",
    expressionHelpTitle: "フィルター式の構文",
    expressionHelpDescription:
      "利用可能なフィールドと演算子は、現在のフィルター契約から動的に生成されます。",
    expressionHelpSyntax: "構文",
    expressionHelpLogicDescription:
      "AND は OR より優先されます。ネストには括弧を使用し、AND(...) と OR(...) は明示的な単一条件グループを保持します。",
    expressionHelpValues: "値",
    expressionHelpValuesDescription:
      "文字列は JSON の二重引用符を使います。数値と真偽値は引用しません。集合には [値, 値] を使い、between には順序付きの値を 2 つ指定します。",
    expressionHelpOperators: "利用可能な演算子",
    expressionHelpUnaryOperators: "値を取らない演算子",
    expressionHelpFields: "利用可能なフィールド",
    expressionHelpFieldType: "型",
    expressionHelpFieldOperators: "演算子",
    expressionHelpOtherFields: "その他",
    apply: "フィルターを適用",
    allConditions: "すべての条件",
    anyCondition: "いずれかの条件",
    condition: "条件 {index}",
    group: "グループ {index}",
    invertCondition: "この条件を反転",
    exclude: "除外",
    addGroup: "グループを追加",
    invalid: "適用する前に、すべての条件を入力してください。",
  },
  realtime: {
    title: "リアルタイム",
    subtitle: "直近 30 分間のトラフィックを確認します。",
    logTitleSeparator: ":",
    activeNow: "現在アクティブ",
    liveMetrics: "アクティブ / 30分訪問者 / 30分表示回数",
    connected: "接続済み",
    connecting: "接続中",
    reconnecting: "再接続中",
    failed: "接続失敗",
    recentEvents: "最近のライブイベント",
    enterPage: "ページに入る",
    leavePage: "ページを離れる",
    viewPage: "ページ表示",
    customEvent: "イベント",
    detailsTitle: "イベント詳細",
    detailsSection: "情報",
    visitorHistorySection: "訪問者アクティビティ",
    visitorHistorySubtitle:
      "現在のリアルタイム範囲における、この訪問者のすべての記録です。",
    visitorHistoryEmpty: "この訪問者の追加記録はまだありません。",
    visitorMapSection: "訪問者の地域",
    visitorMapSubtitle: "このイベントの座標から推定したおおよその地域です。",
    visitorMapUnavailable: "このイベントには利用可能な座標がありません。",
    visitorId: "訪問者 ID",
    sessionId: "セッション ID",
    visitId: "訪問 ID",
    eventType: "イベント種別",
    eventTime: "イベント時刻",
  },
  overview: {
    title: "トラフィック概要",
    subtitle: "高レベルのパフォーマンスとオーディエンス行動を監視します。",
    trendTitle: "トラフィック推移",
    sourceTab: "ソース",
    sourceDomainColumn: "ソース（ドメイン）",
    sourceLinkTab: "ソースリンク",
    sourceLinkColumn: "ソースリンク",
    direct: "直接",
    searchInTab: "{tab} を検索",
  },
  pages: {
    title: "ページ",
    subtitle: "選択範囲で最も訪問されたパスです。",
    pagesPerSession: "ページ / セッション",
    untitled: "無題のページ",
    empty: "現在のフィルターに一致するページデータはありません。",
    loadError:
      "ページデータを読み込めませんでした。後でもう一度お試しください。",
    loadMoreError: "追加のページを読み込めませんでした。",
    retry: "再試行",
    trendTitle: "ページトラフィック推移",
    otherPages: "その他のページ",
    hashTab: "アンカー",
    noHash: "アンカーなし",
    queryTab: "クエリパラメータ",
    noQuery: "クエリパラメータなし",
    eventTab: "イベント",
    eventsMetric: "イベント",
    viewDetails: "詳細を表示",
  },
  referrers: {
    title: "参照元",
    subtitle: "トラフィックの流入元です。",
    summaryTitle: "ソース概要",
    splitTitle: "トラフィック内訳",
    chartTitle: "ソース構成",
    radarTitle: "上位 24 ソースのレーダー",
    radarSubtitle: "主要な参照元を行動指標で比較します。",
    radarDuration: "滞在時間",
    radarEngagement: "エンゲージメント",
    radarDepth: "深さ",
    radarLoyalty: "ロイヤルティ",
    radarFrequency: "頻度",
    radarTraffic: "トラフィック",
    directSourceNote:
      "このトラフィックは外部の参照元サイトなしで到達しました。",
    breakdownTitle: "ソース内訳",
    directViews: "直接表示",
    uniqueDomains: "ユニークドメイン",
    uniqueLinks: "ユニークリンク",
    topSource: "上位外部ソース",
    topSourceShare: "表示回数シェア",
    noExternalSource: "外部ソースなし",
    externalLabel: "外部",
    nextSources: "次の 4 ソース",
    longTail: "ロングテール",
  },
  campaigns: {
    title: "キャンペーン",
    subtitle:
      "UTM キャンペーンのパフォーマンスとトラフィック属性を確認します。",
    tabSource: "ソース",
    tabMedium: "メディア",
    tabCampaign: "キャンペーン",
    tabTerm: "キーワード",
    tabContent: "コンテンツ",
    breakdownTitle: "UTM 内訳",
    notSet: "未設定",
    noTaggedTraffic: "選択範囲にタグ付きキャンペーントラフィックはありません。",
  },
  sessions: {
    title: "セッション",
    subtitle: "品質分析のためのセッション単位の詳細です。",
    search: "セッションを検索...",
    started: "開始時刻",
    sessionId: "セッション ID",
    visitor: "訪問者",
    anonymous: "匿名",
    entryPage: "入口ページ",
    exitPage: "離脱ページ",
    duration: "滞在時間",
    referrer: "参照元",
    location: "地域",
    os: "OS",
    browser: "ブラウザー",
    device: "デバイス",
    pageViews: "ページ表示",
    loadError: "セッションを読み込めません。",
    empty: "この時間範囲にセッションはありません。",
  },
  sessionDetail: {
    anonymous: "匿名",
    back: "セッションへ戻る",
    missing: "sessionId がありません。",
    notFound: "セッションが見つかりません。",
    loadError: "セッション詳細を読み込めません。",
    active: "アクティブ",
    inactive: "終了",
    status: "ステータス",
    duration: "滞在時間",
    screenViews: "画面表示",
    events: "イベント",
    bounce: "直帰",
    entryPath: "入口パス",
    exitPath: "離脱パス",
    referrerName: "参照元名",
    os: "OS",
    browser: "ブラウザー",
    device: "デバイス",
    screen: "画面",
    yes: "はい",
    no: "いいえ",
    uniquePages: "ユニークページ",
    firstEvent: "最初のイベント",
    lastEvent: "最後のイベント",
    sessionStarted: "セッション開始",
    pageview: "ページビュー",
    exitPage: "離脱ページ",
    customEvent: "カスタムイベント",
    eventTitleSeparator: ": ",
    visitDetailsTitle: "訪問詳細",
    visitDetailsSubtitle:
      "セッション開始、ページビュー、離脱、カスタムイベントを発生順に表示します。",
    location: "地域",
    visitorId: "訪問者 ID",
    sessionId: "セッション ID",
    referrerUrl: "参照元 URL",
    emptyEvents: "記録されたイベントはありません。",
    emptyCustomEvents: "カスタムイベントはありません。",
    sincePrevious: "前回から",
    geoLocationTitle: "地理的位置",
    performanceTitle: "現在のセッションパフォーマンス",
    range: "範囲",
  },
  events: {
    title: "カスタムイベント",
    subtitle:
      "イベント数、コンテキスト、ペイロードフィールド、元の発火記録を確認します。",
    detailTitle: "イベント詳細",
    detailSubtitle: "1 件のイベントのコンテキストとペイロードを確認します。",
    typeDetailSubtitle:
      "このイベントの推移、コンテキスト分布、ペイロード構造、発火記録を確認します。",
    backToEvents: "イベントへ戻る",
    totalEvents: "総イベント数",
    eventTypes: "イベント種別",
    sessions: "セッション",
    visitors: "訪問者",
    avgEventsPerSession: "平均イベント / セッション",
    shareOfAllEvents: "全イベント内シェア",
    triggerCount: "トリガー数",
    triggerVisitors: "トリガー訪問者",
    trendTitle: "イベント推移",
    topEvents: "上位イベント",
    recordsTitle: "イベント記録",
    fieldsTitle: "ペイロードフィールド",
    fieldsSubtitle: "値とメタデータを確認する項目を選択します。",
    fieldValuesTitle: "項目値",
    fieldValuesSubtitle:
      "選択した項目の記録と出現回数です。行をクリックするとフィルターできます。",
    fieldValuesEmpty: "この項目には値が記録されていません。",
    payloadFilter: "フィルター",
    payloadFilterTitle: "ペイロードフィルター",
    payloadFilterSubtitle:
      "1 行に 1 条件を追加します。== または != で条件を組み合わせます。",
    payloadFilterPlaceholder: 'path.value == "a"\nlevel != 0',
    payloadFilterApply: "フィルターを適用",
    payloadFilterClear: "フィルターをクリア",
    payloadFilterInvalid:
      "フィルター条件を解析できません。フィールドパス、演算子、値を確認してください。",
    expandField: "項目を展開",
    collapseField: "項目を折りたたむ",
    breakdownTitle: "コンテキスト内訳",
    search: "イベント名、ID、訪問者、セッション、ページを検索...",
    eventName: "イベント名",
    eventId: "イベント ID",
    occurredAt: "発生",
    receivedAt: "受信",
    page: "ページ",
    context: "コンテキスト",
    visitor: "訪問者",
    visit: "訪問",
    referrer: "参照元",
    location: "地域",
    browser: "ブラウザー",
    os: "OS",
    device: "デバイス",
    payload: "ペイロード",
    payloadFields: "ペイロードフィールド",
    values: "値",
    nodes: "ノード",
    occurrences: "出現回数",
    openVisitor: "訪問者を開く",
    openSession: "セッションを開く",
    copyJson: "JSON をコピー",
    copiedJson: "JSON をコピーしました。",
    copyJsonFailed: "JSON をコピーできません。",
    copyValue: "値をコピー",
    copiedValue: "値をコピーしました。",
    copyValueFailed: "値のコピーに失敗しました。",
    loadError: "イベントデータを読み込めません。",
    empty: "この範囲にカスタムイベントはありません。",
    emptyFields: "このイベントにペイロードフィールドはありません。",
    noEventName: "イベント名がありません。",
    loading: "読み込み中",
    other: "その他",
  },
  funnels: {
    title: "ファネル",
    subtitle: "複数ステップのユーザージャーニーでコンバージョンを測定します。",
    listTitle: "ファネル定義",
    listSubtitle:
      "再利用可能なシーケンスを作成し、現在のダッシュボード期間でコンバージョンを確認します。",
    create: "新規ファネル",
    createTitle: "ファネルを作成",
    createDescription:
      "ページビューまたはカスタムイベントの順序付きステップを少なくとも 2 つ定義してください。",
    nameLabel: "名前",
    namePlaceholder: "登録アクティベーション",
    stepsLabel: "ステップ",
    addStep: "ステップを追加",
    removeStep: "削除",
    stepTypePageview: "ページビュー",
    stepTypeEvent: "イベント",
    stepValueLabel: "値",
    pageviewPlaceholder: "/pricing",
    eventPlaceholder: "signup_started",
    save: "作成",
    creating: "作成中...",
    cancel: "キャンセル",
    delete: "削除",
    deleteTitle: "ファネルを削除",
    deleteDescription:
      "保存済みのファネル定義を削除します。過去の分析データは削除されません。",
    deleteConfirm: "ファネルを削除",
    deleting: "削除中...",
    empty: "ファネルはまだありません。",
    emptyHint:
      "ページビューとカスタムイベントからファネルを作成し、コンバージョンを追跡します。",
    loadError: "ファネルを読み込めません。",
    detailLoadError: "ファネル分析を読み込めません。",
    invalidFunnel: "名前と、完全なステップを少なくとも 2 つ追加してください。",
    created: "ファネルを作成しました。",
    createFailed: "ファネルを作成できません。",
    deleted: "ファネルを削除しました。",
    deleteFailed: "ファネルを削除できません。",
    overallConversion: "全体コンバージョン",
    startedSessions: "開始セッション",
    convertedSessions: "コンバージョンセッション",
    convertedVisitors: "コンバージョン訪問者",
    largestDropOff: "最大離脱",
    noDropOff: "離脱なし",
    step: "ステップ",
    sessions: "セッション",
    visitors: "訪問者",
    conversion: "コンバージョン",
    stepConversion: "ステップコンバージョン",
    dropOff: "離脱",
    updated: "更新",
  },
  visitors: {
    title: "訪問者",
    subtitle: "訪問者単位の内訳と直近状況です。",
    search: "訪問者を検索...",
    visitor: "訪問者",
    sessionId: "セッション ID",
    anonymous: "匿名",
    referrer: "参照元",
    location: "地域",
    os: "OS",
    browser: "ブラウザー",
    device: "デバイス",
    firstSeen: "初回確認",
    lastSeen: "最終確認",
    pageViews: "ページ表示",
    sessions: "セッション",
    loadError: "訪問者を読み込めません。",
    empty: "この時間範囲に訪問者はいません。",
  },
  visitorDetail: {
    anonymous: "匿名",
    back: "訪問者へ戻る",
    missing: "visitorId がありません。",
    notFound: "訪問者が見つかりません。",
    loadError: "訪問者詳細を読み込めません。",
    totalDuration: "合計滞在時間",
    events: "イベント",
    views: "ページビュー",
    uniquePages: "ユニークページ",
    avgPagesPerSession: "平均ページ / セッション",
    avgEventsPerSession: "平均イベント / セッション",
    avgStay: "平均滞在",
    firstSeen: "初回確認",
    lastSeen: "最終確認",
    daysActive: "アクティブ日数",
    avgTimeBetweenSessions: "セッション間の平均時間",
    activity: "アクティビティ",
    sessionRecords: "セッション記録",
    started: "開始時刻",
    visitor: "訪問者",
    duration: "滞在時間",
    referrer: "参照元",
    pageViews: "ページ表示",
    visitDetailsTitle: "訪問詳細",
    visitDetailsSubtitle:
      "この訪問者のセッション開始、ページビュー、離脱、カスタムイベントを発生順に表示します。",
    customEvents: "カスタムイベント",
    emptyEvents: "記録されたイベントはありません。",
    emptyCustomEvents: "カスタムイベントはありません。",
    emptySessions: "記録されたセッションはありません。",
    visitorId: "訪問者 ID",
    sessionId: "セッション ID",
    referrerName: "参照元名",
    referrerUrl: "参照元 URL",
    location: "地域",
    browser: "ブラウザー",
    os: "OS",
    device: "デバイス",
    screen: "画面",
    entryPath: "入口パス",
    exitPath: "離脱パス",
    sessionStarted: "セッション開始",
    pageview: "ページビュー",
    exitPage: "離脱ページ",
    customEvent: "カスタムイベント",
    eventTitleSeparator: ": ",
    sincePrevious: "前回から",
    geoLocationTitle: "地理的位置",
    performanceTitle: "現在の訪問者パフォーマンス",
    range: "範囲",
  },
  retention: {
    title: "リテンション",
    subtitle: "コホートベースの訪問者再訪分析です。",
    cohortDate: "コホート",
    cohortSize: "サイズ",
    periodLabel: "期間 {n}",
    matrixTitle: "リテンションマトリクス",
    matrixSubtitle:
      "各行は初回確認コホート、各列は後続期間に戻ってきた割合を示します。",
    cohortsMetric: "コホート",
    visitorsMetric: "コホート訪問者",
    periodOneMetric: "初回再訪",
    averageReturnMetric: "平均再訪",
    strongestCohortMetric: "最良コホート",
    eligibleVisitors: "対象訪問者",
    periodsAnalyzed: "分析対象期間",
    noEligibleCohorts: "履歴が不足しています",
    weightedAverage: "加重平均",
    legendLow: "低",
    legendHigh: "高",
    periodZero: "初回",
    empty: "この時間範囲には十分な再訪データがありません。",
    emptyHint:
      "より広い範囲を使うか、上部セレクターでより粗い間隔を選ぶと、リテンションの形が早く見えます。",
    loadError: "リテンションデータを読み込めません。",
    unavailableCell: "このコホートはまだこの期間に到達していません。",
    visitorsDetail: "訪問者",
    rateDetail: "リテンション",
    cohortDetail: "コホート",
    sizeDetail: "サイズ",
  },
  geo: {
    title: "地域分析",
    subtitle: "任意の地域におけるトラフィックパフォーマンスを確認します。",
    mapTitle: "リクエスト地域分布",
    countryLabel: "国",
    regionLabel: "地域",
    cityLabel: "都市",
    back: "戻る",
    viewOnWikipedia: "Wikipedia で見る",
    investigationNotice:
      "このデータは Web 由来のため、誤りを含む場合があります。",
    timezoneDeltaVsLocal: "現地時刻との差：{delta}",
    visitorCoordinates: "訪問者座標",
    ipNotice:
      "IP から推定した地域です。座標は概算であり、正確な住所を示すものではありません。",
    multipleNotice:
      "IP から推定した地域です。複数セッションのジャーニーは複数都市にまたがる場合があります。",
    investigation: {
      countryScopedLabel: "国 {label}",
      capital: "首都",
      population: "人口",
      gdp: "GDP",
      gdpPerCapita: "1 人あたり GDP",
      marketPenetration: "市場浸透率",
      region: "地域",
      currency: "通貨",
      phonecode: "国番号",
      timezone: "タイムゾーン",
      type: "種別",
      iso: "ISO",
      coordinates: "座標",
      unavailable: "N/A",
      gdpValue: "{value} 百万 USD",
      gdpPerCapitaValue: "{value} USD/人",
      gdpPerCapitaNearAverage: "{value} USD/人（世界平均付近）",
      gdpPerCapitaAboveAverage: "{value} USD/人（平均より {percent}% 高い）",
      gdpPerCapitaBelowAverage: "{value} USD/人（平均より {percent}% 低い）",
      marketPenetrationWindow: "{label}（{days} 日）",
      timezoneCount: "{count} タイムゾーン",
      typeLabels: {
        country: "国",
        state: "州",
        province: "省",
        prefecture: "都道府県",
        city: "市",
        county: "郡",
        district: "区",
        town: "町",
        village: "村",
        municipality: "自治体",
        territory: "領土",
        section: "区域",
        adm1: "行政レベル 1",
        adm2: "行政レベル 2",
        adm3: "行政レベル 3",
        adm4: "行政レベル 4",
        adm5: "行政レベル 5",
      },
    },
  },
  devices: {
    title: "デバイス",
    subtitle: "デバイス種別、OS、画面サイズごとに訪問者を把握します。",
    deviceShareTitle: "デバイス種別シェア",
    osShareTitle: "OS シェア",
    deviceTrendTitle: "デバイス種別推移",
    osTrendTitle: "OS 推移",
    screenDistributionTitle: "画面サイズ分布",
    screenDistributionSubtitle:
      "よく使われるビューポートとレスポンシブ境界を確認します。",
    screenBucketTitle: "ブレークポイント分類",
    screenPreviewTitle: "画面プレビュー",
    selectedViewportLabel: "選択中のビューポート",
    openSiteLabel: "サイトを開く",
    previewUnavailableLabel: "現在プレビュー可能な画面サイズはありません。",
    browserByDeviceTitle: "デバイス種別 × ブラウザー",
    osByDeviceTitle: "デバイス種別 × OS",
    otherLabel: "その他",
    screenBucketLabels: {
      phoneCompact: "小型スマートフォン",
      phone: "スマートフォン",
      tablet: "タブレット",
      laptop: "ノート PC",
      desktopWide: "ワイドデスクトップ",
      unclassified: "未分類",
    },
  },
  browsers: {
    title: "ブラウザー",
    subtitle: "ブラウザー分布とシェアです。",
    trendTitle: "ブラウザーシェア推移",
    engineTrendTitle: "エンジンシェア推移",
    versionBreakdownTitle: "ブラウザーバージョン内訳",
    osBreakdownTitle: "ブラウザー × OS",
    deviceTypeBreakdownTitle: "ブラウザー × デバイス種別",
    otherLabel: "その他",
    browserShareTitle: "ブラウザーシェア",
    engineShareTitle: "エンジンシェア",
    caniuseTitle: "機能互換性",
    caniuseSubtitle:
      "サイト訪問者のブラウザー構成に基づいて Web 機能の対応状況を確認します。",
    caniuseSearchPlaceholder: "Web 機能を検索...",
    caniuseHotFeatures: "人気の機能",
    caniuseTrendingFeatures: "最近変更された機能",
    caniuseSiteSupport: "あなたのサイト",
    caniuseGlobalSupport: "全世界",
    caniuseClearSelection: "クリア",
    caniuseNoMatch: "一致する機能がありません。",
    caniuseFullSupport: "完全対応",
    caniusePartialSupport: "部分対応",
    caniuseNoSupport: "非対応",
    radarTitle: "ブラウザーパフォーマンスレーダー",
    radarSubtitle: "上位ブラウザーを行動指標で比較します。",
    radarDuration: "滞在時間",
    radarEngagement: "エンゲージメント",
    radarDepth: "深さ",
    radarLoyalty: "ロイヤルティ",
    radarFrequency: "頻度",
    radarTraffic: "トラフィック",
  },
  performance: {
    title: "パフォーマンス",
    subtitle: "実際の訪問者パフォーマンスを指標、推移、パスごとに確認します。",
    chartTitle: "パフォーマンス推移",
    avgLabel: "平均",
    samplesLabel: "サンプル",
    p50Label: "P50",
    p75Label: "P75",
    p95Label: "P95",
    ttfb: "初回バイト到達時間",
    fcp: "初回コンテンツ描画",
    lcp: "最大コンテンツ描画",
    cls: "累積レイアウトシフト",
    inp: "次の描画までの操作応答時間",
    ttfbDescription:
      "ブラウザーがサーバーから最初のバイトを受け取るまでの待機時間を測定します。バックエンド遅延、ネットワーク遅延、キャッシュ効率を反映します。",
    fcpDescription:
      "最初のテキストまたは画像が描画された時点を測定します。訪問者がページの読み込み開始をどれだけ早く認識できるかを示します。",
    lcpDescription:
      "表示領域内で最大のコンテンツ要素が描画完了した時点を測定します。体感上の読み込み完了を示す主要な速度指標です。",
    clsDescription:
      "ページライフサイクル中に発生する予期しないレイアウト移動を測定します。値が低いほど表示が安定しています。",
    inpDescription:
      "ユーザー操作から次の描画までの遅延を測定します。読み込み後の操作応答性を反映します。",
    msUnit: "ms",
    secondsUnit: "秒",
    clsUnit: "スコア",
    score: "体験スコア",
    scoreDescription:
      "P75 の読み込み、安定性、操作指標を 0 から 100 の体験スコアに統合します。高いほど良好です。",
    great: "良好",
    needsImprovement: "改善が必要",
    poor: "不良",
    datasetTitle: "データセット概要",
    interpretationTitle: "現在の読み取り",
    currentReading:
      "{metric} の P75 は {value}、{samples} 件のサンプルに基づく体験スコアは {score} です。現在の判定：{status}。",
    metricThresholdText:
      "良好：{good} 以下、要改善：{good} から {poor}、不良：{poor} 超。",
    scoreThresholdText: "良好：90 超、要改善：50 から 90、不良：50 未満。",
    countryHealthTitle: "国・地域別の状態",
    countryHealthSubtitle:
      "国または地域ごとの {metric} の状態を境界色で示します。",
    pathsTitle: "パスパフォーマンス",
    pathsAnalyzedLabel: "分析対象パス",
    metricValueColumn: "P75 値",
    statusColumn: "状態",
  },
  share: {},
  siteSettings: {
    title: "サイト設定",
    subtitle: "このサイトの基本情報とライフサイクルを設定します。",
    editTitle: "サイト情報を更新",
    editSubtitle: "表示名とドメインを最新に保ちます。",
    nameLabel: "サイト名",
    domainLabel: "ドメイン",
    publicSharingTitle: "公開共有",
    publicSharingSubtitle:
      "このサイトの公開アクセスリンクを設定します。有効にすると、リンクを持つ全員が分析データを閲覧できます。",
    publicEnabledLabel: "公開アクセスを有効化",
    publicSlugLabel: "公開スラッグ",
    publicSlugPlaceholder: "例: my-site",
    publicSlugHint:
      "URL パス識別子をカスタマイズします。空のままなら自動生成されます。",
    publicLinkLabel: "公開リンク",
    publicLinkHint:
      "公開アクセスを有効にした後、このリンクで分析データを共有できます。",
    publicDisabledHint: "共有リンクは公開アクセスを有効にすると表示されます。",
    copiedLink: "リンクをコピーしました",
    trackingStrengthGroupTitle: "トラッキング強度",
    trackingStrengthDescription:
      "トラッカーが訪問者を識別する強さを選択します。",
    trackingStrengthLabel: "トラッキング強度モード",
    trackingStrengthStrong: "強",
    trackingStrengthSmart: "スマート",
    trackingStrengthWeak: "弱",
    trackingStrengthStrongDescription:
      "常に高精度の訪問者トラッキングを使用します。GDPR など、一部地域のプライバシー規制に抵触する可能性があります。",
    trackingStrengthSmartDescription:
      "訪問者の国に基づいてトラッキング強度を自動で切り替えます。",
    trackingStrengthWeakDescription:
      "常にトラッキング精度を下げます。同じ訪問者が複数回カウントされ、リテンション分析ができなくなる場合があります。",
    queryHashGroupTitle: "クエリとハッシュのトラッキング",
    queryHashGroupDescription:
      "クエリ文字列、URL ハッシュ、Do Not Track の扱いを制御します。",
    trackQueryParamsLabel: "クエリパラメータを追跡",
    trackHashLabel: "URL ハッシュを追跡",
    domainWhitelistTitle: "ドメイン許可リスト",
    domainWhitelistDescription:
      "現在のホスト名がこのリストに含まれる場合のみイベントを送信します。",
    domainWhitelistLabel: "ドメイン許可リスト（1 行に 1 件）",
    domainWhitelistPlaceholder: "example.com\nwww.example.com\n",
    domainWhitelistHint:
      "空にするとすべてのドメインを許可します。完全一致のみで、サブドメインは含みません。",
    pathBlacklistTitle: "パスブロックリスト",
    pathBlacklistDescription:
      "現在のパス名がブロック対象プレフィックスに一致するとイベントを送信しません。",
    pathBlacklistLabel: "パスブロックリスト（1 行に 1 件）",
    pathBlacklistPlaceholder: "/admin\n/private\n",
    pathBlacklistHint:
      "startsWith プレフィックス一致を使います。一致したパスは報告されません。",
    ignoreDoNotTrackLabel: "ブラウザーの Do Not Track を無視",
    autoTrackGroupTitle: "自動トラッキング",
    autoTrackGroupDescription: "自動イベント取得の挙動を制御します。",
    autoTrackOutboundLinksLabel: "外部リンククリックを自動追跡",
    autoTrackOutboundLinksHint:
      "有効にすると、外部ドメインへのリンククリックで outbound_click イベントを自動送信します。",
    performanceGroupTitle: "パフォーマンストラッキング",
    performanceGroupDescription:
      "1 つのサンプリング率で Web パフォーマンス指標の収集を制御します。",
    performanceSampleRateLabel: "パフォーマンスサンプリング率（%）",
    performanceSampleRateHint:
      "サンプリングされた訪問では、離脱時に TTFB、FCP、LCP、CLS、INP を記録します。0 で無効、100 で全量収集です。",
    booleanOn: "オン",
    booleanOff: "オフ",
    loadingSettings: "スクリプト設定を読み込み中...",
    saveTracking: "トラッキング設定を保存",
    savingTracking: "トラッキング設定を保存中...",
    save: "変更を保存",
    saving: "保存中...",
    transferTitle: "別のチームへ移管",
    transferSubtitle: "このサイトを管理可能な別チームへ移動します。",
    transferTeamLabel: "移管先チーム",
    transfer: "サイトを移管",
    transferring: "移管中...",
    scriptTitle: "トラッキングスクリプトを設置",
    scriptSubtitle:
      "分析収集を開始するには、このスクリプトを Web サイトに追加してください。",
    scriptHint:
      "</head> の前を推奨します。必要なら </body> の前にも配置できますが、各ページで 1 回だけ読み込まれるようにしてください。",
    copyScript: "スクリプトをコピー",
    copiedScript: "スクリプトをコピーしました。",
    loadingScript: "スクリプトを読み込み中...",
    scriptUnavailable: "現在スクリプトを利用できません。",
    deleteTitle: "サイトを削除",
    deleteSubtitle: "この操作により、サイトはこのチームから削除されます。",
    delete: "サイトを削除",
    deleting: "削除中...",
    deleteConfirm: "この操作は元に戻せません。続行しますか？",
    toasts: {
      saved: "サイト設定を保存しました。",
      saveFailed: "サイト設定を保存できません。",
      transferred: "サイトを移管しました。",
      transferFailed: "サイトを移管できません。",
      scriptLoadFailed: "スクリプトスニペットを読み込めません。",
      settingsLoadFailed: "スクリプト設定を読み込めません。",
      settingsPropagationHint:
        "エッジノードへのグローバル反映には最大 1 時間かかる場合があります。",
      deleted: "サイトを削除しました。",
      deleteFailed: "サイトを削除できません。",
      invalidInput: "有効なサイト名とドメインを入力してください。",
    },
  },
  accountSettings: {
    title: "アカウント設定",
    subtitle:
      "個人情報、ログインパスワード、ダッシュボードのタイムゾーンを管理します。",
    profileTitle: "個人情報",
    profileDescription: "表示名、ユーザー名、メールアドレスを更新します。",
    nicknameLabel: "表示名",
    nicknamePlaceholder: "例: プロダクトアナリスト",
    usernameLabel: "ユーザー名",
    usernamePlaceholder: "例: alex",
    usernameDescription: "ユーザー名はログインにも使用できます。",
    emailLabel: "メール",
    emailPlaceholder: "name@example.com",
    invalidProfile: "有効なユーザー名とメールアドレスを入力してください。",
    profileSave: "詳細を保存",
    profileSaving: "保存中...",
    profileSaved: "個人情報を保存しました。",
    profileSaveFailed: "個人情報を保存できません。",
    passwordTitle: "ログインパスワード",
    passwordDescription: "現在のアカウントのパスワードを変更します。",
    currentPasswordLabel: "現在のパスワード",
    newPasswordLabel: "新しいパスワード",
    confirmPasswordLabel: "新しいパスワードの確認",
    currentPasswordRequired: "現在のパスワードを入力してください。",
    passwordTooShort: "新しいパスワードは 8 文字以上にしてください。",
    passwordMismatch: "新しいパスワードが一致しません。",
    passwordSave: "パスワードを変更",
    passwordSaving: "変更中...",
    passwordSaved: "パスワードを変更しました。",
    passwordSaveFailed: "パスワードを変更できません。",
    preferredLanguageTitle: "通知言語",
    preferredLanguageDescription: "定期通知メールで使用する言語を選択します。",
    preferredLanguageLabel: "メール言語",
    preferredLanguageDefault: "デフォルト",
    preferredLanguageEnglish: "英語",
    preferredLanguageChinese: "中国語",
    preferredLanguageJapanese: "日本語",
    preferredLanguageSaved: "通知言語を保存しました。",
    preferredLanguageSaveFailed: "通知言語を保存できません。",
    timeZoneTitle: "レポートタイムゾーン",
    timeZoneDescription:
      "カレンダー範囲と集計バケットは、ダッシュボード全体でこのタイムゾーンを使用します。",
    activeTimeZone: "有効なタイムゾーン",
    browserTimeZone: "ブラウザーのタイムゾーン",
    browserUnavailable: "検出されません",
    browserSource: "ブラウザー",
    manualSource: "手動",
    preferenceLabel: "タイムゾーン設定",
    preferenceDescription:
      "ブラウザーモードはこのデバイスに従います。手動モードはすべてのデバイスで同じタイムゾーンを使います。",
    useBrowser: "ブラウザーのタイムゾーンを使用",
    useCustom: "タイムゾーンを選択",
    customTimeZoneLabel: "タイムゾーン",
    customTimeZoneDescription: "対応している IANA タイムゾーンから選択します。",
    invalidTimeZone: "有効な IANA タイムゾーンを選択してください。",
    save: "設定を保存",
    saving: "保存中...",
    saved: "タイムゾーン設定を保存しました。",
    saveFailed: "タイムゾーン設定を保存できません。",
  },
  notificationCenter: {
    title: "通知センター",
    subtitle: "すべての通知とレポートを確認します。",
    empty: "通知はまだありません。",
    loading: "通知を読み込み中",
    markRead: "既読にする",
    markAllRead: "すべて既読にする",
    refresh: "更新",
    attention: "要対応",
    loadFailed: "通知を読み込めません。",
    markReadFailed: "通知を既読にできません。",
    markAllReadSuccess: "通知を既読にしました。",
    markAllReadFailed: "通知を既読にできません。",
    ruleFilterActive: "このルールで作成された通知を表示しています。",
    ruleFilterClear: "ルールフィルターをクリア",
    sections: {
      importantTitle: "重要な通知",
      importantDescription: "{count} 件の未読要対応項目があります。",
      importantEmpty: "現在、重要な通知はありません。",
      reportsTitle: "レポート",
      reportsDescription: "通知ルールで生成された定期レポートを確認します。",
      reportsEmpty: "現在、レポートはありません。",
    },
    tabs: {
      all: "すべて",
      unread: "未読",
      attention: "要対応",
      report: "レポート",
    },
    tabDescriptions: {
      all: "メッセージ総数",
      unread: "確認待ち",
      attention: "対応が必要",
      report: "定期レポート",
    },
    messageTypes: {
      report: "レポート",
      milestone: "マイルストーン",
      threshold: "しきい値",
      change: "変化",
      health: "健全性",
      system: "システム",
      test: "テスト",
    },
    severities: {
      info: "情報",
      success: "成功",
      warning: "警告",
      critical: "重大",
    },
    deliveryStatuses: {
      created: "作成済み",
      sending: "送信中",
      sent: "送信済み",
      partial: "一部完了",
      failed: "失敗",
      skipped: "スキップ",
    },
    channels: {
      inApp: "アプリ内",
      email: "メール",
    },
    channelStatuses: {
      sent: "送信済み",
      skipped: "スキップ",
      failed: "失敗",
      created: "作成済み",
    },
    emailSkipReasons: {
      user_preference_disabled: "ユーザー設定でメールが無効です",
      system_email_unconfigured: "システムメールが設定されていません",
      recipient_email_invalid: "宛先メールアドレスが無効です",
      secret_decryption_failed: "保存済みメール認証情報を復号できません",
      provider_failed: "プロバイダーがメッセージを拒否しました",
      network_failed: "メールプロバイダーに接続できません",
      unknown: "不明な理由",
    },
    emailAttempts: "試行回数：{count}",
    emailRetryCount: "再試行：{count}",
    emailDuration: "{duration} ms",
    typeFilterLabel: "種別",
    severityFilterLabel: "重要度",
    allTypes: "すべての種別",
    allSeverities: "すべての重要度",
    preferencesTitle: "通知設定",
    preferencesDescription:
      "これらの設定は、メール配信と、どのメッセージを要対応として未読のままにするかを制御します。",
    emailNotificationsLabel: "メール通知",
    emailNotificationsDescription: "ルールが発火したときにメールを送信します。",
    reportsUnreadLabel: "レポートを未読にする",
    reportsUnreadDescription: "作成後のレポートを未読のままにします。",
    milestonesUnreadLabel: "マイルストーンを未読にする",
    milestonesUnreadDescription: "未読状態をマイルストーン用に残します。",
    alertsUnreadLabel: "アラートを未読にする",
    alertsUnreadDescription:
      "しきい値アラートと健全性アラートを未読のままにします。",
    preferencesSaved: "通知設定を保存しました。",
    preferencesSaveFailed: "通知設定を保存できません。",
    detailFields: {},
  },
  notificationEmail: {
    common: {
      brand: "InsightFlare",
      date: "日付",
      coreMetrics: "主要指標",
      topPages: "上位ページ",
      topReferrers: "上位参照元",
      views: "表示回数",
      visitors: "訪問者数",
      sessions: "セッション数",
      visits: "回の訪問",
      viewsUnit: "回の表示",
      direct: "直接アクセス",
      metric: "指標",
      window: "期間",
      currentValue: "現在値",
      previousValue: "前回値",
      threshold: "しきい値",
      milestone: "マイルストーン",
      change: "変化",
      mode: "モード",
      lastSeen: "最終受信",
      never: "未受信",
      noPageData: "ページデータはありません。",
      noReferrerData: "参照元データはありません。",
      footer: "このメールは InsightFlare の通知システムから送信されました。",
      fallbackSubject: "InsightFlare 通知",
      trackingHint:
        "トラッキングスクリプトが正しく設置されているか、またはサイトに引き続きトラフィックがあるかを確認してください。",
      severity: {
        info: "情報",
        success: "成功",
        warning: "警告",
        critical: "重大",
      },
    },
    test: {
      subject: "InsightFlare 通知テスト",
      title: "InsightFlare 通知テスト",
      summary: "これは InsightFlare からのテスト通知です。",
      body: "これは InsightFlare からのテスト通知です。メールが設定され有効になっている場合、このメッセージは Resend の配信も確認します。",
    },
    report: {
      subject: "{site} の{periodLabel}トラフィックレポート",
      title: "{site} の{periodLabel}トラフィックレポート",
      summary: "{date}：訪問者 {visitors}、表示回数 {views}。",
      periodLabels: {
        daily: "日次",
        weekly: "週次",
        monthly: "月次",
        quarterly: "四半期",
        yearly: "年次",
      },
    },
    milestone: {
      subject: "{site} が {bucket} {metric} に到達しました",
      title: "{site} が {bucket} {metric} に到達しました",
      summary:
        "トラフィックのマイルストーンに到達しました：{bucket} {metric}。",
    },
    threshold: {
      subject: "{site} のトラフィックがしきい値に達しました",
      title: "{site} のトラフィックがしきい値に達しました",
      summary:
        "{window}の{metric}は {value} で、しきい値 {operator} {target} に一致しています。",
      metricLabels: {
        views: "表示回数",
        visitors: "訪問者数",
        sessions: "セッション数",
      },
      windows: {
        last_1h: "過去 1 時間",
        last_24h: "過去 24 時間",
        yesterday: "昨日",
      },
    },
    health: {
      subject: "{site} は {hours} 時間データを受信していません",
      title: "{site} は {hours} 時間データを受信していません",
      noHistory:
        "過去のトラフィックデータが見つかりません。トラッキングスクリプトが設置されているか確認してください。",
    },
    change: {
      subject: "{site} のトラフィック変化を検出しました",
      title: "{site} のトラフィック変化を検出しました",
      summary: "{window}の{metric}が {change} 変化しました。",
    },
  },
  runtimeConfigError: {
    title: "ランタイム設定が必要です",
    eyebrow: "デプロイを一時停止中",
    heading:
      "UI を読み込む前に、InsightFlare にはランタイムシークレットが 1 つ必要です。",
    description:
      "アプリは起動していますが、現在のランタイム環境で必須の root secret を取得できないため、ダッシュボードへのアクセスを一時的にブロックしています。",
    requiredTitle: "必須のランタイムシークレット",
    requiredDescription:
      "Cloudflare のランタイムシークレットに、次の値のいずれかを少なくとも 1 つ設定してください。",
    secretHint:
      "MAIN_SECRET を推奨します。既存のデプロイでは DAILY_SALT_SECRET も引き続き使用できます。",
    commandTitle: "Cloudflare コマンド",
    commandDescription:
      "プロジェクトの補助コマンドで推奨シークレットを追加し、その後再デプロイしてください。",
    quickStartHint:
      "または、GitHub README の Quick Start セクションを参照してこの変数を設定してください。",
    docsLabel: "GitHub を開く",
    homeLabel: "ダッシュボードを再試行",
  },
  login: {
    title: "サインイン",
    subtitle: "InsightFlare アカウントを使用します。",
    username: "ユーザー名またはメール",
    password: "パスワード",
    signIn: "サインイン",
    invalidCredentials: "ユーザー名またはパスワードが正しくありません。",
  },
  accountLinks: {
    invite: {
      title: "チーム招待",
      subtitle: "招待を承認してこのチームに参加します。",
      loading: "招待を読み込み中...",
      missingToken: "招待トークンがありません。",
      loadFailed: "招待を読み込めません。",
      accept: "招待を承認",
      accepting: "承認中...",
      accepted: "招待を承認しました。",
      acceptFailed: "招待を承認できません。",
      signIn: "承認するにはサインイン",
      signedInNotice:
        "サインイン済みです。承認すると、このチームにあなたのアカウントが追加されます。",
      teamLabel: "チーム",
      roleLabel: "権限",
      emailLabel: "招待先メール",
      accountEmailLabel: "アカウントメール",
      anyEmail: "任意のアカウント",
      expiresLabel: "有効期限",
      usernameLabel: "ユーザー名",
      nameLabel: "表示名",
      passwordLabel: "パスワード",
      roles: {
        admin: "管理者",
        member: "メンバー",
      },
    },
    resetPassword: {
      title: "パスワードをリセット",
      subtitle: "このアカウントの新しいパスワードを設定します。",
      loading: "リセットリンクを読み込み中...",
      missingToken: "リセットトークンがありません。",
      loadFailed: "リセットリンクを読み込めません。",
      reset: "パスワードをリセット",
      resetting: "リセット中...",
      resetDone:
        "パスワードをリセットしました。新しいパスワードでサインインしてください。",
      resetFailed: "パスワードをリセットできません。",
      signIn: "サインインへ戻る",
      accountLabel: "アカウント",
      emailLabel: "メール",
      expiresLabel: "有効期限",
      passwordLabel: "新しいパスワード",
      confirmPasswordLabel: "パスワード確認",
      passwordTooShort: "パスワードは 8 文字以上にしてください。",
      passwordMismatch: "パスワードが一致しません。",
    },
  },
  empty: {
    noTeams: "利用可能なチームはまだありません。",
    noSites: "このチームには利用可能なサイトがありません。",
    siteNotFound: "チームまたはサイトが見つかりません。",
  },
  actions: {
    logout: "ログアウト",
    switchToEnglish: "English",
    switchToChinese: "中文",
    switchToJapanese: "日本語",
    switchToLight: "ライト",
    switchToDark: "ダーク",
  },
  teamSelect: {
    groupLabel: "チーム",
    groups: {
      created: "作成したチーム",
      managed: "管理中のチーム",
      member: "所属チーム",
      system: "システムチーム",
    },
    createHint: "チームを作成",
    createTitle: "チームを作成",
    createDescription: "作成後、新しいチームに切り替わります。",
    nameLabel: "チーム名",
    namePlaceholder: "例: Growth Team",
    slugLabel: "チームスラッグ（任意）",
    slugPlaceholder: "例: growth-team",
    create: "作成",
    creating: "作成中...",
    cancel: "キャンセル",
    invalidName: "チーム名は 2 文字以上にしてください。",
    createFailed: "チームを作成できません。もう一度お試しください。",
    createSuccess: "チームを作成しました。",
  },
  teamManagement: {
    stats: {
      sites: "サイト",
      members: "メンバー",
    },
    toasts: {
      teamSaved: "チーム設定を保存しました。",
      teamSaveFailed: "チーム設定を保存できません。",
      teamDeleted: "チームを削除しました。",
      teamDeleteFailed: "チームを削除できません。",
      memberRemoved: "メンバーを削除しました。",
      memberRemoveFailed: "メンバーを削除できません。",
      roleChanged: "メンバー権限を更新しました。",
      roleChangeFailed: "メンバー権限を更新できません。",
      siteAccessChanged: "メンバーのサイト権限を更新しました。",
      siteAccessChangeFailed: "サイト権限を更新できません。",
      invalidTeamName: "チーム名は 2 文字以上にしてください。",
      inviteCreated: "招待リンクを作成しました。",
      inviteCreateFailed: "招待リンクを作成できません。",
      inviteRevoked: "招待を取り消しました。",
      inviteRevokeFailed: "招待を取り消せません。",
      inviteCopied: "招待リンクをコピーしました。",
      inviteCopyFailed: "招待リンクをコピーできません。",
      invalidInviteEmail: "有効な招待メールを入力してください。",
      invalidInviteExpiry: "招待の有効期限は 1 時間以上にしてください。",
      ownerTransferred: "所有権を移譲しました。",
      ownerTransferFailed: "所有権を移譲できません。",
      invalidTransferTarget: "新しい所有者を選択してください。",
    },
    sites: {
      title: "サイトダッシュボード",
      subtitle: "このチーム内すべてのサイトを集計したトラフィックビューです。",
      aggregateTitle: "総訪問数",
      pagesPerSession: "ページ / セッション",
      noSites: "このチームには利用可能なサイトがありません。",
      openAnalytics: "アナリティクスを開く",
    },
    widgets: {
      title: "ウィジェット",
      subtitle: "ウィジェット機能を開発中です。",
      underConstruction: "準備中",
    },
    notifications: {
      title: "イベント通知",
      subtitle: "このチームのイベント通知ルールを管理します。",
      empty: "このチームにはイベント通知ルールがありません。",
      forbiddenTitle: "通知ルールはチーム管理者が管理します",
      forbiddenDescription:
        "自分の通知を確認し、個人の通知設定を更新することはできます。",
      rulesTitle: "通知ルール",
      enabledCount: "このチームで {count} 件のルールが有効です。",
      loadingRules: "通知ルールを読み込み中",
      deliveryTestTitle: "配信テスト",
      deliveryTestDescription:
        "あなた宛てのアプリ内通知を 1 件作成し、利用可能な場合はメール送信も試行します。",
      inAppTestHint: "アプリ内通知を送信します。",
      emailTestConfiguredHint: "テストメールを送信します。",
      emailTestUnconfiguredHint:
        "このシステムではメール送信が設定されていません。追加するには管理者に連絡してください。",
      sendTestNotification: "テスト通知を送信",
      loadRulesFailed: "通知ルールを読み込めません。",
      testNotificationSent: "テスト通知を送信しました。",
      sendTestNotificationFailed: "テスト通知を送信できません。",
      createRule: "ルールを作成",
      editRule: "ルールを編集",
      dialogDescription: "このチームの基本通知ルールを設定します。",
      ruleInfoSection: "ルール情報",
      scheduleSection: "スケジュール",
      sendScheduleSection: "送信時刻",
      checkSection: "チェック頻度",
      conditionSection: "条件",
      deliverySection: "配信",
      summarySection: "概要",
      liveSummaryDescription: "このルールの実行方法を確認します。",
      nameLabel: "名前",
      siteLabel: "サイト",
      chooseSite: "サイトを選択",
      ruleTypeLabel: "ルール種別",
      recipientLabel: "受信者",
      enabledLabel: "有効",
      enabledHint: "このルールを実行",
      scheduleLabel: "スケジュール",
      timeLabel: "時刻",
      timezoneLabel: "タイムゾーン",
      intervalLabel: "間隔",
      dayLabel: "曜日",
      dayOfMonthLabel: "日",
      monthLabel: "月",
      reportPeriodLabel: "レポート期間",
      milestoneEveryLabel: "マイルストーンごと",
      matchLabel: "一致条件",
      matchAll: "すべて",
      matchAny: "いずれか",
      changeValueLabel: "変化量",
      changeModeLabel: "変化モード",
      changeModePercent: "パーセント",
      changeModeAbsolute: "絶対値",
      addCondition: "条件を追加",
      removeCondition: "削除",
      conditionItemTitle: "条件 {index}",
      metricLabel: "指標",
      windowLabel: "時間枠",
      operatorLabel: "演算子",
      valueLabel: "値",
      cooldownLabel: "クールダウン",
      cooldownDescription:
        "このクールダウン期間中、レポートは再送信されません。",
      noDataHoursLabel: "データなし時間",
      pleaseChooseSite: "サイトを選択してください。",
      pleaseChooseRecipients: "受信者を 1 人以上選択してください。",
      ruleCreated: "ルールを作成しました。",
      ruleUpdated: "ルールを更新しました。",
      createRuleFailed: "ルールを作成できません。",
      updateRuleFailed: "ルールを更新できません。",
      deleteConfirm: "{name} を削除しますか？",
      ruleDeleted: "ルールを削除しました。",
      deleteRuleFailed: "ルールを削除できません。",
      lastChecked: "最終チェック",
      actions: "操作",
      edit: "編集",
      enable: "有効化",
      disable: "無効化",
      delete: "削除",
      saveRule: "ルールを保存",
      emailPreview: "メールプレビュー",
      preview: "プレビュー",
      runNow: "今すぐ実行",
      previewFailed: "ルールをプレビューできません。",
      runFailed: "ルールを実行できません。",
      runResultToast:
        "{messages} 件のメッセージを作成しました。メール送信 {sent} 件、失敗 {failed} 件。",
      previewDialogTitle: "ルールプレビュー",
      previewDialogDescription:
        "メッセージ作成やメール送信をせずに、このルールを評価します。",
      coolingDownUntil: "{time} までクールダウン中",
      scheduleDaily: "毎日 {time}",
      scheduleWeekly: "毎週 {day} {time}",
      scheduleMonthly: "毎月 {day} 日 {time}",
      scheduleQuarterly: "四半期ごと {day} 日 {time}",
      scheduleYearly: "毎年 {month}/{day} {time}",
      scheduleInterval: "{minutes} 分ごと",
      scheduleCustom: "カスタム",
      conditionReport: "{period} レポート",
      conditionMilestone: "{metric} が {step} ごと",
      conditionThreshold: "{window} {metric} {operator} {value}",
      conditionChange: "{window} {metric} 変化 {operator} {value}",
      conditionHealth: "{hours}h データなし",
      summaryWhenConditions:
        "次の条件のうち {combinator} が一致したら、{type} 通知を送信します：",
      summaryWhenSingleCondition:
        "この条件が一致したら、{type} 通知を送信します：",
      summaryConditionThreshold: "{window} {metric} {operator} {value}",
      summaryConditionChange:
        "{window} {metric} {mode} 変化 {operator} {value}",
      summaryReportSchedule: "{period}：{schedule}",
      summaryMilestoneCondition: "{metric} が {step} ごとに到達",
      summaryHealthCondition: "{hours} 時間データなし",
      defaultNames: {
        report: "{site} 日次レポート",
        milestone: "{site} トラフィックマイルストーン",
        threshold: "{site} トラフィックしきい値",
        change: "{site} トラフィック変化",
        health: "{site} 健全性チェック",
      },
      columns: {
        name: "名前",
        type: "種別",
        site: "サイト",
        recipient: "受信者",
        schedule: "スケジュール",
        condition: "条件",
        nextRun: "次回実行",
        status: "ステータス",
      },
      status: {
        enabled: "有効",
        disabled: "無効",
      },
      nextRunStates: {
        disabled: "無効",
        coolingDown: "クールダウン中",
        dueNow: "期限到来",
      },
      previewFields: {
        status: "ステータス",
        summary: "概要",
        title: "タイトル",
        htmlPreview: "HTML プレビュー",
        bodyText: "本文テキスト",
        data: "データ",
        createdAt: "作成日時",
        updatedAt: "更新日時",
        loadingContent: "評価済みレポート内容を読み込み中",
        noHtmlPreview: "このプレビューには HTML コンテンツがありません。",
      },
      ruleTypes: {
        report: "レポート",
        milestone: "マイルストーン",
        threshold: "しきい値",
        change: "変化",
        health: "健全性",
        test: "テスト",
      },
      ruleTypeDescriptions: {
        report: "スケジュールに従ってサイト概要を送信",
        milestone: "指標が各ステップに到達したときに通知",
        threshold: "指標が上限または下限を超えたときに通知",
        change: "前期間比の変動を通知",
        health: "トラッキングが途絶えたときに通知",
      },
      recipientModes: {
        creator: "作成者",
        team_admins: "チーム管理者",
        all_team_members: "全メンバー",
        users: "選択したユーザー",
      },
      recipientKindLabel: "受信者種別",
      recipientPresetLabel: "プリセット",
      customRecipientsEmpty: "受信者が選択されていません",
      noTeamMembers: "利用可能なチームメンバーがいません。",
      recipientKinds: {
        preset: "プリセット",
        custom: "カスタム",
      },
      scheduleKinds: {
        daily: "毎日",
        weekly: "毎週",
        monthly: "毎月",
        quarterly: "四半期ごと",
        yearly: "毎年",
        interval: "間隔",
      },
      reportPeriods: {
        daily: "日次レポート",
        weekly: "週次レポート",
        monthly: "月次レポート",
        quarterly: "四半期レポート",
        yearly: "年次レポート",
      },
      cooldownUnits: {
        minutes: "分",
        hours: "時間",
        days: "日",
      },
      intervalOptions: {
        every30Minutes: "30 分ごと",
        everyHour: "1 時間ごと",
        every6Hours: "6 時間ごと",
        every12Hours: "12 時間ごと",
        everyDay: "毎日",
        every7Days: "7 日ごと",
        every30Days: "30 日ごと",
      },
      weekDays: ["日", "月", "火", "水", "木", "金", "土"],
      metrics: {
        views: "表示回数",
        visitors: "訪問者",
        sessions: "セッション",
      },
      windows: {
        last_1h: "直近 1 時間",
        last_24h: "直近 24 時間",
        yesterday: "昨日",
      },
      emailPreviewPage: {
        title: "通知メールプレビュー",
        subtitle:
          "メッセージ作成や Resend 送信を行わずに通知メールをレンダリングします。",
        typeLabel: "プレビュー種別",
        localeLabel: "プレビューロケール",
        formatLabel: "プレビュー形式",
        html: "HTML",
        text: "プレーンテキスト",
        json: "JSON",
        refresh: "プレビュー",
        loading: "プレビューをレンダリング中...",
        loadFailed: "メールプレビューをレンダリングできません。",
        subject: "件名",
      },
    },
    publicLinks: {
      title: "公開リンク",
      subtitle: "このチームの公開共有リンクを管理します。",
      enabled: "有効",
      disabled: "無効",
      disabledHint:
        "公開アクセスは無効です。有効にするにはサイト設定を開いてください。",
      viewSettings: "設定を表示",
      copyLink: "リンクをコピー",
      linkCopied: "リンクをコピーしました",
      noSites: "このチームにはまだサイトがありません。",
      columns: {
        site: "サイト",
        domain: "ドメイン",
        publicUrl: "公開リンク",
        status: "ステータス",
        action: "操作",
      },
    },
    apiKeys: {
      title: "API キー",
      subtitle: "このチームの API アクセスキーを管理します。",
      empty: "このチームには API キーがありません。",
      create: "キーを作成",
      creating: "作成中...",
      createTitle: "API キーを作成",
      createSubtitle: "この連携に必要な最小権限を選択してください。",
      nameLabel: "キー名",
      namePlaceholder: "本番同期",
      scopesTitle: "権限",
      scopesDescription:
        "API キーでメンバー、ユーザー、所有権、他のキーを管理することはできません。",
      siteScopeTitle: "サイトアクセス",
      siteScopeDescription:
        "未選択の場合、このチームの現在および将来のすべてのサイトが対象です。",
      allSites: "すべてのサイト",
      expirationLabel: "有効期限",
      expiration30: "30 日",
      expiration90: "90 日",
      expiration180: "180 日",
      expiration365: "365 日",
      expirationNever: "なし",
      oneTimeSecretTitle: "今すぐこのキーをコピー",
      oneTimeSecretDescription:
        "完全なキーは一度だけ表示されます。このダイアログを閉じる前に保存してください。",
      copySecret: "キーをコピー",
      revoke: "取り消し",
      rotate: "ローテーション",
      revokeConfirm: "この API キーを今すぐ取り消しますか？",
      rotateConfirm:
        "この API キーをローテーションしますか？古いキーは直ちに取り消されます。",
      neverExpires: "有効期限なし",
      notUsed: "未使用",
      loading: "API キーを読み込み中...",
      loadFailed: "API キーを読み込めません。",
      invalidInput: "名前を入力し、少なくとも 1 つの権限を選択してください。",
      createFailed: "API キーを作成できません。",
      revokeFailed: "API キーを取り消せません。",
      rotateFailed: "API キーをローテーションできません。",
      copied: "コピーしました",
      status: {
        active: "有効",
        expired: "期限切れ",
        revoked: "取り消し済み",
      },
      scopes: {
        analyticsRead: "分析の読み取り",
        siteRead: "サイトの読み取り",
        siteWrite: "サイトの書き込み",
        siteConfigRead: "設定の読み取り",
        siteConfigWrite: "設定の書き込み",
      },
      scopeDescriptions: {
        analyticsRead: "訪問、訪問者、ページビュー、その他の分析データを表示",
        siteRead: "サイト一覧とサイト詳細を表示",
        siteWrite: "サイトを作成、更新、削除",
        siteConfigRead:
          "トラッキングコードやドメイン許可リストなどのサイト設定を表示",
        siteConfigWrite:
          "トラッキング強度やパスブロックリストなどのサイト設定を変更",
      },
      scopeGroups: {
        analytics: "分析",
        site: "サイト",
        siteConfig: "サイト設定",
      },
      columns: {
        name: "名前",
        scopes: "権限",
        sites: "サイト",
        expires: "有効期限",
        lastUsed: "最終使用",
        status: "ステータス",
        action: "操作",
      },
    },
    settings: {
      title: "設定",
      subtitle: "このチームの表示名とスラッグを更新します。",
      nameLabel: "チーム表示名",
      slugLabel: "チームスラッグ",
      save: "設定を保存",
      saving: "保存中...",
      delete: "チームを削除",
      deleting: "削除中...",
      deleteConfirm:
        "このチームとすべてのデータを削除しますか？この操作は元に戻せません。",
      transferTitle: "所有権を移譲",
      transferSubtitle:
        "チーム所有権を別のメンバーへ移譲します。現在の所有者は管理者に降格されます。",
      transferTargetLabel: "新しい所有者",
      transferTargetPlaceholder: "チームメンバーを選択",
      transfer: "所有権を移譲",
      transferring: "移譲中...",
      transferConfirm:
        "この操作は元に戻せません。所有権は失いますが、管理者権限は残ります。続行しますか？",
      noTransferableMembers:
        "移譲先にできる他のメンバーがいません。まずメンバーを追加してください。",
    },
    members: {
      title: "メンバー",
      subtitle: "メンバーを招待、または既存メンバーを削除します。",
      remove: "削除",
      noMembers: "このチームにはメンバーがいません。",
      invitesTitle: "招待リンクを作成",
      invitesSubtitle:
        "ユーザーは招待を承認した後にのみこのチームへ参加します。",
      inviteEmailLabel: "メール制限（任意）",
      inviteEmailPlaceholder: "user@example.com",
      inviteExpiresLabel: "有効期限（時間）",
      createInvite: "招待リンクを作成",
      creatingInvite: "作成中...",
      copyInvite: "リンクをコピー",
      inviteLinksTitle: "招待リンク",
      inviteLinksSubtitle:
        "招待ステータスを確認し、有効なリンクを取り消します。",
      noInvites: "このチームには招待リンクがありません。",
      anyEmail: "任意のメール",
      revokeInvite: "招待を取り消し",
      siteAccessLabel: "サイト権限",
      siteAccessAll: "全サイト",
      siteAccessRestricted: "制限付き",
      siteAccessSelected: "{count} サイト選択済み",
      siteAccessDescription:
        "全サイトのままにするか、このメンバーがアクセスできるサイトを選択します。",
      siteAccessAdmins: "管理者はこのチームの全サイトにアクセスできます。",
      siteAccessDialogTitle: "サイト権限を編集",
      saveSiteAccess: "権限を保存",
      cancelSiteAccess: "キャンセル",
      noSitesForAccess: "このチームにはまだサイトがありません。",
      inviteStatuses: {
        active: "有効",
        used: "使用済み",
        revoked: "取り消し済み",
        expired: "期限切れ",
      },
      columns: {
        name: "名前",
        username: "ユーザー名",
        email: "メール",
        inviteCode: "招待トークン",
        role: "権限",
        siteAccess: "サイト権限",
        joinedAt: "参加日時",
        createdAt: "作成日時",
        expiresAt: "有効期限",
        usedAt: "使用日時",
        status: "ステータス",
        action: "操作",
      },
      roleLabels: {
        owner: "所有者",
        admin: "管理者",
        member: "メンバー",
      },
    },
  },
  managementNav: {
    users: "ユーザー管理",
    sites: "サイト管理",
    teams: "チーム管理",
    versionUpdates: "バージョン更新",
    scheduledTasks: "スケジュールタスク",
    requestObservation: "リクエスト監視",
    systemPerformance: "システム性能",
    systemSettings: "システム設定",
  },
  managementPages: {
    versionUpdates: {
      subtitle: "公開済み InsightFlare リリースと稼働中ビルドを確認します。",
      empty: "バージョン更新記録はまだありません。",
      currentVersion: "現在のバージョン",
      latestVersion: "最新リリース",
      currentCommit: "現在のコミット",
      releaseCount: "リリース",
      publishedAt: "公開日時",
      author: "作成者",
      commit: "コミット",
      statusStable: "安定版",
      statusPrerelease: "プレリリース",
      statusDraft: "下書き",
      currentVersionBadge: "現在のバージョン",
      releaseNotes: "リリースノート",
      openRelease: "リリースを開く",
      viewDetails: "詳細な変更を表示",
      detailsTitle: "詳細な変更",
      detailsDescription: "{range} に含まれるコミット。",
      detailsLoading: "詳細な変更を読み込み中...",
      detailsEmpty: "このバージョンに対する前回リリースはまだありません。",
      detailsFailed: "詳細な変更を読み込めません。",
      currentCommitBadge: "現在のデプロイ",
      openCompare: "比較を開く",
      openCommit: "コミットを開く",
      commitCount: "コミット",
      source: "データソース",
      loadFailed: "GitHub Releases を読み込めません。",
      unknown: "不明",
    },
    scheduledTasks: {
      subtitle: "システムのスケジュールタスクを表示・管理します。",
      empty: "スケジュールタスクはまだありません。",
      refresh: "更新",
      loadFailed: "スケジュールタスクを読み込めません。",
      allStatuses: "すべてのステータス",
      runs24h: "24時間実行",
      successRate24h: "24時間成功率",
      successRateDescription: "成功した実行のみを数えます。",
      problemRuns24h: "問題のある実行",
      retentionPrefix: "保持期間",
      days: "日",
      failed: "失敗",
      partial: "一部完了",
      lastRun: "最終実行",
      staleRunning: "停滞中の実行",
      noStaleRunning: "停滞中の実行なし",
      taskListTitle: "タスク",
      taskListDescription:
        "登録済みスケジュールタスクと過去 30 日間の健全性です。",
      task: "タスク",
      schedule: "スケジュール",
      enabled: "状態",
      enabledYes: "有効",
      enabledNo: "無効",
      lastStatus: "最終ステータス",
      runs30d: "30日実行",
      successRate30d: "30日成功率",
      avgDuration: "平均所要時間",
      runHistoryTitle: "実行履歴",
      runHistoryDescription: "過去 30 日間に保持されたタスク実行です。",
      noRuns: "実行はまだありません。",
      scheduledAt: "予定",
      startedAt: "開始",
      finishedAt: "終了",
      trigger: "トリガー",
      tasks: "タスク",
      taskCount: "タスク",
      subtaskCount: "サブタスク",
      taskResult: "タスク結果",
      statusLabel: "ステータス",
      duration: "所要時間",
      sites: "サイト",
      hours: "時間",
      rows: "行",
      rulesScanned: "ルール",
      messagesCreated: "メッセージ",
      emailFailed: "メール失敗",
      logs: "ログ",
      viewLogs: "表示",
      logTitle: "実行ログ",
      noRunSelected: "ログを確認する実行を選択してください。",
      noLogs: "この実行にログはありません。",
      error: "エラー",
      status: {
        running: "実行中",
        success: "成功",
        partial: "一部完了",
        failed: "失敗",
        skipped: "スキップ",
      },
      taskDefinitions: {
        visit_hourly_rollup: {
          name: "時間別訪問集計",
          description:
            "閉じた訪問行を時間別ロールアップに集計し、ダッシュボードのカウンターと推移に使用します。",
          schedule: "毎時",
        },
        notification_tick: {
          name: "通知配信",
          description: "通知ルールを評価し、メッセージを配信します。",
          schedule: "毎時",
        },
      },
    },
  },
  adminUsers: {
    title: "ユーザー管理",
    subtitle:
      "システム管理者のみがダッシュボードユーザーを作成・管理できます。",
    createTitle: "ユーザーを作成",
    createTeamNotice:
      "ここでユーザーを作成すると、そのユーザーが所有する新しいチームも作成されます。既存チームに追加する場合は、そのチームの設定から招待リンクを作成してください。",
    username: "ユーザー名",
    email: "メール",
    name: "表示名（任意）",
    password: "パスワード（8 文字以上）",
    role: "システム権限",
    teamName: "チーム名",
    teamSlug: "チームスラッグ（任意）",
    defaultTeamName: "{name} のチーム",
    create: "ユーザーを作成",
    creating: "作成中...",
    delete: "削除",
    deleting: "削除中...",
    deleteConfirm: "このユーザーアカウントを削除しますか？",
    deleteSuccess: "ユーザーを削除しました。",
    deleteFailed: "ユーザーを削除できません。",
    generateResetLink: "パスワードリセットリンクを生成",
    resetLinkCreated: "パスワードリセットリンクを生成しました。",
    resetLinkCreateFailed: "パスワードリセットリンクを生成できません。",
    resetLinkCopied: "パスワードリセットリンクをコピーしました。",
    resetLinkCopyFailed: "パスワードリセットリンクをコピーできません。",
    copyResetLink: "リンクをコピー",
    resetLinkExpiresAt: "有効期限",
    listTitle: "ユーザー",
    listSubtitle: "システム内のすべてのユーザーです。",
    noData: "ユーザーが見つかりません。",
    loadFailed: "ユーザーを読み込めません。",
    createSuccess: "ユーザーを作成しました。",
    createFailed: "ユーザーを作成できません。",
    invalidInput: "有効なユーザー名、メール、パスワードを入力してください。",
    columns: {
      name: "名前",
      username: "ユーザー名",
      email: "メール",
      role: "権限",
      teams: "チーム",
      created: "作成日時",
      action: "操作",
    },
  },
  adminSites: {
    title: "サイト管理",
    subtitle: "現在のチーム配下のサイトを管理します。",
    team: "チーム",
    createTitle: "サイトを作成",
    createSubtitle: "新しいサイトはすぐに開けます。",
    name: "サイト名",
    domain: "ドメイン",
    publicSlug: "公開スラッグ（任意）",
    create: "サイトを作成",
    creating: "作成中...",
    listTitle: "サイト",
    listSubtitle: "現在のチーム配下のすべてのサイトです。",
    noData: "サイトが見つかりません。",
    loadFailed: "サイトを読み込めません。",
    createSuccess: "サイトを作成しました。",
    createFailed: "サイトを作成できません。",
    invalidInput: "有効なサイト名とドメインを入力してください。",
    open: "アナリティクスを開く",
    columns: {
      name: "名前",
      domain: "ドメイン",
      slug: "スラッグ",
      created: "作成日時",
      action: "操作",
    },
  },
  adminTeams: {
    title: "チーム管理",
    subtitle: "システム管理者のみがすべてのチームを作成・表示できます。",
    createTitle: "チームを作成",
    createSubtitle: "作成後、設定とメンバーを管理できます。",
    name: "チーム名",
    slug: "チームスラッグ（任意）",
    create: "チームを作成",
    creating: "作成中...",
    listTitle: "チーム",
    listSubtitle: "システム内のすべてのチームです。",
    noData: "チームが見つかりません。",
    loadFailed: "チームを読み込めません。",
    createSuccess: "チームを作成しました。",
    createFailed: "チームを作成できません。",
    invalidInput: "チーム名は 2 文字以上にしてください。",
    open: "チームを開く",
    settings: "設定",
    columns: {
      name: "名前",
      slug: "スラッグ",
      sites: "サイト",
      members: "メンバー",
      created: "作成日時",
      action: "操作",
    },
  },
  requestObservation: {
    title: "リクエスト監視",
    subtitle:
      "Analytics Engine をもとに、リクエスト全体、異常ルーティング、通常の収集経路を監視します。",
    tabs: {
      overview: "概要",
      abnormal: "異常リクエスト",
      normal: "通常リクエスト",
    },
    refresh: "更新",
    loadFailed: "リクエスト監視データを読み込めません。",
    notConfiguredTitle: "Analytics Engine リーダーが設定されていません",
    notConfiguredDescription:
      "リクエスト監視用の Analytics Engine データセットを読むには、システム設定で Cloudflare Account ID と API トークンを追加してください。",
    analyticsEngineDisabledTitle: "Analytics Engine が有効ではありません",
    analyticsEngineDisabledDescription:
      "Cloudflare アカウントで Analytics Engine が有効化されていないため、このデプロイは Analytics Engine バインディングなしで公開されました。Cloudflare で有効化してから再デプロイすると、リクエスト監視データを収集できます。",
    openAnalyticsEngine: "Analytics Engine を開く",
    openSettings: "設定を開く",
    highConfidenceBots: "高信頼度 Bot",
    affectedSites: "影響サイト",
    uniqueCountries: "国",
    noData: "この期間にリクエストデータはありません。",
    trendTitle: "ルーティング推移",
    trendDescription:
      "通常リクエスト、異常リクエスト、分流比率を間隔ごとに表示します。",
    recentTitle: "最近の Bot リクエスト",
    recentDescription:
      "Bot 用 Analytics Engine データセットにのみ書き込まれた詳細記録です。",
    recentShowing: "表示中",
    recentLoadedAll: "すべての記録を読み込みました",
    detailTitle: "Bot リクエスト詳細",
    detailSubtitle:
      "この分流リクエストの検出シグナル、ネットワークコンテキスト、クライアントデータを確認します。",
    client: "クライアント",
    edge: "エッジ",
    identifiers: "識別子",
    fullUserAgent: "完全な User-Agent",
    id: "ID",
    metadata: "メタデータ",
    time: "時刻",
    site: "サイト",
    location: "地域",
    network: "ネットワーク",
    reason: "理由",
    request: "リクエスト",
    ip: "IP",
    userAgent: "User-Agent",
    confidence: "信頼度",
    blocked: "ブロック済み",
    highConfidenceRequests: "高信頼度リクエスト",
    emptyValue: "不明",
    kind: "種別",
    botScoreBucket: "Bot スコア分類",
    verifiedBotCategory: "認証済み Bot カテゴリ",
    hostname: "ホスト名",
    pathname: "パス",
    origin: "オリジン",
    asOrganization: "ASN 組織",
    asn: "ASN",
    country: "国",
    region: "地域",
    city: "都市",
    colo: "データセンター",
    userAgentLengthBucket: "User-Agent 長",
    ipPrefix: "IP プレフィックス",
    botReasonLabels: {
      missing_ua: "User-Agent なし",
      ua_too_long: "User-Agent が長すぎます",
      ua_isbot: "User-Agent が Bot と一致",
      script_ua: "スクリプトクライアント User-Agent",
      cf_bot_score_low: "Cloudflare Bot スコア低",
      cf_verified_bot_category: "Cloudflare 認証済み Bot カテゴリ",
      hosting_asn: "ホスティング ASN",
      network_service_asn: "ネットワークサービス ASN",
      transit_asn: "トランジット ASN",
      access_asn: "アクセス ASN",
      missing_browser_provenance: "ブラウザー由来情報なし",
      origin_hostname_mismatch: "オリジンとホスト名の不一致",
      blocked_pathname: "ブロック対象パス",
    },
    requestKindLabels: {
      pageview: "ページビュー",
      custom_event: "カスタムイベント",
      request: "リクエスト",
    },
    overviewLabels: {
      totalRequests: "総リクエスト数",
      normalRequests: "通常リクエスト",
      abnormalRequests: "異常リクエスト",
      abnormalRatio: "異常リクエスト比率",
      p50Latency: "P50 エッジ遅延",
      p75Latency: "P75 エッジ遅延",
      p95Latency: "P95 エッジ遅延",
      p99Latency: "P99 エッジ遅延",
      avgLatency: "平均エッジ遅延",
      pageviews: "ページビュー",
      customEvents: "カスタムイベント",
      overviewTrendTitle: "リクエストルーティング推移",
      overviewTrendDescription:
        "通常リクエスト、異常リクエスト、異常比率をトップバーの間隔ごとに集計します。",
      trafficCompositionTitle: "リクエスト構成",
      trafficCompositionDescription:
        "通常リクエスト、異常リクエスト、ページイベントを同じ時系列で表示します。",
      confidenceShareTitle: "リクエスト信頼度の内訳",
      normalTrafficShare: "通常トラフィック",
      lowConfidenceTraffic: "低信頼度トラフィック",
      mediumConfidenceTraffic: "中信頼度トラフィック",
      highConfidenceTraffic: "高信頼度トラフィック",
      latencyTitle: "エッジ遅延推移",
      latencyDescription:
        "通常リクエストが AE に書き込まれる際に記録された P50 / P75 / P95 / P99 エッジ遅延です。",
      abnormalSubtitle:
        "分流された異常リクエストに絞り込み、マップと表には赤色の異常トラフィックのみを表示します。",
      normalSubtitle:
        "通常の収集経路に入ったリクエストに絞り込み、マップと表には通常リクエストのみを表示します。",
      requests: "リクエスト数",
      windowDays: "過去 {days} 日",
      latencyMilliseconds: "{value} ミリ秒",
    },
    normalDetail: {
      title: "通常リクエスト詳細",
      subtitle: "通常リクエストの AE 記録フィールド、地域、遅延を確認します。",
      requestMethod: "リクエストメソッド",
      edgeLatency: "エッジ遅延",
      eventAt: "イベント時刻",
      receivedAt: "受信時刻",
      coordinates: "座標",
      continent: "大陸",
    },
    recentNormal: {
      title: "最近の通常リクエスト",
      description:
        "通常リクエスト用 Analytics Engine データセットにのみ書き込まれた詳細記録です。",
    },
  },
  systemSettings: {
    title: "システム設定",
    subtitle: "この InsightFlare デプロイ全体の設定を管理します。",
    guide: "ガイド",
    botAnalyticsTitle: "Analytics Engine",
    botAnalyticsDescription:
      "Bot 保護やその他の分析機能で Analytics Engine データを読むための Cloudflare 認証情報を設定します。",
    botAnalyticsAccountIdLabel: "Cloudflare Account ID",
    botAnalyticsApiTokenLabel: "Cloudflare API トークン",
    botAnalyticsApiTokenPlaceholder:
      "ガイドを見て Cloudflare API トークンを取得",
    botAnalyticsSaved: "Analytics Engine 設定を保存しました。",
    botAnalyticsSaveFailed: "Analytics Engine 設定を保存できません。",
    botAnalyticsDeleted: "Analytics Engine 設定を削除しました。",
    botAnalyticsDeleteFailed: "Analytics Engine 設定を削除できません。",
    botAnalyticsDeleteConfirm:
      "Analytics Engine 読み取り設定を削除しますか？依存する機能は復元されるまで設定が必要な状態になります。",
    botAnalyticsEngineDisabledTitle: "Analytics Engine が有効ではありません",
    botAnalyticsEngineDisabledDescription:
      "Cloudflare アカウントで Analytics Engine が有効化されていないため、このデプロイでは Analytics Engine バインディングが自動的に無効化されました。Cloudflare で Analytics Engine を有効化し、InsightFlare を再デプロイすると関連分析機能が有効になります。",
    botAnalyticsEngineDisabledHint:
      "Analytics Engine が有効化され Worker が再デプロイされるまで、Analytics Engine 設定はロックされます。",
    botAnalyticsOpenCloudflare: "Cloudflare Analytics Engine を開く",
    botAnalyticsGuideTitle: "Analytics Engine 認証情報を取得",
    botAnalyticsGuideDescription:
      "Analytics Engine には Cloudflare アカウント情報と、Analytics Engine データを読み取れる API トークンが必要です。",
    botAnalyticsGuideSteps: [
      "Cloudflare Dashboard を開き、対象アカウントに入り、Account ID をコピーします。",
      "Workers & Pages で Analytics Engine を有効化します。Bot と通常リクエストのデータセットはデプロイ時に自動作成・バインドされます。",
      "My Profile → API Tokens に移動し、Custom token を作成します。",
      "トークンに Account Analytics の読み取り権限を付与し、現在のアカウントにスコープします。",
      "トークンをコピーし、ここに Account ID と API トークンを入力します。",
    ],
    notificationEmailTitle: "メール通知",
    notificationEmailDescription:
      "レポート、アラート、テストメッセージで使用するメールサービスを設定します。",
    notificationEmailGuideTitle: "Resend メール設定を取得",
    notificationEmailGuideDescription:
      "Resend 経由でシステムメールを送るには、検証済み送信ドメインと API キーを用意してください。",
    notificationEmailGuideSteps: [
      "Resend Dashboard を開き、送信ドメインの DNS 検証が完了していることを確認します。",
      "API Keys ページから新しい API キーを作成します。",
      "メール送信に必要な権限を選び、生成された API キーをコピーします。",
      "ここに送信者名、送信者メール、Reply-To、Resend API キーを入力します。",
      "設定を保存し、テストメールを送信して配信を確認します。",
    ],
    loginTurnstileTitle: "ログイン Turnstile 保護",
    loginTurnstileDescription:
      "有効にすると、ログインページはバックグラウンドで Cloudflare Turnstile Invisible 検証を実行し、サーバー側のサインイン処理で強制します。",
    loginTurnstileEnabledLabel: "ログイン保護を有効化",
    loginTurnstileSiteKeyLabel: "Site Key",
    loginTurnstileSecretKeyLabel: "Secret Key",
    loginTurnstileSecretKeyPlaceholder:
      "ガイドを見て Turnstile Secret Key を取得",
    loginTurnstileModeLabel: "検証モード",
    loginTurnstileModeInvisible: "Invisible",
    loginTurnstileTest: "検証をテスト",
    loginTurnstileTesting: "検証中...",
    loginTurnstileTestPassed: "検証に成功しました",
    loginTurnstileTestRequired: "新しい Secret Key は先にテストが必要です",
    loginTurnstileTestMissing:
      "先に Site Key と Secret Key の両方を入力してください。",
    loginTurnstileTestFailed:
      "検証に失敗しました。Site Key と Secret Key を確認してください。",
    loginTurnstileSaved: "ログイン Turnstile 設定を保存しました。",
    loginTurnstileSaveFailed: "ログイン Turnstile 設定を保存できません。",
    loginTurnstileDeleted: "ログイン Turnstile 設定を削除しました。",
    loginTurnstileDeleteFailed: "ログイン Turnstile 設定を削除できません。",
    loginTurnstileDeleteConfirm:
      "ログイン Turnstile 設定を削除しますか？ログイン保護は無効になります。",
    loginTurnstileLoadFailed: "ログイン Turnstile 設定を読み込めません。",
    loginTurnstilePrivacyNotice:
      "Cloudflare Turnstile コンソールで Invisible ウィジェット を作成してください。セルフホスト環境では、プライバシーポリシーが Cloudflare Turnstile の要件に合っていることを確認してください。",
    loginTurnstileGuideTitle: "Turnstile 認証情報を取得",
    loginTurnstileGuideDescription:
      "ログイン保護には Cloudflare Turnstile の Site Key と Secret Key が必要です。",
    loginTurnstileGuideSteps: [
      "Cloudflare Dashboard を開き、Turnstile に移動します。",
      "新しいウィジェットを作成し、Invisible モードを選択します。",
      "現在の InsightFlare ログインドメインを許可ホスト名に追加します。",
      "ウィジェット作成後に Site Key と Secret Key をコピーします。",
      "ここに Site Key と Secret Key を入力し、検証テストを実行してから設定を保存します。",
    ],
    enabledLabel: "メール送信を有効化",
    enabledOn: "有効",
    enabledOff: "無効",
    providerLabel: "メールサービス",
    providerResend: "Resend",
    fromNameLabel: "送信者名",
    fromEmailLabel: "送信者メール",
    replyToLabel: "Reply-To メール",
    replyToPlaceholder: "任意。未指定の場合は送信者メールを使用",
    resendApiKeyLabel: "Resend API Key",
    resendApiKeyPlaceholder: "ガイドを見て Resend API キーを取得",
    testRecipientLabel: "テスト宛先",
    save: "設定を保存",
    saving: "保存中...",
    test: "テストメールを送信",
    testing: "送信中...",
    saved: "メール設定を保存しました。",
    saveFailed: "メール設定を保存できません。",
    delete: "設定を削除",
    deleting: "削除中...",
    cancel: "キャンセル",
    deleted: "メール設定を削除しました。",
    deleteFailed: "メール設定を削除できません。",
    deleteConfirm:
      "メール通知設定を削除しますか？削除後、システムはメール未設定かつ無効として扱います。",
    testSent: "テストメールを送信しました。",
    testFailed: "テストメールを送信できません。",
    loadFailed: "メール設定を読み込めません。",
  },
  systemPerformance: {
    title: "システム性能",
    subtitle:
      "既存の分析行から InsightFlare の収集、バッファリング、書き込みの健全性を監視します。",
    refresh: "更新",
    loadFailed: "システム性能データを読み込めません。",
    noData: "この期間にシステム性能データはありません。",
    range15m: "過去 15 分",
    range1h: "過去 1 時間",
    range6h: "過去 6 時間",
    range24h: "過去 24 時間",
    totalEvents: "受理イベント",
    p95Latency: "P95 推定遅延",
    p50Latency: "P50",
    p75Latency: "P75",
    p50Label: "P50",
    p75Label: "P75",
    p95Label: "P95",
    dataFreshness: "データ鮮度",
    noRecentWrite: "最近の書き込みなし",
    clockAnomalies: "時計 / 遅延異常",
    delayed: "遅延",
    future: "未来時刻",
    latencyPercentileTrend: "遅延パーセンタイル推移",
    latencyPercentileTrendDescription:
      "受信イベントの P50、P75、P95 推定遅延を表示します。",
    throughputTrend: "受理イベントスループット",
    throughputTrendDescription: "受信イベントのスループットを表示します。",
    visits: "訪問",
    customEvents: "カスタムイベント",
    anomalyBucket: "異常分類",
    openVisitHealth: "未終了訪問バックログ",
    openVisitHealthDescription:
      "leave、ルート変更、タイムアウト確定でまだ閉じられていない未終了行です。",
    open: "未終了",
    stale: "停滞",
    timedOut: "タイムアウト",
    oldestOpen: "最古の未終了",
    latestActivity: "最新アクティビティ",
    latencySampleHealth: "遅延サンプルの健全性",
    latencySampleHealthDescription: "信頼イベントの遅延を表示します。",
    trustedSamples: "信頼サンプル",
    topSitesTitle: "システム負荷上位サイト",
    topSitesDescription: "現在受信イベント数が最も多いサイトです。",
    events: "イベント",
    avgLatency: "平均遅延",
    slowestEventsTitle: "推定最遅イベント",
    slowestEventsDescription:
      "選択期間で書き込み時刻とイベント時刻の正の差が最大の記録です。",
    eventTime: "イベント時刻",
    serverTime: "サーバー書き込み時刻",
    estimatedDelay: "推定遅延",
    doDiagnosticTitle: "DO バッファ診断",
    doDiagnosticDescription:
      "各サイトの専用 Durable Object のデータ停滞状況を診断します。",
    doDiagnosticLoadFailed: "DO 診断データを読み込めません。",
    doDiagnosticLoading: "サイトごとに DO 状態を取得中…",
    doDiagnosticRun: "DO 診断を実行",
    doDiagnosticEmpty: "DO 状態はありません。",
    doDiagnosticUnreachable: "一部の DO に到達できません",
    doDiagnosticReachableSites: "到達可能 DO",
    doDiagnosticTotalSites: "総サイト数",
    doDiagnosticActiveAlarms: "アクティブな Alarm タイマー",
    doDiagnosticBufferedVisits: "バッファ済み訪問",
    doDiagnosticOpenVisits: "バッファ内未終了行",
    doDiagnosticOpenStale: "未終了アイドル >30分",
    doDiagnosticOpenTimedOut: "未終了アイドル >12時間",
    doDiagnosticOpenHardAged: "開始から >36時間",
    doDiagnosticOpenFutureSkew: "未来タイムスタンプ",
    doDiagnosticStuckDirty: "未フラッシュの滞留",
    doDiagnosticMaxFlushAttempts: "最大再試行回数",
    doDiagnosticBufferedCustomEvents: "バッファ済みカスタムイベント",
    doDiagnosticOldestOpen: "最古の未終了 started_at",
    doDiagnosticFutureMaxActivity: "最も未来の last_activity",
    doDiagnosticSiteList: "リスク上位サイト",
    doDiagnosticSiteListDescription:
      "DO ごとのバッファ状態スナップショットをリスクスコア順に並べた上位 20 サイトです。",
    doDiagnosticSiteFailed: "到達不能",
    doDiagnosticSiteOpen: "未終了",
    doDiagnosticSiteStuck: "詰まり",
    doDiagnosticSiteFuture: "未来",
    doDiagnosticSiteHardAged: "経過",
    doDiagnosticSiteAlarm: "Alarm",
    doDiagnosticSiteAlarmNone: "なし",
    doDiagnosticSiteAlarmDue: "期限到来",
    doDiagnosticSiteResponseMs: "応答時間",
    doDiagnosticThresholdsHint:
      "しきい値：stale {stale}、timeout {timeout}、hardAged {hardAged}、stuck flush_attempts ≥ {stuck}",
    doDiagnosticHealthy: "異常なバッファ行は検出されませんでした。",
  },
  loginForm: {
    signingIn: "サインイン中...",
    verifyingSecurity: "セキュリティ検証中...",
    securityVerificationTitle: "セキュリティ検証に失敗しました",
    securityVerificationFailed:
      "セキュリティ検証に失敗しました。もう一度お試しください。",
    retrySecurityVerification: "検証を再試行",
    redirecting: "リダイレクト中...",
    failed: "サインインに失敗しました。もう一度お試しください。",
  },
  logoutAction: {
    pending: "サインアウト中...",
    success: "サインアウトしました。",
    failed: "サインアウトできません。もう一度お試しください。",
  },
  sidebarFooter: {
    loggingOut: "サインアウト中...",
    logoutSuccess: "サインアウトしました。",
    logoutFailed: "サインアウトできません。もう一度お試しください。",
  },
  teamEntry: {
    title: "チームを選択",
    description:
      "複数のチームにアクセスできます。続行するチームを選択してください。",
  },
} as AppMessages;

const DICTIONARIES: Record<Locale, AppMessages> = {
  en: enMessages,
  zh: zhMessages,
  ja: jaMessages,
};

export function getMessages(locale: Locale): AppMessages {
  return DICTIONARIES[locale];
}
