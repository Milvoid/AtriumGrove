import { translate } from "./i18n.js";
import { LanguagePicker } from "./language-picker.js";
import { Icon } from "./ui.js";

const sections = [
  { id: "settings", label: "通用" },
  { id: "project-settings", label: "项目设置" },
  { id: "memory", label: "共享记忆" },
  { id: "runs", label: "运行记录" },
  { id: "hosts", label: "执行电脑" },
];

export const isSettingsView = (view: string) =>
  sections.some((section) => section.id === view);

export function SettingsNavigation({
  view,
  select,
}: {
  view: string;
  select: (view: string) => void;
}) {
  return (
    <nav className="settings-navigation" aria-label={translate("设置分类")}>
      {sections.map(({ id, label }) => (
        <button
          key={id}
          className={view === id ? "active" : ""}
          aria-current={view === id ? "page" : undefined}
          onClick={() => select(id)}
        >
          {translate(label)}
        </button>
      ))}
    </nav>
  );
}

export function GeneralSettings({ logout }: { logout: () => void }) {
  return (
    <section
      className="content-panel preferences-page"
      aria-label={translate("通用")}
    >
      <div className="preference-row">
        <h2>{translate("界面语言")}</h2>
        <LanguagePicker />
      </div>
      <div className="preference-row">
        <h2>{translate("关于")}</h2>
        <span>Atrium Grove</span>
      </div>
      <div className="preference-row">
        <h2>{translate("当前站点")}</h2>
        <span className="site-address">{location.host}</span>
      </div>
      <div className="settings-account">
        <button onClick={logout}>
          <Icon name="exit" />
          {translate("退出登录")}
        </button>
      </div>
    </section>
  );
}
