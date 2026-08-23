import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { Award, Bot, CircleAlert, FolderGit2, Gauge, Home, Library } from "lucide-react";
import { api } from "./core/api";
import { refreshGlobalState } from "./core/global-state";
import { cn } from "@/lib/utils";
import { AppSidebar, type SidebarEntry } from "@/components/AppSidebar";
import { type SettingsSection } from "@/features/settings/SettingsSidebar";
import { WindowToolbar } from "@/components/WindowToolbar";
import type { AssetSection } from "@/features/home/GlobalHome";
import type { GitSubview } from "@/features/workspace/WorkspaceGitPage";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { changeLocale, localizeMessage, tr } from "./core/i18n";
import { applyTheme } from "./core/theme";
import { normalizePlatform } from "./core/platform";
import { useAppStore } from "./stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type {
  AppMenuCommandRequest,
  AppNavigationRequest,
  DiscoveryReport,
  EffectiveTheme,
  InsightsSummary,
  Manifest,
  QuotaWindowSelector,
  RefreshJobStatus,
  RefreshKind,
  RemoteGatewaySummary,
  WorkspaceSummary,
} from "./core/types";

export type Page = "overview" | "sessions" | "git" | "assets" | "context" | "doctor" | "changes";
type GlobalPage = "home" | "workspaces" | "catalog" | "agents" | "quota" | "insights";

const buildPlatform = import.meta.env.TAURI_ENV_PLATFORM;
const appPlatform = normalizePlatform(buildPlatform);

const globalNav: SidebarEntry<GlobalPage>[] = [
  { id: "home", label: "nav.home", icon: Home },
  { id: "workspaces", label: "nav.workspaces", icon: FolderGit2 },
  { id: "catalog", label: "nav.assets", icon: Library },
  { id: "agents", label: "nav.agents", icon: Bot },
  { id: "quota", label: "nav.quota", icon: Gauge },
  { id: "insights", label: "nav.insights", icon: Award },
];

type AppSearch = {
  assetSection?: AssetSection;
  settingsSection?: SettingsSection;
  quotaProvider?: string;
  quotaWindow?: QuotaWindowSelector;
  gitSubview?: GitSubview;
};

