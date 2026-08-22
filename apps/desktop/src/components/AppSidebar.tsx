import { Button } from "@/components/ui/button";
import type { ComponentType } from "react";
import { Settings } from "lucide-react";
import { tr } from "../i18n";
import { cn } from "@/lib/utils";
import type { AppPlatform } from "../platform";

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
  platform = "web",
}: {
  active: T;
  entries: SidebarEntry<T>[];
  onNavigate: (page: T) => void;
  onSettings: () => void;
  collapsed?: boolean;
  platform?: AppPlatform;
}) {
  return (
    <aside className={cn("relative z-20 col-start-1 row-start-1 flex h-full min-h-0 w-[var(--sidebar-width)] flex-col border-r border-sidebar-border bg-sidebar px-3 pb-3 transition-transform duration-150 group-[.sidebar-collapsed]:pointer-events-none group-[.sidebar-collapsed]:-translate-x-full", platform === "macos" || platform === "web" ? "pt-[54px]" : "pt-3")} aria-hidden={collapsed} inert={collapsed ? true : undefined}>
      <div className="flex h-[38px] items-center gap-2.5 px-[5px]">
        <span className="block text-[16px] font-normal leading-none tracking-[-0.02em] text-sidebar-foreground">AgentKib</span>
      </div>
      <nav className="mt-5 flex flex-col gap-[3px]" aria-label={tr("common.primaryNavigation")}>
        {entries.map(({ id, label, icon: Icon, badge }) => (
          <Button key={id} variant="bare" size="content" className={cn("flex min-h-[38px] w-full items-center justify-start gap-[11px] rounded-lg px-2.5 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground", active === id && "bg-sidebar-accent text-sidebar-accent-foreground")} aria-current={active === id ? "page" : undefined} onClick={() => onNavigate(id)}>
            <Icon size={17} />{tr(label)}
            {badge ? <em className="ml-auto min-w-[19px] rounded-[10px] bg-sidebar-primary px-[5px] py-px text-center text-[10px] not-italic text-sidebar-primary-foreground">{badge}</em> : null}
          </Button>
        ))}
      </nav>
      <Button variant="bare" size="content" className="mt-auto flex min-h-[38px] w-full items-center justify-start gap-[11px] rounded-lg px-2.5 text-left text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" type="button" onClick={onSettings}>
        <Settings size={17} />{tr("nav.settings")}
      </Button>
    </aside>
  );
}
