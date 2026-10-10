import simplified from "./locales/zh-Hans.json" with { type: "json" };
import traditional from "./locales/zh-Hant.json" with { type: "json" };
import english from "./locales/en.json" with { type: "json" };

export type Locale = "zh-Hans" | "zh-Hant" | "en";
export type LanguagePreference = Locale | "auto";
export const languageStorageKey = "atrium-grove.language";
export const catalogs: Record<Locale, Record<string, string>> = {
  "zh-Hans": simplified,
  "zh-Hant": traditional,
  en: english,
};
export function resolveLocale(languages: readonly string[]): Locale {
  for (const tag of languages) {
    const parts = tag.toLowerCase().replaceAll("_", "-").split("-");
    if (parts[0] === "zh") {
      if (parts.includes("hant")) return "zh-Hant";
      if (parts.includes("hans")) return "zh-Hans";
      return parts.some((part) => ["tw", "hk", "mo"].includes(part))
        ? "zh-Hant"
        : "zh-Hans";
    }
    if (parts[0] === "en") return "en";
  }
  return "en";
}
export function validPreference(value: unknown): LanguagePreference {
  return value === "zh-Hans" || value === "zh-Hant" || value === "en"
    ? value
    : "auto";
}
function savedPreference(): LanguagePreference {
  try {
    return validPreference(localStorage.getItem(languageStorageKey));
  } catch {
    return "auto";
  }
}
function browserLocale(): Locale {
  return resolveLocale(
    typeof navigator === "undefined"
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language],
  );
}
let preference = savedPreference();
let locale: Locale = preference === "auto" ? browserLocale() : preference;
const listeners = new Set<() => void>();
export const getLocale = () => locale;
export const getLanguagePreference = () => preference;
export function subscribeLanguage(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function notifyLanguage() {
  locale = preference === "auto" ? browserLocale() : preference;
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  listeners.forEach((listener) => listener());
}
export function setLanguagePreference(next: LanguagePreference) {
  preference = validPreference(next);
  try {
    if (preference === "auto") localStorage.removeItem(languageStorageKey);
    else localStorage.setItem(languageStorageKey, preference);
  } catch {
    /* Language switching also works when browser storage is unavailable. */
  }
  notifyLanguage();
}
if (typeof window !== "undefined") {
  document.documentElement.lang = locale;
  window.addEventListener("languagechange", () => {
    if (preference === "auto") notifyLanguage();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === languageStorageKey || event.key === null) {
      preference = savedPreference();
      notifyLanguage();
    }
  });
}
export function translateFor(
  language: Locale,
  key: string,
  values: Record<string, string | number> = {},
) {
  const template = Object.hasOwn(catalogs[language], key)
    ? catalogs[language][key]!
    : Object.hasOwn(catalogs.en, key)
      ? catalogs.en[key]!
      : key;
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    values[name] === undefined ? token : String(values[name]),
  );
}
export function translate(
  key: string,
  values?: Record<string, string | number>,
) {
  return translateFor(locale, key, values);
}
// Only use for interface errors. Never run model output or user content through this lookup.
export function translateError(message: string) {
  const text = message.replace(/^(?:Error|TypeError): /, "");
  if (
    [
      "Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
    ].includes(text)
  )
    return translate("连接失败，请检查网络后重试。");
  const key = Object.keys(catalogs.en).find(
    (key) =>
      key === text ||
      catalogs.en[key] === text ||
      catalogs["zh-Hant"][key] === text,
  );
  return key ? translate(key) : message;
}
export const homeTitles = [
  "开始讨论吧。",
  "想从哪里开始？",
  "今天一起做些什么？",
] as const;

const errorKeys: Record<string, string> = {
  INVALID_LOGIN: "密码不正确，请重试",
  LOGIN_RATE_LIMIT: "请求过于频繁，请稍后再试。",
  UNAUTHENTICATED: "登录已过期，请退出后重新登录。",
  CSRF_INVALID: "登录已过期，请退出后重新登录。",
  VERSION_CONFLICT: "配置已被更新，请刷新后重试。",
  AGENT_BUSY: "成员正在执行，请等待本轮完成。",
  AGENT_DELETED: "此成员已删除。",
  PROJECT_BUSY: "工作目录正在使用，请等待执行结束。",
  STALE_APPROVAL: "审批已过期，请刷新后重试。",
  HOST_OFFLINE: "执行服务离线",
  HOST_DENIED: "此地址尚未获准访问，请检查服务端的域名配置。",
  ORIGIN_DENIED: "此地址尚未获准访问，请检查服务端的域名配置。",
};
export function apiErrorMessage(
  error: { code?: string; message?: string },
  status?: number,
) {
  const key =
    error.code && Object.hasOwn(errorKeys, error.code)
      ? errorKeys[error.code]
      : undefined;
  if (key) return translate(key);
  if (error.message) return translateError(error.message);
  return translate("请求未能完成，请重试。") + (status ? ` (${status})` : "");
}
