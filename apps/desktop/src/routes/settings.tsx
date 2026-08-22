import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "../core/api";
import { GlobalSettings } from "../components/GlobalSettings";
import { localizeMessage, tr } from "../core/i18n";
import { normalizePlatform } from "../core/platform";
import { SettingsSidebar, type SettingsSection } from "../components/SettingsSidebar";
import { WindowToolbar } from "../components/WindowToolbar";
import { useAppStore } from "../stores/app-store";
import { useWorkspaceStore } from "../stores/workspace-store";
import type { CloseBehavior, RuntimeInfo } from "../core/types";

type SettingsSearch = { settingsSection?: SettingsSection };

const platform = normalizePlatform(import.meta.env.TAURI_ENV_PLATFORM);

function SettingsRoute() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as SettingsSearch;
  const section = search.settingsSection ?? "general";
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const isFullscreen = useAppStore((state) => state.isFullscreen);
  const runtime = useAppStore((state) => state.runtime);
  const setRuntime = useAppStore((state) => state.setRuntime);
  const workspaces = useAppStore((state) => state.workspaces);
  const discovery = useAppStore((state) => state.discovery);
  const insightsStatus = useAppStore((state) => state.insightsStatus);
  const quotaStatus = useAppStore((state) => state.quotaStatus);
  const remoteGateways = useAppStore((state) => state.remoteGateways);
  const setRemoteGateways = useAppStore((state) => state.setRemoteGateways);
  const scanRoots = useAppStore((state) => state.scanRoots);
  const setScanRoots = useAppStore((state) => state.setScanRoots);
  const excluded = useAppStore((state) => state.excluded);
  const setExcluded = useAppStore((state) => state.setExcluded);
  const activity = useAppStore((state) => state.activity);
  const { message, setMessage } = useWorkspaceStore();

  const setSection = (nextSection: SettingsSection) => {
    void navigate({
      to: "/settings",
      search: (current) => ({ ...current, settingsSection: nextSection }) as never,
    });
  };

  const run = async (operation: () => Promise<void>) => {
    setMessage("");
    try {
      await operation();
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  const addRoot = () =>
    run(async () => {
      const selected = await open({
        directory: true,
        multiple: false,
        title: tr("dialog.addScanRoot"),
      });
      if (typeof selected !== "string") return;
      await api.addScanRoot(selected, 5);
      setScanRoots(await api.scanRoots());
      await api.requestRefresh("discovery", true);
    });

  const removeRoot = (id: string) =>
    run(async () => {
      await api.removeScanRoot(id);
      setScanRoots(await api.scanRoots());
      await api.requestRefresh("discovery", true);
    });

  const restoreExcluded = (path: string) =>
    run(async () => {
      await api.restoreExcludedWorkspace(path);
      setExcluded(await api.excludedWorkspaces());
      await api.requestRefresh("discovery", true);
    });

  const changeCloseBehavior = (behavior?: CloseBehavior) =>
    run(async () => {
      await api.setCloseBehavior(behavior);
      setRuntime(await api.runtime());
    });

  const refreshRemoteGateways = () =>
    run(async () => {
      setRemoteGateways(await api.remoteGateways());
    });

  const changeRuntime = (nextRuntime: RuntimeInfo) => setRuntime(nextRuntime);

  return (
    <div
      className={cn(
        "group app-shell !grid !h-full !w-full !min-h-0 !overflow-hidden !grid-cols-[var(--sidebar-width)_minmax(0,1fr)] !grid-rows-[minmax(0,1fr)] !transition-[grid-template-columns] !duration-150",
        sidebarCollapsed && "sidebar-collapsed !grid-cols-[0_minmax(0,1fr)]",
      )}
    >
      <WindowToolbar
        platform={platform}
        fullscreen={isFullscreen}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((value) => !value)}
      />
      <SettingsSidebar
        active={section}
        collapsed={sidebarCollapsed}
        platform={platform}
        onSelect={setSection}
        onBack={() => void navigate({ to: "/" })}
      />
      {!sidebarCollapsed && (
        <Button
          className="fixed inset-0 z-20 cursor-default bg-transparent lg:hidden"
          type="button"
          aria-label={tr("common.closeSidebar")}
          onClick={() => setSidebarCollapsed(true)}
        />
      )}
      <main
        className={cn(
          "!col-start-2 !row-start-1 !min-h-0 !min-w-0 !h-full !overflow-x-hidden !overflow-y-auto !overscroll-contain !text-sm",
          `settings-section-${section}`,
        )}
      >
        <header
          className={cn(
            "page-header !sticky !top-0 !z-10 !flex !min-h-[58px] !h-[58px] !items-center !justify-between !border-b !border-[var(--page-header-border)] !bg-[var(--page-header-background)] !pr-7",
            sidebarCollapsed ? "!pl-[132px]" : "!pl-7",
          )}
          data-tauri-drag-region
        />
        {message && (
          <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <CircleAlert size={17} />
            {message}
          </div>
        )}
        <section
          className={cn(
            "mx-auto grid w-full max-w-[1180px] gap-5 px-7 pb-10 pt-[22px] max-[900px]:px-[18px]",
            section === "general" && "pt-4",
          )}
        >
          <GlobalSettings
            section={section}
            runtime={runtime}
            workspaces={workspaces}
            discovery={discovery}
            insightsStatus={insightsStatus}
            quotaStatus={quotaStatus}
            remoteGateways={remoteGateways}
            scanRoots={scanRoots}
            excluded={excluded}
            activity={activity}
            onAddRoot={addRoot}
            onRemoveRoot={removeRoot}
            onRestore={restoreExcluded}
            onCloseBehaviorChanged={changeCloseBehavior}
            onLocaleChanged={changeRuntime}
            onRemoteGatewaysChanged={refreshRemoteGateways}
          />
        </section>
      </main>
    </div>
  );
}

export const Route = createFileRoute("/settings")({ component: SettingsRoute });
