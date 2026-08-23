import { createRootRoute, Outlet } from "@tanstack/react-router";
import { z } from "zod";
import type { SettingsSection } from "@/features/settings/SettingsSidebar";
import type { InsightsSection } from "@/features/insights/InsightsPage";
import type { AgentKind } from "../core/types";
import { normalizePlatform } from "../core/platform";
import { AppRuntimeBridge } from "../features/app/AppRuntimeBridge";
import { GlobalShell } from "../features/app/GlobalShell";
import { useAppNavigation } from "../features/app/useAppNavigation";

const appPlatform = normalizePlatform(import.meta.env.TAURI_ENV_PLATFORM);

function RootLayout() {
  const {
    route,
    globalPage,
    sidebarCollapsed,
    setSidebarCollapsed,
    isFullscreen,
    message,
    refreshJobs,
    navigation,
    navigateGlobal,
    openSettings,
  } = useAppNavigation();

  return (
    <>
      <AppRuntimeBridge />
      {route.kind === "workspace" || route.kind === "settings" ? (
        <Outlet />
      ) : (
        <GlobalShell
          active={globalPage}
          entries={navigation}
          collapsed={sidebarCollapsed}
          fullscreen={isFullscreen}
          platform={appPlatform}
          message={message}
          refreshJobs={refreshJobs}
          onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
          onNavigate={navigateGlobal}
          onSettings={openSettings}
        />
      )}
    </>
  );
}

const quotaWindowSchema = z.object({
  provider_id: z.string(),
  account_id: z.string().optional(),
  kind: z.string(),
  label: z.string(),
});

const gitSubviewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commit"), oid: z.string() }),
  z.object({
    kind: z.literal("worktree"),
    path: z.string(),
    diffKind: z.enum(["commit", "worktree", "staged"]),
  }),
]);

const searchSchema = z.object({
  assetSection: z
    .enum(["instructions", "skills", "mcp", "memory", "other"])
    .optional()
    .catch(undefined),
  workspaceAssetSection: z
    .enum(["instructions", "skills", "mcp", "native"])
    .optional()
    .catch(undefined),
  workspaceView: z.enum(["list", "storage"]).optional().catch(undefined),
  settingsSection: z
    .enum([
      "general",
      "discovery",
      "integrations",
      "privacy",
      "diagnostics",
    ] satisfies SettingsSection[])
    .optional()
    .catch(undefined),
  insightsSection: z
    .enum(["overview", "tokens", "commits", "milestones", "sources"] satisfies InsightsSection[])
    .optional()
    .catch(undefined),
  quotaProvider: z.string().optional().catch(undefined),
  quotaWindow: quotaWindowSchema.optional().catch(undefined),
  gitSubview: gitSubviewSchema.optional().catch(undefined),
  agent: z.custom<AgentKind>().optional().catch(undefined),
  configure: z.boolean().optional().catch(undefined),
});

export const Route = createRootRoute({
  validateSearch: searchSchema,
  component: RootLayout,
  notFoundComponent: () => <div>Not found</div>,
});
