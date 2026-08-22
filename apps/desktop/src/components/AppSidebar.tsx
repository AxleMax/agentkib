import { Button } from "@/components/ui/button";
import type { ComponentType } from "react";
import { Settings } from "lucide-react";
import { tr } from "../i18n";
import { cn } from "@/lib/utils";
import type { AppPlatform } from "../platform";
import { SidebarBrand } from "./SidebarBrand";

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
    <aside className={cn("relative z-20 col-start-1 row-start-1 flex h-full min-h-0 w-[var(--sidebar-width)] flex-col border-r border-sidebar-border bg-sidebar px-3.5 pb-3.5 transition-transform duration-150 group-[.sidebar-collapsed]:pointer-events-none group-[.sidebar-collapsed]:-translate-x-full", platform === "macos" || platform === "web" ? "pt-[68px]" : "pt-3")} aria-hidden={collapsed} inert={collapsed ? true : undefined}>
      <SidebarBrand />
      <nav className="mt-7 flex flex-col gap-1" aria-label={tr("common.primaryNavigation")}>
        {entries.map(({ id, label, icon: Icon, badge }) => (
          <Button key={id} variant="bare" size="content" className={cn("flex min-h-11 w-full items-center justify-start gap-3 rounded-xl px-3 text-sm font-medium tracking-[0.01em] text-sidebar-foreground/70 transition-colors duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:scale-[0.99]", active === id && "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm")} aria-current={active === id ? "page" : undefined} onClick={() => onNavigate(id)}>
            <Icon size={18} />{tr(label)}
            {badge ? <em className="ml-auto grid min-w-6 place-items-center rounded-lg bg-sidebar-primary px-1.5 py-1 text-[11px] font-semibold not-italic leading-none text-sidebar-primary-foreground">{badge}</em> : null}
          </Button>
        ))}
      </nav>
      <Button variant="bare" size="content" className="mt-auto flex min-h-11 w-full items-center justify-start gap-3 rounded-xl px-3 text-left text-sm font-medium tracking-[0.01em] text-sidebar-foreground/70 transition-colors duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:scale-[0.99]" type="button" onClick={onSettings}>
        <Settings size={18} />{tr("nav.settings")}
      </Button>
    </aside>
  );
}
