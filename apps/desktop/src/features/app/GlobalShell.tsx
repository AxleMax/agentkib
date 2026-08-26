import { Award, Bot, CircleAlert, FolderGit2, Gauge, Home, Library } from "lucide-react";
import { Outlet } from "@tanstack/react-router";
import { AppSidebar, type SidebarEntry } from "@/components/AppSidebar";
import { WindowToolbar } from "@/components/WindowToolbar";
import { cn } from "@/lib/utils";
import type { RefreshJobStatus } from "@/core/types";
import type { GlobalPage } from "./app-route";

const globalNav: SidebarEntry<GlobalPage>[] = [
  { id: "home", label: "nav.home", icon: Home },
  { id: "workspaces", label: "nav.workspaces", icon: FolderGit2 },
  { id: "catalog", label: "nav.assets", icon: Library },
  { id: "agents", label: "nav.agents", icon: Bot },
  { id: "quota", label: "nav.quota", icon: Gauge },
  { id: "insights", label: "nav.insights", icon: Award },
];

export function createGlobalNavigation(pendingMemoryCount: number): SidebarEntry<GlobalPage>[] {
  return globalNav.map((entry) =>
    entry.id === "catalog" ? { ...entry, badge: pendingMemoryCount } : entry,
  );
}

export function GlobalShell({
  active,
  entries,
  message,
  refreshJobs,
  onNavigate,
  onSettings,
}: {
  active: GlobalPage;
  entries: SidebarEntry<GlobalPage>[];
  message: string;
  refreshJobs: RefreshJobStatus[];
  onNavigate: (page: GlobalPage) => void;
  onSettings: () => void;
}) {
  const shellClass = "group app-shell !grid !h-full !w-full !min-h-0 !overflow-hidden";
  const mainClass =
    "!col-start-1 !row-start-3 !flex !min-h-0 !min-w-0 !h-full !flex-col !overflow-hidden !text-sm";
  const contentClass =
    "content !mx-auto !max-w-[1540px] !px-7 !pb-10 !pt-[14px] max-[900px]:!px-[18px]";
  const discoveryFailure = refreshJobs.find(
    (job) => job.kind === "discovery" && job.state === "failed",
  );

  return (
    <div className={shellClass}>
      <WindowToolbar />
      <AppSidebar
        active={active}
        entries={entries}
        onNavigate={onNavigate}
        onSettings={onSettings}
        onBrandClick={() => onNavigate("home")}
      />
      <main className={mainClass}>
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
