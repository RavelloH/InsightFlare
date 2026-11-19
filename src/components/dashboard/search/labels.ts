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
    quickAccess: string;
    empty: string;
    unavailable: string;
    localValue: string;
  }
> = {
  en: {
    title: "Search",
    description: "Quickly navigate your workspace or search pages and events.",
    trigger: "Search",
    placeholder: "Search pages, events and navigation...",
    local: "Observed on this device",
    navigation: "Navigation",
    quickAccess: "Quick navigation",
    empty: "No local matches. This does not mean the data does not exist.",
    unavailable: "This target is no longer authorized or available.",
    localValue: "Previously observed on this device",
  },
  zh: {
    title: "搜索",
    description: "快速前往团队和分析页面，或搜索已观察的数据。",
    trigger: "搜索",
    placeholder: "搜索页面、事件和导航...",
    local: "本机观察",
    navigation: "导航",
    quickAccess: "快速导航",
    empty: "暂无本地匹配；不代表数据库中不存在。",
    unavailable: "目标已失效或当前无权访问。",
    localValue: "本机曾观察到的值",
  },
  "zh-tw": {
    title: "搜尋",
    description: "快速前往團隊和分析頁面，或搜尋已觀察的資料。",
    trigger: "搜尋",
    placeholder: "搜尋頁面、事件和導覽...",
    local: "本機觀察",
    navigation: "導覽",
    quickAccess: "快速導覽",
    empty: "暫無本地匹配；不代表資料庫中不存在。",
    unavailable: "目標已失效或目前無權存取。",
    localValue: "本機曾觀察的值",
  },
  ja: {
    title: "検索",
    description:
      "チームと分析ページへすばやく移動し、確認済みのデータを検索します。",
    trigger: "検索",
    placeholder: "ページ・イベント・ナビゲーションを検索...",
    local: "この端末の観測",
    navigation: "ナビゲーション",
    quickAccess: "クイックナビゲーション",
    empty:
      "ローカルの候補がありません。データが存在しないという意味ではありません。",
    unavailable: "対象が無効か、現在アクセスできません。",
    localValue: "この端末で確認済み",
  },
};
