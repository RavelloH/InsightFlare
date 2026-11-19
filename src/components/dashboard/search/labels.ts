import type { Locale } from "@/lib/i18n/config";
export const perceptionLabels: Record<
  Locale,
  {
    title: string;
    description: string;
    trigger: string;
    placeholder: string;
    local: string;
    navigation: string;
    empty: string;
    fulltext: string;
    fulltextUnavailable: string;
    unavailable: string;
    localValue: string;
  }
> = {
  en: {
    title: "Search",
    description: "Navigation and locally observed Analytics values",
    trigger: "Search",
    placeholder: "Search pages, events and navigation...",
    local: "Observed on this device",
    navigation: "Navigation",
    empty: "No local matches. This does not mean the data does not exist.",
    fulltext: "Search all data",
    fulltextUnavailable:
      "Server full-text search is not available in this version.",
    unavailable: "This target is no longer authorized or available.",
    localValue: "Previously observed on this device",
  },
  zh: {
    title: "搜索",
    description: "导航及本机已观察的分析字段值",
    trigger: "搜索",
    placeholder: "搜索页面、事件和导航...",
    local: "本机观察",
    navigation: "导航",
    empty: "暂无本地匹配；不代表数据库中不存在。",
    fulltext: "搜索全部数据",
    fulltextUnavailable: "当前版本尚无可用的服务端全文搜索。",
    unavailable: "目标已失效或当前无权访问。",
    localValue: "本机曾观察到的值",
  },
  "zh-tw": {
    title: "搜尋",
    description: "導覽及本機已觀察的分析欄位值",
    trigger: "搜尋",
    placeholder: "搜尋頁面、事件和導覽...",
    local: "本機觀察",
    navigation: "導覽",
    empty: "暫無本地匹配；不代表資料庫中不存在。",
    fulltext: "搜尋全部資料",
    fulltextUnavailable: "目前版本沒有可用的伺服器全文搜尋。",
    unavailable: "目標已失效或目前無權存取。",
    localValue: "本機曾觀察的值",
  },
  ja: {
    title: "検索",
    description: "ナビゲーションと端末で確認済みの分析項目",
    trigger: "検索",
    placeholder: "ページ・イベント・ナビゲーションを検索...",
    local: "この端末の観測",
    navigation: "ナビゲーション",
    empty:
      "ローカルの候補がありません。データが存在しないという意味ではありません。",
    fulltext: "全データを検索",
    fulltextUnavailable: "このバージョンではサーバー全文検索を利用できません。",
    unavailable: "対象が無効か、現在アクセスできません。",
    localValue: "この端末で確認済み",
  },
};
