import { createRootRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AppShell } from "../app/AppShell";
import type { SettingsSection } from "../components/SettingsSidebar";
import type { InsightsSection } from "../components/InsightsPage";
import type { AgentKind } from "../core/types";

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
  component: AppShell,
  notFoundComponent: () => <div>Not found</div>,
});
