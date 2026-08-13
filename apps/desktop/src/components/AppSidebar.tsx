import type { ComponentType } from "react";
import { Sparkles } from "lucide-react";
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
  workspaceCount,
  onNavigate,
}: {
  active: T;
  entries: SidebarEntry<T>[];
  workspaceCount: number;
  onNavigate: (page: T) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><Sparkles size={17} /></div>
        <div><strong>AgentKib</strong><span>{tr("common.assetControlPlane")}</span></div>
      </div>
      <nav aria-label={tr("common.primaryNavigation")}>
        {entries.map(({ id, label, icon: Icon, badge }) => (
          <button key={id} className={active === id ? "active" : ""} onClick={() => onNavigate(id)}>
            <Icon size={17} />{tr(label)}
            {badge ? <em>{badge}</em> : null}
          </button>
        ))}
      </nav>
      <div className="sidebar-foot"><div className="status-dot" />{tr("common.localOnly")} · {workspaceCount} {tr("common.workspaces")}</div>
    </aside>
  );
}
