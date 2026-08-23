import { Button } from "@/components/ui/button";
import { Award, Bot, CircleAlert, FolderGit2, Gauge, Home, Library } from "lucide-react";
import { Outlet } from "@tanstack/react-router";
import { AppSidebar, type SidebarEntry } from "@/components/AppSidebar";
import { WindowToolbar } from "@/components/WindowToolbar";
import { cn } from "@/lib/utils";
import type { AppPlatform } from "@/core/platform";
import type { RefreshJobStatus } from "@/core/types";
import { tr } from "@/core/i18n";
import type { GlobalPage } from "./app-route";

const globalNav: SidebarEntry<GlobalPage>[] = [
  { id: "home", label: "nav.home", icon: Home },
  { id: "workspaces", label: "nav.workspaces", icon: FolderGit2 },
  { id: "catalog", label: "nav.assets", icon: Library },
  { id: "agents", label: "nav.agents", icon: Bot },
  { id: "quota", label: "nav.quota", icon: Gauge },
  { id: "insights", label: "nav.insights", icon: Award },
];

export function createGlobalNavigation(
  pendingMemoryCount: number,
): SidebarEntry<GlobalPage>[] {
  return globalNav.map((entry) =>
    entry.id === "catalog" ? { ...entry, badge: pendingMemoryCount } : entry,
  );
}

export function GlobalShell({
  active,
  entries,
  collapsed,
  fullscreen,
  platform,
  message,
  refreshJobs,
  onToggleSidebar,
  onNavigate,
  onSettings,
}: {
  active: GlobalPage;
  entries: SidebarEntry<GlobalPage>[];
  collapsed: boolean;
  fullscreen: boolean;
  platform: AppPlatform;
  message: string;
  refreshJobs: RefreshJobStatus[];
  onToggleSidebar: () => void;
  onNavigate: (page: GlobalPage) => void;
  onSettings: () => void;
}) {
  const shellClass = cn(
    "group app-shell !grid !h-full !w-full !min-h-0 !overflow-hidden !grid-cols-[var(--sidebar-width)_minmax(0,1fr)] !grid-rows-[minmax(0,1fr)] !transition-[grid-template-columns] !duration-150",
    collapsed && "sidebar-collapsed !grid-cols-[0_minmax(0,1fr)]",
  );
  const mainClass =
    "!col-start-2 !row-start-1 !flex !min-h-0 !min-w-0 !h-full !flex-col !overflow-hidden !text-sm";
  const pageHeaderClass = cn(
    "page-header !z-10 !flex !min-h-[58px] !h-[58px] !flex-none !items-center !justify-between !border-b !border-[var(--page-header-border)] !bg-[var(--page-header-background)] !pr-7",
    collapsed ? "!pl-[132px]" : "!pl-7",
  );
  const contentClass =
    "content !mx-auto !max-w-[1540px] !px-7 !pb-10 !pt-[22px] max-[900px]:!px-[18px]";
  const discoveryFailure = refreshJobs.find(
    (job) => job.kind === "discovery" && job.state === "failed",
  );

  return (
    <div className={shellClass}>
      <WindowToolbar
        platform={platform}
        fullscreen={fullscreen}
        collapsed={collapsed}
        onToggle={onToggleSidebar}
      />
      <AppSidebar
        active={active}
        entries={entries}
        collapsed={collapsed}
        platform={platform}
        onNavigate={onNavigate}
        onSettings={onSettings}
      />
      {!collapsed && (
        <Button
          className="fixed inset-0 z-20 cursor-default bg-transparent lg:hidden"
          type="button"
          aria-label={tr("common.closeSidebar")}
          onClick={onToggleSidebar}
        />
      )}
      <main className={mainClass}>
        <header className={pageHeaderClass} data-tauri-drag-region />
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
          {message && (
            <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <CircleAlert size={17} />
              {message}
            </div>
          )}
          {active === "workspaces" && discoveryFailure?.error && (
            <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {discoveryFailure.error}
            </div>
          )}
          <section className={cn(contentClass, "")}>
            <Outlet />
          </section>
        </div>
      </main>
    </div>
  );
}
