import type { Locale } from "./config";

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

const en: AppMessages = {
  appName: "InsightFlare",
  navigation: {
    overview: "Overview",
    pages: "Pages",
    referrers: "Referrers",
    sessions: "Sessions",
    events: "Events",
    visitors: "Visitors",
    geo: "Geo",
    devices: "Devices",
    browsers: "Browsers",
  },
  common: {
    views: "Views",
    sessions: "Sessions",
    visitors: "Visitors",
    bounces: "Bounces",
    bounceRate: "Bounce Rate",
    avgDuration: "Avg. Duration",
    page: "Page",
    referrer: "Referrer",
    startedAt: "Started",
    endedAt: "Ended",
    event: "Event",
    location: "Location",
    browser: "Browser",
    device: "Device",
    country: "Country",
    duration: "Duration",
    loading: "Loading",
    noData: "No data",
    unknown: "Unknown",
    lastUpdated: "Last updated",
    site: "Site",
    team: "Team",
  },
  ranges: {
    title: "Time Range",
    last24h: "24h",
    last7d: "7d",
    last30d: "30d",
    last90d: "90d",
  },
  filters: {
    title: "Filters",
    country: "Country",
    device: "Device",
    browser: "Browser",
    eventType: "Event",
    all: "All",
    clear: "Clear",
  },
  realtime: {
    title: "Realtime",
    subtitle: "Live stream of incoming events.",
    activeNow: "Active now",
    connected: "Connected",
    disconnected: "Disconnected",
    recentEvents: "Recent live events",
  },
  overview: {
    title: "Traffic Overview",
    subtitle: "Monitor high-level performance and audience behavior.",
    trendTitle: "Traffic Trend",
    engagementTitle: "Engagement Detail",
    compositionTitle: "Metric Composition",
    eventTypesTitle: "Event Types",
    sessionDurationTitle: "Session Duration",
    topPages: "Top Pages",
    topReferrers: "Top Referrers",
    recentSessions: "Recent Sessions",
    recentEvents: "Recent Events",
  },
  pages: {
    title: "Pages",
    subtitle: "Most visited paths in the selected range.",
  },
  referrers: {
    title: "Referrers",
    subtitle: "Where traffic comes from.",
  },
  sessions: {
    title: "Sessions",
    subtitle: "Session-level detail for quality analysis.",
  },
  events: {
    title: "Events",
    subtitle: "Raw event stream for diagnostics.",
  },
  visitors: {
    title: "Visitors",
    subtitle: "Visitor-level breakdown and recency.",
  },
  geo: {
    title: "Geo",
    subtitle: "Traffic distribution by country.",
  },
  devices: {
    title: "Devices",
    subtitle: "Device type distribution.",
  },
  browsers: {
    title: "Browsers",
    subtitle: "Browser distribution and share.",
  },
  login: {
    title: "Sign in",
    subtitle: "Use your InsightFlare admin account.",
    username: "Username or Email",
    password: "Password",
    signIn: "Sign in",
    invalidCredentials: "Invalid username or password.",
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
    switchToLight: "Light",
    switchToDark: "Dark",
  },
};

const zh: AppMessages = {
  appName: "InsightFlare",
  navigation: {
    overview: "总览",
    pages: "页面",
    referrers: "来源",
    sessions: "会话",
    events: "事件",
    visitors: "访客",
    geo: "地区",
    devices: "设备",
    browsers: "浏览器",
  },
  common: {
    views: "浏览量",
    sessions: "会话数",
    visitors: "访客数",
    bounces: "跳出数",
    bounceRate: "跳出率",
    avgDuration: "平均停留",
    page: "页面",
    referrer: "来源",
    startedAt: "开始时间",
    endedAt: "结束时间",
    event: "事件",
    location: "地区",
    browser: "浏览器",
    device: "设备",
    country: "国家",
    duration: "时长",
    loading: "加载中",
    noData: "暂无数据",
    unknown: "未知",
    lastUpdated: "更新时间",
    site: "站点",
    team: "团队",
  },
  ranges: {
    title: "时间范围",
    last24h: "24小时",
    last7d: "7天",
    last30d: "30天",
    last90d: "90天",
  },
  filters: {
    title: "筛选",
    country: "国家",
    device: "设备",
    browser: "浏览器",
    eventType: "事件",
    all: "全部",
    clear: "清除",
  },
  realtime: {
    title: "实时",
    subtitle: "实时接收最新访问事件。",
    activeNow: "当前在线",
    connected: "已连接",
    disconnected: "未连接",
    recentEvents: "实时事件",
  },
  overview: {
    title: "访问总览",
    subtitle: "查看核心指标与访问趋势。",
    trendTitle: "访问趋势",
    engagementTitle: "互动细分趋势",
    compositionTitle: "指标占比",
    eventTypesTitle: "事件类型分布",
    sessionDurationTitle: "会话时长分布",
    topPages: "热门页面",
    topReferrers: "热门来源",
    recentSessions: "最近会话",
    recentEvents: "最近事件",
  },
  pages: {
    title: "页面分析",
    subtitle: "选定时间范围内访问最多的路径。",
  },
  referrers: {
    title: "来源分析",
    subtitle: "流量来源渠道分布。",
  },
  sessions: {
    title: "会话列表",
    subtitle: "用于分析访问质量的会话明细。",
  },
  events: {
    title: "事件流",
    subtitle: "用于排查问题的原始事件列表。",
  },
  visitors: {
    title: "访客分析",
    subtitle: "访客级别明细与最近活跃情况。",
  },
  geo: {
    title: "地区分析",
    subtitle: "按国家查看访问分布。",
  },
  devices: {
    title: "设备分析",
    subtitle: "按设备类型查看访问分布。",
  },
  browsers: {
    title: "浏览器分析",
    subtitle: "按浏览器查看访问分布。",
  },
  login: {
    title: "登录",
    subtitle: "使用 InsightFlare 管理员账号登录。",
    username: "用户名或邮箱",
    password: "密码",
    signIn: "登录",
    invalidCredentials: "用户名或密码错误。",
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
    switchToLight: "浅色",
    switchToDark: "深色",
  },
};

const DICTIONARIES: Record<Locale, AppMessages> = {
  en,
  zh,
};

export function getMessages(locale: Locale): AppMessages {
  return DICTIONARIES[locale];
}
