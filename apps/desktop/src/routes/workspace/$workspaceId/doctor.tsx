import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { LoadingState } from "@/components/ui/loading-state";
import { WorkspaceDoctorPage } from "../../../components/WorkspaceDoctorPage";
import { api } from "../../../core/api";
import { localizeMessage } from "../../../core/i18n";
import { useWorkspaceStore } from "../../../stores/workspace-store";

function WorkspaceDoctorRoute() {
  const navigate = useNavigate();
  const { workspaceId } = useParams({ from: "/workspace/$workspaceId/doctor" });
  const {
    project,
    selectedWorkspace,
    setChangeSet,
    setChangeSetOrigin,
    setHandoffLaunchRequest,
    setMessage,
  } = useWorkspaceStore();
  if (!selectedWorkspace) return <LoadingState label="Loading…" />;
  const planRepairs = async () => {
    if (!project) return;
    try {
      const currentManifest = await api.manifest(project);
      setChangeSet(await api.plan(project, currentManifest, false));
      setChangeSetOrigin("doctor");
      setHandoffLaunchRequest(undefined);
      void navigate({ to: "/workspace/$workspaceId/changes", params: { workspaceId } });
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };
  return <WorkspaceDoctorPage workspace={selectedWorkspace} onRepair={planRepairs} />;
}

export const Route = createFileRoute("/workspace/$workspaceId/doctor")({
  component: WorkspaceDoctorRoute,
});