export function AppShell() {
  useTranslation();
  const dialogs = useAppDialogs();
  const navigate = useNavigate();
  const location = useLocation();
  const search = useSearch({ strict: false }) as AppSearch;
  const route = parseRoute(location.pathname);
  const workspaceRouteId = route.kind === "workspace" ? route.workspaceId : undefined;
  const workspaceRoutePage = route.kind === "workspace" ? route.page : undefined;
  const routeGlobalPage = route.kind === "global" ? route.page : "home";
  const [pendingGlobalPage, setPendingGlobalPage] = useState<GlobalPage>();
  const globalPage = pendingGlobalPage ?? routeGlobalPage;
  const appMode = route.kind === "settings" ? "settings" : "main";
  const settingsSection = search.settingsSection ?? "general";
  const quotaProvider = search.quotaProvider;
  const quotaWindow = search.quotaWindow;
  const appStore = useAppStore();
  const workspaceStore = useWorkspaceStore();
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    isFullscreen,
    setIsFullscreen,
    setRuntime,
    workspaces,
    setWorkspaces,
    setWorkspacesLoaded,
    setInstallations,
    setDoctorSummaries,
    setCatalog,
    globalMemories,
    setDiscovery,
    setRemoteGateways,
    setInsightsSummary,
    setQuotaStatus,
    navigationRequest,
    setNavigationRequest,
    menuCommand,
    setMenuCommand,
    refreshJobs,
    setRefreshJobs,
    setQuotaConfigureRequest,
  } = appStore;
  const {
    project,
    setProject,
    selectedWorkspace,
    setSelectedWorkspace,
    setScan,
    manifest,
    setManifest,
    setChangeSet,
    setChangeSetOrigin,
    setHandoffLaunchRequest,
    baselineManifest,
    setBaselineManifest,
    workspaceDrafts,
    setWorkspaceDrafts,
    message,
    setMessage,
    setBusy,
    applyingChanges,
  } = workspaceStore;
  const pendingRefreshKinds = useRef(new Set<string>());
  const quitPromptOpen = useRef(false);
  const workspaceOpenRequest = useRef(0);
  const updateSearch = (patch: Partial<AppSearch>) => {
    void navigate({
      to: location.pathname as never,
      search: (current) => ({ ...current, ...patch }) as never,
    });
  };
  const navigateGlobalPage = (nextPage: GlobalPage) => {
    setPendingGlobalPage(nextPage);
    const path = nextPage === "home" ? "/" : `/${nextPage}`;
    void navigate({ to: path as never });
  };
  const navigateWorkspacePageFor = (workspaceId: string, nextPage: Page) => {
    const path =
      nextPage === "overview" ? "/workspace/$workspaceId" : `/workspace/$workspaceId/${nextPage}`;
    void navigate({ to: path as never, params: { workspaceId } as never });
  };
  const setAppMode = (nextMode: "main" | "settings") => {
    if (nextMode === "settings") void navigate({ to: "/settings", search: (current) => current });
    else navigateGlobalPage(globalPage);
  };
  const setGitSubview = (nextSubview: GitSubview | undefined) =>
    updateSearch({ gitSubview: nextSubview });
  useEffect(() => {
    if (pendingGlobalPage === routeGlobalPage) setPendingGlobalPage(undefined);
  }, [pendingGlobalPage, routeGlobalPage]);

  const load = async (path = project, draft?: Manifest) => {
    if (!path) return;
    setBusy(true);
    setMessage("");
    try {
      const [nextScan, nextManifest, nextRuntime] = await Promise.all([
        api.scan(path),
        api.manifest(path),
        api.runtime(),
      ]);
      setProject(path);
      setScan(nextScan);
      setManifest(draft ?? nextManifest);
      setBaselineManifest(JSON.stringify(nextManifest));
      setRuntime(nextRuntime);
    } catch (error) {
      setMessage(localizeMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const loadGlobal = async () => {
    await refreshGlobalState(useAppStore.getState().runtime);
  };

  const loadDiscoveryCache = async () => {
    const [nextWorkspaces, nextInstallations, nextCatalog] = await Promise.all([
      api.workspaces(),
      api.agentInstallations(),
      api.catalogAssets(),
    ]);
    setWorkspaces(nextWorkspaces);
    setWorkspacesLoaded(true);
    setInstallations(nextInstallations);
    setCatalog(nextCatalog);
    try {
      const summaries = await api.workspaceDoctorSummaries(
        nextWorkspaces.map((workspace) => workspace.id),
      );
      setDoctorSummaries(
        Object.fromEntries(summaries.map((summary) => [summary.workspace_id, summary])),
      );
    } catch {
      setDoctorSummaries({});
    }
  };

  useEffect(() => {
    let disposed = false;
    let refreshReloadTimer: number | undefined;
    let unlisten: (() => void) | undefined;
    let unlistenRefresh: (() => void) | undefined;
    let unlistenInsights: (() => void) | undefined;
    let unlistenGateways: (() => void) | undefined;
    let unlistenQuota: (() => void) | undefined;
    let unlistenNavigate: (() => void) | undefined;
    let unlistenMenuCommand: (() => void) | undefined;
    let unlistenTheme: (() => void) | undefined;
    void (async () => {
      try {
        unlisten = await listen<DiscoveryReport>("agentkib:discovery-updated", (event) => {
          setDiscovery(event.payload);
        });
        unlistenRefresh = await listen<RefreshJobStatus>("agentkib:refresh-state", (event) => {
          setRefreshJobs((current) => [
            ...current.filter((job) => job.kind !== event.payload.kind),
            event.payload,
          ]);
          if (event.payload.kind === "discovery" && event.payload.state === "succeeded") {
            if (document.visibilityState !== "visible") {
              pendingRefreshKinds.current.add("discovery");
              return;
            }
            window.clearTimeout(refreshReloadTimer);
            refreshReloadTimer = window.setTimeout(() => {
              if (!disposed) void loadDiscoveryCache();
            }, 100);
          }
        });
        unlistenInsights = await listen<InsightsSummary>("agentkib:insights-updated", (event) => {
          setInsightsSummary(event.payload);
        });
        unlistenGateways = await listen<RemoteGatewaySummary[]>(
          "agentkib:remote-gateways-updated",
          (event) => {
            setRemoteGateways(event.payload);
          },
        );
        unlistenQuota = await listen("agentkib:quota-updated", () => {
          void api.quotaCollectorStatus().then(setQuotaStatus);
        });
        unlistenNavigate = await listen<AppNavigationRequest>("agentkib:navigate", (event) => {
          setNavigationRequest(event.payload);
        });
        unlistenMenuCommand = await listen<AppMenuCommandRequest>(
          "agentkib:app-command",
          (event) => {
            setMenuCommand(event.payload);
          },
        );
        unlistenTheme = await listen<EffectiveTheme>("tauri://theme-changed", (event) => {
          setRuntime((current) => {
            if (!current || current.theme_preference !== "system") return current;
            applyTheme(event.payload);
            return { ...current, effective_theme: event.payload };
          });
        });
        const legacy = localStorage.getItem("agentkib.project");
        if (legacy) {
          await api.addWorkspace(legacy);
          localStorage.removeItem("agentkib.project");
        }
        await loadGlobal();
        if (!disposed) setRefreshJobs(await api.refreshStatus());
      } catch (error) {
        if (!disposed) setMessage(localizeMessage(error));
      }
    })();
    return () => {
      disposed = true;
      window.clearTimeout(refreshReloadTimer);
      unlisten?.();
      unlistenRefresh?.();
      unlistenInsights?.();
      unlistenGateways?.();
      unlistenQuota?.();
      unlistenNavigate?.();
      unlistenMenuCommand?.();
      unlistenTheme?.();
    };
  }, []);
  useEffect(() => {
    localStorage.setItem("agentkib.sidebar.collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);
  useEffect(() => {
    if (appPlatform !== "macos") return;

    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const syncFullscreen = async () => {
      try {
        const fullscreen = await appWindow.isFullscreen();
        if (!disposed) setIsFullscreen(fullscreen);
      } catch {
        if (!disposed) setIsFullscreen(false);
      }
    };

    void syncFullscreen();
    void appWindow
      .onResized(() => {
        void syncFullscreen();
      })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    const refreshRuntime = () => {
      if (pendingRefreshKinds.current.delete("discovery")) void loadDiscoveryCache();
      void api
        .runtime()
        .then(async (nextRuntime) => {
          setRuntime(nextRuntime);
          applyTheme(nextRuntime.effective_theme);
          await changeLocale(nextRuntime.effective_locale);
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", refreshRuntime);
    return () => window.removeEventListener("focus", refreshRuntime);
  }, []);

  const selectProject = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: tr("dialog.addWorkspace"),
    });
    if (typeof selected === "string") {
      const workspace = await api.addWorkspace(selected);
      await loadGlobal();
      await openWorkspace(workspace);
    }
  };

  const hasUnsavedDraft = Boolean(
    manifest && baselineManifest && JSON.stringify(manifest) !== baselineManifest,
  );
  const hasAnyUnsavedDraft = hasUnsavedDraft || Object.keys(workspaceDrafts).length > 0;
  const quitState = useRef({ hasUnsavedDraft: hasAnyUnsavedDraft, applyingChanges });
  quitState.current = { hasUnsavedDraft: hasAnyUnsavedDraft, applyingChanges };
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("agentkib:quit-requested", async () => {
      if (quitPromptOpen.current) return;
      quitPromptOpen.current = true;
      try {
        if (quitState.current.applyingChanges) {
          await dialogs.notify(tr("dialog.quit.changesApplying"));
          return;
        }
        if (
          quitState.current.hasUnsavedDraft &&
          !(await dialogs.confirm({
            description: tr("dialog.quit.discardDraft"),
            tone: "destructive",
          }))
        )
          return;
        await api.quitApp();
      } finally {
        quitPromptOpen.current = false;
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [dialogs]);
  useEffect(() => {
    if (!navigationRequest) return;
    if (navigationRequest.page === "settings") {
      void navigate({
        to: "/settings",
        search: { settingsSection: navigationRequest.settings_section ?? "general" } as never,
      });
      setNavigationRequest(undefined);
      return;
    }
    if (navigationRequest.page === "quota") {
      navigateGlobalWithSearch("quota", {
        quotaProvider: navigationRequest.provider,
        quotaWindow: navigationRequest.window,
      });
      if (navigationRequest.configure_popover) setQuotaConfigureRequest((value) => value + 1);
    } else {
      navigateGlobal(navigationRequest.page);
    }
    setNavigationRequest(undefined);
  }, [navigationRequest]);
  const persistWorkspaceDraft = () => {
    if (selectedWorkspace && manifest && hasUnsavedDraft)
      setWorkspaceDrafts((drafts) => ({ ...drafts, [selectedWorkspace.id]: manifest }));
  };
  const leaveWorkspace = async (next: () => void) => {
    if (
      hasUnsavedDraft &&
      !(await dialogs.confirm({
        description: tr("workspace.leaveDraftConfirm"),
        tone: "destructive",
      }))
    )
      return;
    workspaceOpenRequest.current += 1;
    if (selectedWorkspace)
      setWorkspaceDrafts((drafts) => {
        const nextDrafts = { ...drafts };
        delete nextDrafts[selectedWorkspace.id];
        return nextDrafts;
      });
    setGitSubview(undefined);
    setSelectedWorkspace(undefined);
    setProject("");
    setScan(undefined);
    setManifest(undefined);
    setChangeSet(undefined);
    setChangeSetOrigin("standard");
    setHandoffLaunchRequest(undefined);
    setBaselineManifest("");
    next();
  };
  const openWorkspace = async (workspace: WorkspaceSummary, initialPage: Page = "overview") => {
    const requestId = ++workspaceOpenRequest.current;
    persistWorkspaceDraft();
    setBusy(true);
    setMessage("");
    try {
      const runtimePromise = useAppStore.getState().runtime
        ? Promise.resolve(useAppStore.getState().runtime)
        : api.runtime();
      const [nextScan, nextRuntime] = await Promise.all([api.scan(workspace.path), runtimePromise]);
      if (requestId !== workspaceOpenRequest.current) return;
      let nextManifest: Manifest | undefined;
      try {
        nextManifest = await api.manifest(workspace.path);
      } catch (error) {
        if (requestId === workspaceOpenRequest.current) setMessage(localizeMessage(error));
      }
      if (requestId !== workspaceOpenRequest.current) return;
      setGitSubview(undefined);
      setChangeSet(undefined);
      setChangeSetOrigin("standard");
      setHandoffLaunchRequest(undefined);
      setProject(workspace.path);
      setScan(nextScan);
      setManifest(nextManifest ? (workspaceDrafts[workspace.id] ?? nextManifest) : undefined);
      setBaselineManifest(nextManifest ? JSON.stringify(nextManifest) : "");
      setRuntime(nextRuntime);
      // Commit the route last so the workspace list remains visible while native scanning runs.
      setSelectedWorkspace(workspace);
      navigateWorkspacePageFor(workspace.id, nextManifest ? initialPage : "doctor");
    } catch (error) {
      if (requestId === workspaceOpenRequest.current) setMessage(localizeMessage(error));
    } finally {
      if (requestId === workspaceOpenRequest.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (route.kind !== "workspace") workspaceOpenRequest.current += 1;
  }, [route.kind]);
  useEffect(() => {
    if (
      route.kind !== "workspace" ||
      selectedWorkspace?.id === workspaceRouteId ||
      !useAppStore.getState().workspacesLoaded ||
      !workspaceRouteId
    )
      return;
    const workspace = workspaces.find((item) => item.id === workspaceRouteId);
    if (workspace) void openWorkspace(workspace, workspaceRoutePage ?? "overview");
    else setMessage(tr("common.notFound"));
  }, [route.kind, workspaceRouteId, workspaceRoutePage, selectedWorkspace?.id, workspaces]);
  const navigateGlobalWithSearch = (nextPage: GlobalPage, patch: Partial<AppSearch> = {}) => {
    const path = nextPage === "home" ? "/" : `/${nextPage}`;
    void navigate({ to: path as never, search: (current) => ({ ...current, ...patch }) as never });
  };
  const navigateGlobal = (nextPage: GlobalPage, preserveQuotaSelection = false) => {
    const next = () =>
      navigateGlobalWithSearch(
        nextPage,
        preserveQuotaSelection
          ? { quotaProvider, quotaWindow }
          : { quotaProvider: undefined, quotaWindow: undefined },
      );
    if (selectedWorkspace) void leaveWorkspace(next);
    else {
      workspaceOpenRequest.current += 1;
      next();
    }
  };
  const openSettings = () => setAppMode("settings");

  const refreshDiscovery = async () => {
    setMessage("");
    try {
      await api.requestRefresh("discovery", true);
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };
  const requestRefreshKinds = async (kinds: RefreshKind[]) => {
    setMessage("");
    try {
      await Promise.all(kinds.map((kind) => api.requestRefresh(kind, true)));
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };
  const refreshCurrentView = async () => {
    if (selectedWorkspace && project && manifest) {
      await load(project, manifest);
      return;
    }
    if (appMode === "settings") {
      if (settingsSection === "discovery") await requestRefreshKinds(["discovery"]);
      else if (settingsSection === "integrations") await requestRefreshKinds(["gateways"]);
      else if (settingsSection === "diagnostics")
        await requestRefreshKinds(["discovery", "insights", "gateways", "quota"]);
      else await loadGlobal();
      return;
    }
    if (globalPage === "quota") await requestRefreshKinds(["quota"]);
    else if (globalPage === "insights") await requestRefreshKinds(["insights"]);
    else await requestRefreshKinds(["discovery"]);
  };
  useEffect(() => {
    if (!menuCommand) return;
    setMenuCommand(undefined);
    if (menuCommand.command === "add-workspace") void selectProject();
    else if (menuCommand.command === "add-scan-root") void addScanRootFromDialog();
    else if (menuCommand.command === "toggle-sidebar") setSidebarCollapsed((value) => !value);
    else if (menuCommand.command === "refresh-current") void refreshCurrentView();
    else if (menuCommand.command === "refresh-all")
      void dialogs.confirm(tr("menu.refreshAllConfirm")).then((confirmed) => {
        if (confirmed) void requestRefreshKinds(["discovery", "insights", "gateways", "quota"]);
      });
  }, [dialogs, menuCommand]);
  const navigation = globalNav.map((entry) =>
    entry.id === "catalog"
      ? { ...entry, badge: globalMemories.filter((item) => item.status === "pending").length }
      : entry,
  );
  const shellClass = cn(
    "group app-shell !grid !h-full !w-full !min-h-0 !overflow-hidden !grid-cols-[var(--sidebar-width)_minmax(0,1fr)] !grid-rows-[minmax(0,1fr)] !transition-[grid-template-columns] !duration-150",
    sidebarCollapsed && "sidebar-collapsed !grid-cols-[0_minmax(0,1fr)]",
  );
  const mainClass =
    "!col-start-2 !row-start-1 !flex !min-h-0 !min-w-0 !h-full !flex-col !overflow-hidden !text-sm";
  const pageHeaderClass = cn(
    "page-header !z-10 !flex !min-h-[58px] !h-[58px] !flex-none !items-center !justify-between !border-b !border-[var(--page-header-border)] !bg-[var(--page-header-background)] !pr-7",
    sidebarCollapsed ? "!pl-[132px]" : "!pl-7",
  );
  const contentClass =
    "content !mx-auto !max-w-[1540px] !px-7 !pb-10 !pt-[22px] max-[900px]:!px-[18px]";
  if (route.kind === "workspace" || appMode === "settings") return <Outlet />;

  const discoveryFailure = refreshJobs.find(
    (job) => job.kind === "discovery" && job.state === "failed",
  );
  return (
    <div className={shellClass}>
      <WindowToolbar
        platform={appPlatform}
        fullscreen={isFullscreen}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((value) => !value)}
      />
      <AppSidebar
        active={globalPage}
        entries={navigation}
        collapsed={sidebarCollapsed}
        platform={appPlatform}
        onNavigate={navigateGlobal}
        onSettings={openSettings}
      />
      {!sidebarCollapsed && (
        <Button
          className="fixed inset-0 z-20 cursor-default bg-transparent lg:hidden"
          type="button"
          aria-label={tr("common.closeSidebar")}
          onClick={() => setSidebarCollapsed(true)}
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
          {globalPage === "workspaces" && discoveryFailure?.error && (
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

  async function addScanRootFromDialog() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: tr("dialog.addScanRoot"),
    });
    if (typeof selected === "string") {
      await api.addScanRoot(selected, 5);
      await loadGlobal();
      await refreshDiscovery();
    }
  }
}

type ParsedRoute =
  | { kind: "settings" }
  | { kind: "global"; page: GlobalPage }
  | { kind: "workspace"; workspaceId: string; page: Page };

function parseRoute(pathname: string): ParsedRoute {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "settings") return { kind: "settings" };
  if (segments[0] === "workspace" && segments[1]) {
    const page = segments[2];
    const workspacePage: Page =
      page === "sessions" ||
      page === "git" ||
      page === "assets" ||
      page === "context" ||
      page === "doctor" ||
      page === "changes"
        ? page
        : "overview";
    return { kind: "workspace", workspaceId: segments[1], page: workspacePage };
  }
  const page = segments[0];
  const globalPage: GlobalPage =
    page === "workspaces" ||
    page === "catalog" ||
    page === "agents" ||
    page === "quota" ||
    page === "insights"
      ? page
      : "home";
  return { kind: "global", page: globalPage };
}
