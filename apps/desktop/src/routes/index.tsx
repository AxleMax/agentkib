import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { open } from "@tauri-apps/plugin-dialog";
import { GlobalHome } from "../app/AppShell";
import { api } from "../core/api";
import { groupCatalogAssets, workspaceAssetCounts } from "../core/catalog";
import { useAppStore } from "../stores/app-store";
import type { WorkspaceSummary } from "../core/types";

function HomeRoute() {
  const navigate = useNavigate();
  const {
    workspaces,
    doctorSummaries,
    installations,
    globalMemories,
    discovery,
    activity,
    insightsSummary,
    catalog,
  } = useAppStore();
  const groupedCatalog = groupCatalogAssets(catalog);
  const assetCounts = workspaceAssetCounts(groupedCatalog);
  const openWorkspace = async (workspace: WorkspaceSummary, page = "overview") => {
    const path =
      page === "overview" ? "/workspace/$workspaceId" : "/workspace/$workspaceId/" + page;
    await navigate({ to: path as never, params: { workspaceId: workspace.id } as never });
  };
  const addScanRoot = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      await api.addScanRoot(selected, 5);
      await api.requestRefresh("discovery", true);
    }
  };
  return (
    <GlobalHome
      workspaces={workspaces}
      doctorSummaries={doctorSummaries}
      installations={installations}
      memories={globalMemories}
      discovery={discovery}
      activity={activity}
      insights={insightsSummary}
      uniqueAssetCount={groupedCatalog.filter((asset) => asset.scope === "workspace").length}
      assetCounts={assetCounts}
      onShowInsights={() => void navigate({ to: "/insights" })}
      onShowWorkspaces={() => void navigate({ to: "/workspaces" })}
      onShowAgents={() => void navigate({ to: "/agents" })}
      onOpen={openWorkspace}
      onOpenDoctor={(workspace) => openWorkspace(workspace, "doctor")}
      onOpenAssets={(section) =>
        void navigate({ to: "/catalog", search: { assetSection: section } as never })
      }
      onAddRoot={addScanRoot}
    />
  );
}

export const Route = createFileRoute("/")({ component: HomeRoute });
