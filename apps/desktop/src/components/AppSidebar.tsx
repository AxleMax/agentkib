import type { ComponentType } from "react";
import { Settings, Sparkles } from "lucide-react";
import { tr } from "../i18n";

export interface SidebarEntry<T extends string> {
  id: T;
  label: string;
  icon: ComponentType<{ size?: number }>;
  badge?: number;
}

export function AppSidebar<T extends string>({
  active,
  entries,
  onNavigate,
  onSettings,
  collapsed = false,
}: {
  active: T;
  entries: SidebarEntry<T>[];
  onNavigate: (page: T) => void;
  onSettings: () => void;
  collapsed?: boolean;
}) {
  return (
    <aside className="sidebar" aria-hidden={collapsed} inert={collapsed ? true : undefined}>
      <div className="brand">
        <div className="brand-mark"><Sparkles size={17} /></div>
        <strong>AgentKib</strong>
      </div>
      <nav aria-label={tr("common.primaryNavigation")}>
        {entries.map(({ id, label, icon: Icon, badge }) => (
          <button key={id} className={active === id ? "active" : ""} onClick={() => onNavigate(id)}>
            <Icon size={17} />{tr(label)}
            {badge ? <em>{badge}</em> : null}
          </button>
        ))}
      </nav>
      <button className="sidebar-settings" type="button" onClick={onSettings}>
        <Settings size={17} />{tr("nav.settings")}
      </button>
    </aside>
  );
}
