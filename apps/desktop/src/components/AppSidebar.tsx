import { Button } from "@/components/ui/button";
import type { ComponentType } from "react";
import { Settings } from "lucide-react";
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
        <span className="brand-name">AgentKib</span>
      </div>
      <nav aria-label={tr("common.primaryNavigation")}>
        {entries.map(({ id, label, icon: Icon, badge }) => (
          <Button key={id} variant="bare" size="content" className={active === id ? "active" : ""} aria-current={active === id ? "page" : undefined} onClick={() => onNavigate(id)}>
            <Icon size={17} />{tr(label)}
            {badge ? <em>{badge}</em> : null}
          </Button>
        ))}
      </nav>
      <Button variant="bare" size="content" className="sidebar-settings" type="button" onClick={onSettings}>
        <Settings size={17} />{tr("nav.settings")}
      </Button>
    </aside>
  );
}
