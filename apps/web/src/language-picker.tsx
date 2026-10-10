import { useSyncExternalStore } from "react";
import {
  getLanguagePreference,
  getLocale,
  setLanguagePreference,
  subscribeLanguage,
  translate,
  type LanguagePreference,
} from "./i18n.js";
import { Icon } from "./ui.js";
export function useLanguage() {
  return useSyncExternalStore(
    subscribeLanguage,
    () => getLanguagePreference() + ":" + getLocale(),
  );
}
export function LanguagePicker() {
  useLanguage();
  return (
    <label className="language-picker">
      <Icon name="language" />
      <select
        aria-label={translate("界面语言")}
        value={getLanguagePreference()}
        onChange={(event) =>
          setLanguagePreference(event.target.value as LanguagePreference)
        }
      >
        <option value="auto">{translate("跟随浏览器")}</option>
        <option value="zh-Hans">简体中文</option>
        <option value="zh-Hant">繁體中文</option>
        <option value="en">English</option>
      </select>
    </label>
  );
}
