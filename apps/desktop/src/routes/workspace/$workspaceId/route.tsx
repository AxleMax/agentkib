import { useEffect, useRef } from "react";
import {
  createFileRoute,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import {
  Award,
  Bot,
  Boxes,
  Code2,
  FolderGit2,
  Gauge,
  GitCommitHorizontal,
  GitCompareArrows,
  Home,
  LayoutDashboard,
  Library,
  MessageSquareText,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LoadingState } from "@/components/ui/loading-state";
import { AppSidebar, type SidebarEntry } from "@/components/AppSidebar";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { WindowToolbar } from "@/components/WindowToolbar";
import { useAppStore } from "../../../stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { api } from "../../../core/api";
import { localizeMessage, tr } from "../../../core/i18n";
import { normalizePlatform } from "../../../core/platform";
import { cn } from "@/lib/utils";
import type { Manifest, WorkspaceSummary } from "../../../core/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkspaceOpenWith } from "@/features/workspace/WorkspaceOpenWith";
import { Copy, MoreHorizontal, RefreshCw } from "lucide-react";
function WorkspaceActions({
  workspace,
  onError,
  onScan,
  busy,
  onReview,
  reviewDisabled,
}: {
  workspace: WorkspaceSummary;
  onError: (message: string) => void;
  onScan: () => void | Promise<void>;
  busy: boolean;
  onReview: () => void | Promise<void>;
  reviewDisabled: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5 md:gap-2">
      {workspace.status === "attention" && (
        <Badge variant="outline" className="mr-1 border-amber-500/30 bg-amber-500/5 text-amber-700">
          {workspaceStatusLabel("attention")}
        </Badge>
      )}
      <WorkspaceOpenWith workspace={workspace} onError={onError} />
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex size-9 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={tr("common.moreActions")}
          aria-label={tr("common.moreActions")}
        >
          <MoreHorizontal size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void navigator.clipboard?.writeText(workspace.path)}>
            <Copy size={13} />
            {tr("workspace.copyPath")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="outline"
        size="icon"
        className="size-9 rounded-lg"
        title={tr("common.scan")}
        aria-label={tr("common.scan")}
        onClick={() => void onScan()}
        disabled={busy}
      >
        <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
      </Button>
      <Button
        className="h-9 rounded-lg px-3"
        onClick={() => void onReview()}
        disabled={reviewDisabled}
      >
        <GitCompareArrows size={15} />
        {tr("workspace.reviewChanges")}
      </Button>
    </div>
  );
}

function workspaceStatusLabel(status: WorkspaceSummary["status"]) {
  return tr(`status.workspace.${status}`);
}

type GlobalPage = "home" | "workspaces" | "catalog" | "agents" | "quota" | "insights";
type Page = "overview" | "sessions" | "git" | "assets" | "context" | "doctor" | "changes";
const platform = normalizePlatform(import.meta.env.TAURI_ENV_PLATFORM);
const workspaceTabs = [
  ["overview", "nav.overview", LayoutDashboard],
  ["sessions", "nav.sessions", MessageSquareText],
  ["git", "nav.git", GitCommitHorizontal],
  ["assets", "nav.assets", Boxes],
  ["context", "nav.context", Code2],
  ["doctor", "nav.doctor", ShieldCheck],
  ["changes", "nav.changes", GitCompareArrows],
] as const;
const globalNav: SidebarEntry<GlobalPage>[] = [
  { id: "home", label: "nav.home", icon: Home },
  { id: "workspaces", label: "nav.workspaces", icon: FolderGit2 },
  { id: "catalog", label: "nav.assets", icon: Library },
  { id: "agents", label: "nav.agents", icon: Bot },
  { id: "quota", label: "nav.quota", icon: Gauge },
  { id: "insights", label: "nav.insights", icon: Award },
];

function WorkspaceLayout() {
  const dialogs = useAppDialogs();
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaceId } = useParams({ from: "/workspace/$workspaceId" });
  const app = useAppStore();
  const workspaceState = useWorkspaceStore();
  const workspace = app.workspaces.find((item) => item.id === workspaceId);
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    isFullscreen,
    setRuntime,
    globalMemories,
    workspacesLoaded,
  } = app;
  const {
    project,
    selectedWorkspace,
    scan,
    manifest,
    changeSet,
    baselineManifest,
    busy,
    message,
    setScan,
    setManifest,
    setChangeSet,
    setChangeSetOrigin,
    setHandoffLaunchRequest,
    setBaselineManifest,
    setWorkspaceDrafts,
    setBusy,
    setMessage,
    resetWorkspace,
  } = workspaceState;
  const currentPage = getPage(location.pathname);
  const activeWorkspace =
    workspace ??
    (!workspacesLoaded && selectedWorkspace?.id === workspaceId ? selectedWorkspace : undefined);
  const hasUnsavedDraft = Boolean(
    manifest && baselineManifest && JSON.stringify(manifest) !== baselineManifest,
  );
  const operationRequest = useRef(0);

  useEffect(() => {
    operationRequest.current += 1;
    return () => {
      operationRequest.current += 1;
    };
  }, [workspaceId]);

  const loadWorkspace = async (draft?: Manifest) => {
    if (!project) return;
    const requestId = ++operationRequest.current;
    const targetProject = project;
    const isCurrentRequest = () =>
      requestId === operationRequest.current &&
      useWorkspaceStore.getState().selectedWorkspace?.id === workspaceId &&
      useWorkspaceStore.getState().project === targetProject;
    setBusy(true);
    setMessage("");
    try {
      const [nextScan, nextManifest, nextRuntime] = await Promise.all([
        api.scan(targetProject),
        api.manifest(targetProject),
        api.runtime(),
      ]);
      if (!isCurrentRequest()) return;
      setScan(nextScan);
      setManifest(draft ?? nextManifest);
      setBaselineManifest(JSON.stringify(nextManifest));
      setRuntime(nextRuntime);
    } catch (error) {
      if (isCurrentRequest()) setMessage(localizeMessage(error));
    } finally {
      if (isCurrentRequest()) setBusy(false);
    }
  };

  const plan = async (includeHome = false) => {
    if (!project || !manifest) return;
    const requestId = ++operationRequest.current;
    const targetProject = project;
    const targetManifest = manifest;
    const isCurrentRequest = () =>
      requestId === operationRequest.current &&
      useWorkspaceStore.getState().selectedWorkspace?.id === workspaceId &&
      useWorkspaceStore.getState().project === targetProject;
    setBusy(true);
    setMessage("");
    try {
      const nextChangeSet = await api.plan(targetProject, targetManifest, includeHome);
      if (!isCurrentRequest()) return;
      setChangeSet(nextChangeSet);
      setChangeSetOrigin("standard");
      setHandoffLaunchRequest(undefined);
      navigateWorkspace("changes");
    } catch (error) {
      if (isCurrentRequest()) setMessage(localizeMessage(error));
    } finally {
      if (isCurrentRequest()) setBusy(false);
    }
  };

  const leaveWorkspace = async (next: () => void) => {
    if (useWorkspaceStore.getState().applyingChanges) {
      await dialogs.notify(tr("dialog.quit.changesApplying"));
      return;
    }
    if (
      hasUnsavedDraft &&
      !(await dialogs.confirm({
        description: tr("workspace.leaveDraftConfirm"),
        tone: "destructive",
      }))
    )
      return;
    if (useWorkspaceStore.getState().applyingChanges) {
      await dialogs.notify(tr("dialog.quit.changesApplying"));
      return;
    }
    setWorkspaceDrafts((drafts) => {
      const nextDrafts = { ...drafts };
      delete nextDrafts[workspaceId];
      return nextDrafts;
    });
    resetWorkspace();
    next();
  };

  const navigateGlobal = (page: GlobalPage) => {
    void leaveWorkspace(() => navigate({ to: (page === "home" ? "/" : `/${page}`) as never }));
  };

  const navigateWorkspace = (page: Page) => {
    if (useWorkspaceStore.getState().applyingChanges) {
      void dialogs.notify(tr("dialog.quit.changesApplying"));
      return;
    }
    const path =
      page === "overview" ? "/workspace/$workspaceId" : `/workspace/$workspaceId/${page}`;
    void navigate({
      to: path as never,
      params: { workspaceId } as never,
      search: (current) =>
        ({ ...current, ...(page === "git" ? {} : { gitSubview: undefined }) }) as never,
    });
  };

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

  if (!activeWorkspace) {
    return workspacesLoaded ? (
      <div className="grid h-full min-h-[240px] place-items-center p-8 text-sm text-muted-foreground">
        {tr("common.notFound")}
      </div>
    ) : (
      <LoadingState label={tr("common.loading")} />
    );
  }
  return (
    <div className={shellClass}>
      <WindowToolbar
        platform={platform}
        fullscreen={isFullscreen}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((value) => !value)}
      />
      <AppSidebar
        active="workspaces"
        entries={navigation}
        collapsed={sidebarCollapsed}
        platform={platform}
        onNavigate={navigateGlobal}
        onSettings={() => {
          if (useWorkspaceStore.getState().applyingChanges) {
            void dialogs.notify(tr("dialog.quit.changesApplying"));
            return;
          }
          void navigate({ to: "/settings" });
        }}
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
              {message}
            </div>
          )}
          <div className={cn(contentClass, "grid gap-4 pt-5")}>
            <section className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card px-5 py-4 shadow-sm md:flex-row md:items-center md:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-foreground text-background">
                  <FolderGit2 size={21} />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
                      {activeWorkspace.name}
                    </h1>
                    <Badge
                      variant={activeWorkspace.status === "attention" ? "destructive" : "secondary"}
                    >
                      {workspaceStatusLabel(activeWorkspace.status)}
                    </Badge>
                  </div>
                  <code className="mt-1 block truncate text-xs text-muted-foreground">
                    {activeWorkspace.path}
                  </code>
                </div>
              </div>
              <WorkspaceActions
                workspace={activeWorkspace}
                onError={setMessage}
                onScan={() => loadWorkspace(manifest)}
                busy={busy}
                onReview={() => plan(false)}
                reviewDisabled={busy || !hasUnsavedDraft}
              />
            </section>
            <nav
              className="rounded-xl border border-border/70 bg-card px-2 shadow-sm"
              aria-label={activeWorkspace.name}
            >
              <Tabs value={currentPage} onValueChange={(value) => navigateWorkspace(value as Page)}>
                <TabsList
                  className="w-full justify-start gap-1 overflow-x-auto rounded-none border-0 bg-transparent px-0"
                  variant="line"
                >
                  {workspaceTabs.map(([id, label, Icon]) => (
                    <TabsTrigger
                      className="min-h-11 flex-none rounded-none px-3 text-xs sm:text-sm"
                      key={id}
                      value={id}
                    >
                      <Icon size={15} />
                      {tr(label)}
                      {id === "changes" && changeSet?.changes.length ? (
                        <em>{changeSet.changes.length}</em>
                      ) : null}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </nav>
            <section
              className={cn("min-w-0", currentPage === "git" && "min-h-[calc(100vh-170px)]")}
            >
              {busy || (currentPage !== "doctor" && (!scan || !manifest)) ? (
                <LoadingState label={tr("common.loading")} />
              ) : (
                <Outlet />
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

function getPage(pathname: string): Page {
  const value = pathname.split("/").filter(Boolean).at(-1);
  return value === "sessions" ||
    value === "git" ||
    value === "assets" ||
    value === "context" ||
    value === "doctor" ||
    value === "changes"
    ? value
    : "overview";
}

export const Route = createFileRoute("/workspace/$workspaceId")({ component: WorkspaceLayout });
