import { Button } from "@/components/ui/button";
import { SidebarTooltip } from "@/components/ui/tooltip";
import { Tooltip } from "@base-ui/react/tooltip";
import type { ComponentType } from "react";
import { Settings } from "lucide-react";
import { tr } from "../core/i18n";
import { cn } from "@/lib/utils";
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
  onBrandClick,
}: {
  active: T;
  entries: SidebarEntry<T>[];
  onNavigate: (page: T) => void;
  onSettings: () => void;
  onBrandClick: () => void;
}) {
  return (
    <Tooltip.Provider delay={400}>
      <header className="top-navbar col-start-1 row-start-2 flex min-w-0 items-center border-b border-border-subtle/70 bg-background px-4 sm:px-6">
        <div className="top-navbar-inner">
          <SidebarBrand onClick={onBrandClick} />
          <nav
            className="min-w-0 flex-1 overflow-x-auto"
            aria-label={tr("common.primaryNavigation")}
          >
            <div className="top-navbar-group mx-auto w-fit min-w-max">
              {entries.map(({ id, label, icon: Icon, badge }) => (
                <SidebarTooltip key={id} label={tr(label)}>
                  <Button
                    variant="bare"
                    size="content"
                    className={cn(
                      "relative flex h-9 items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium tracking-[0.01em] text-sidebar-foreground/70 transition-colors duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:scale-[0.99]",
                      active === id &&
                        "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm",
                    )}
                    aria-current={active === id ? "page" : undefined}
                    onClick={() => onNavigate(id)}
                  >
                    <Icon size={17} />
                    <span>{tr(label)}</span>
                    {badge ? (
                      <em className="grid min-w-4 place-items-center rounded-full bg-sidebar-primary px-1 py-0.5 text-[9px] font-semibold not-italic leading-none text-sidebar-primary-foreground">
                        {badge}
                      </em>
                    ) : null}
                  </Button>
                </SidebarTooltip>
              ))}
            </div>
          </nav>
          <div className="top-navbar-group shrink-0">
            <SidebarTooltip label={tr("nav.settings")}>
              <Button
                variant="bare"
                size="content"
                className="flex size-9 items-center justify-center rounded-xl px-0 text-left text-sm font-medium tracking-[0.01em] text-sidebar-foreground/70 transition-colors duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:scale-[0.99]"
                type="button"
                onClick={onSettings}
              >
                <Settings size={18} />
                <span className="sr-only">{tr("nav.settings")}</span>
              </Button>
            </SidebarTooltip>
          </div>
        </div>
      </header>
    </Tooltip.Provider>
  );
}
