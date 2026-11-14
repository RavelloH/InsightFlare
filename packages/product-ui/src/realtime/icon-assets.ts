import browserAndroid from "../assets/browser/android.svg";
import browserAndroidWebview from "../assets/browser/android-webview.svg";
import browserAol from "../assets/browser/aol.svg";
import browserArc from "../assets/browser/arc.svg";
import browserBeaker from "../assets/browser/beaker.svg";
import browserBlackberry from "../assets/browser/blackberry.svg";
import browserBrave from "../assets/browser/brave.svg";
import browserChrome from "../assets/browser/chrome.svg";
import browserChromiumWebview from "../assets/browser/chromium-webview.svg";
import browserCriOS from "../assets/browser/crios.svg";
import browserCurl from "../assets/browser/curl.svg";
import browserDuckDuckGo from "../assets/browser/duckduckgo.svg";
import browserEdge from "../assets/browser/edge.svg";
import browserEdgeChromium from "../assets/browser/edge-chromium.svg";
import browserEdgeIos from "../assets/browser/edge-ios.svg";
import browserFacebook from "../assets/browser/facebook.svg";
import browserFirefox from "../assets/browser/firefox.svg";
import browserFxIos from "../assets/browser/fxios.svg";
import browserHuawei from "../assets/browser/huawei.svg";
import browserIe from "../assets/browser/ie.svg";
import browserInstagram from "../assets/browser/instagram.svg";
import browserIos from "../assets/browser/ios.svg";
import browserIosWebview from "../assets/browser/ios-webview.svg";
import browserKakaotalk from "../assets/browser/kakaotalk.svg";
import browserMiui from "../assets/browser/miui.svg";
import browserOpera from "../assets/browser/opera.svg";
import browserOperaGx from "../assets/browser/opera-gx.svg";
import browserOperaMini from "../assets/browser/opera-mini.svg";
import browserQq from "../assets/browser/qq.svg";
import browserSafari from "../assets/browser/safari.svg";
import browserSamsung from "../assets/browser/samsung.svg";
import browserSearchbot from "../assets/browser/searchbot.svg";
import browserSilk from "../assets/browser/silk.svg";
import browserUc from "../assets/browser/uc.svg";
import browserUnknown from "../assets/browser/unknown.svg";
import browserVivaldi from "../assets/browser/vivaldi.svg";
import browserWechat from "../assets/browser/wechat.svg";
import browserYandexbrowser from "../assets/browser/yandexbrowser.svg";
import osAmazon from "../assets/os/amazon-os.svg";
import osAndroid from "../assets/os/android-os.svg";
import osBeos from "../assets/os/beos.svg";
import osBlackberry from "../assets/os/blackberry-os.svg";
import osChrome from "../assets/os/chrome-os.svg";
import osIos from "../assets/os/ios.svg";
import osLinux from "../assets/os/linux.svg";
import osMac from "../assets/os/mac-os.svg";
import osOpenBsd from "../assets/os/open-bsd.svg";
import osOs2 from "../assets/os/os-2.svg";
import osQnx from "../assets/os/qnx.svg";
import osSun from "../assets/os/sun-os.svg";
import osUnknown from "../assets/os/unknown.svg";
import osWindows7 from "../assets/os/windows-7.svg";
import osWindows8 from "../assets/os/windows-8.svg";
import osWindows81 from "../assets/os/windows-8-1.svg";
import osWindows10 from "../assets/os/windows-10.svg";
import osWindows11 from "../assets/os/windows-11.svg";
import osWindows95 from "../assets/os/windows-95.svg";
import osWindows98 from "../assets/os/windows-98.svg";
import osWindows2000 from "../assets/os/windows-2000.svg";
import osWindowsMe from "../assets/os/windows-me.svg";
import osWindowsMobile from "../assets/os/windows-mobile.svg";
import osWindowsServer2003 from "../assets/os/windows-server-2003.svg";
import osWindowsVista from "../assets/os/windows-vista.svg";
import osWindowsXp from "../assets/os/windows-xp.svg";

const browserIconUrls: Readonly<Record<string, string>> = {
  "android-webview": browserAndroidWebview,
  android: browserAndroid,
  aol: browserAol,
  arc: browserArc,
  beaker: browserBeaker,
  blackberry: browserBlackberry,
  brave: browserBrave,
  chrome: browserChrome,
  "chromium-webview": browserChromiumWebview,
  crios: browserCriOS,
  curl: browserCurl,
  duckduckgo: browserDuckDuckGo,
  "edge-chromium": browserEdgeChromium,
  "edge-ios": browserEdgeIos,
  edge: browserEdge,
  facebook: browserFacebook,
  firefox: browserFirefox,
  fxios: browserFxIos,
  huawei: browserHuawei,
  ie: browserIe,
  instagram: browserInstagram,
  "ios-webview": browserIosWebview,
  ios: browserIos,
  kakaotalk: browserKakaotalk,
  miui: browserMiui,
  "opera-gx": browserOperaGx,
  "opera-mini": browserOperaMini,
  opera: browserOpera,
  qq: browserQq,
  safari: browserSafari,
  samsung: browserSamsung,
  searchbot: browserSearchbot,
  silk: browserSilk,
  uc: browserUc,
  unknown: browserUnknown,
  vivaldi: browserVivaldi,
  wechat: browserWechat,
  yandexbrowser: browserYandexbrowser,
};

const osIconUrls: Readonly<Record<string, string>> = {
  "amazon-os": osAmazon,
  "android-os": osAndroid,
  beos: osBeos,
  "blackberry-os": osBlackberry,
  "chrome-os": osChrome,
  ios: osIos,
  linux: osLinux,
  "mac-os": osMac,
  "open-bsd": osOpenBsd,
  "os-2": osOs2,
  qnx: osQnx,
  "sun-os": osSun,
  unknown: osUnknown,
  "windows-10": osWindows10,
  "windows-11": osWindows11,
  "windows-2000": osWindows2000,
  "windows-7": osWindows7,
  "windows-8-1": osWindows81,
  "windows-8": osWindows8,
  "windows-95": osWindows95,
  "windows-98": osWindows98,
  "windows-me": osWindowsMe,
  "windows-mobile": osWindowsMobile,
  "windows-server-2003": osWindowsServer2003,
  "windows-vista": osWindowsVista,
  "windows-xp": osWindowsXp,
};

export function resolveBrowserIconUrl(key: string): string {
  return Object.hasOwn(browserIconUrls, key)
    ? browserIconUrls[key]
    : browserIconUrls.unknown;
}

export function resolveOsIconUrl(key: string): string {
  return Object.hasOwn(osIconUrls, key) ? osIconUrls[key] : osIconUrls.unknown;
}
