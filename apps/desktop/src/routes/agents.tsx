import { lazy, Suspense, useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AgentsSkeleton } from "@/features/agents/AgentsSkeleton";
import { useNavigate } from "@tanstack/react-router";
import { useAppStore } from "../stores/app-store";
import type { WorkspaceSummary } from "../core/types";

const AgentsPageLazy = lazy(() =>
  import("@/features/agents/AgentsPage").then(({ AgentsPage }) => ({ default: AgentsPage })),
);

function AgentsRoute() {
  const navigate = useNavigate();
  const installations = useAppStore((state) => state.installations);
  const catalog = useAppStore((state) => state.catalog);
  const assets = useMemo(() => catalog.filter((asset) => asset.scope === "agent-home"), [catalog]);
  const workspaces = useAppStore((state) => state.workspaces);
  const workspacesLoaded = useAppStore((state) => state.workspacesLoaded);
  const remoteGateways = useAppStore((state) => state.remoteGateways);
  const insightsStatus = useAppStore((state) => state.insightsStatus);
  const openWorkspace = async (workspace: WorkspaceSummary) => {
    await navigate({ to: "/workspace/$workspaceId", params: { workspaceId: workspace.id } });
  };

  if (!workspacesLoaded) return <AgentsSkeleton />;

  return (
    <Suspense fallback={<AgentsSkeleton />}>
      <AgentsPageLazy
        installations={installations}
        assets={assets}
        workspaces={workspaces}
        remoteGateways={remoteGateways}
        insightsStatus={insightsStatus}
        onOpen={openWorkspace}
      />
    </Suspense>
  );
}

export const Route = createFileRoute("/agents")({ component: AgentsRoute });
