import { Button } from "@/components/ui/button";
import type { ComponentType } from "react";
import { Settings } from "lucide-react";
import { tr } from "../i18n";
import { cn } from "@/lib/utils";

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
    <aside className="sidebar relative z-20 col-start-1 row-start-1 flex h-full min-h-0 w-[var(--sidebar-width)] flex-col border-r border-[var(--border)] bg-[var(--sidebar)] p-3 transition-transform duration-150 group-[.sidebar-collapsed]:pointer-events-none group-[.sidebar-collapsed]:-translate-x-full" aria-hidden={collapsed} inert={collapsed ? true : undefined}>
      <div className="flex h-[38px] items-center gap-2.5 px-[5px]">
        <span className="block text-[18px] font-normal leading-none tracking-[-0.02em] text-foreground">AgentKib</span>
      </div>
      <nav className="mt-5 flex flex-col gap-[3px]" aria-label={tr("common.primaryNavigation")}>
        {entries.map(({ id, label, icon: Icon, badge }) => (
          <Button key={id} variant="bare" size="content" className={cn("flex min-h-[38px] w-full items-center justify-start gap-[11px] rounded-lg px-2.5 text-[13px] font-medium text-[#7f899d] hover:bg-[#121721] hover:text-[#bec5d3]", active === id && "active bg-[rgba(172,172,172,0.13)] text-[#eeeaff]")} aria-current={active === id ? "page" : undefined} onClick={() => onNavigate(id)}>
            <Icon size={17} />{tr(label)}
            {badge ? <em className="ml-auto min-w-[19px] rounded-[10px] bg-[#474747] px-[5px] py-px text-center text-[10px] not-italic text-[#e8e8e8]">{badge}</em> : null}
          </Button>
        ))}
      </nav>
      <Button variant="bare" size="content" className="mt-auto flex min-h-[38px] w-full items-center justify-start gap-[11px] rounded-lg px-2.5 text-left text-[13px] text-[#7f899d] hover:bg-[#121721] hover:text-[#bec5d3]" type="button" onClick={onSettings}>
        <Settings size={17} />{tr("nav.settings")}
      </Button>
    </aside>
  );
}
