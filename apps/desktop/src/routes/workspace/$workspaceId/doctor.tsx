import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { WorkspaceDoctorSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { WorkspaceDoctorPage } from "@/features/workspace/WorkspaceDoctorPage";
import { api } from "../../../core/api";
import { localizeMessage } from "../../../core/i18n";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";

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
  const repairRequest = useRef(0);
  useEffect(
    () => () => {
      repairRequest.current += 1;
    },
    [],
  );
  if (!selectedWorkspace) return <WorkspaceDoctorSkeleton />;
  const planRepairs = async () => {
    if (!project) return;
    const requestId = ++repairRequest.current;
    const targetProject = project;
    try {
      const currentManifest = await api.manifest(targetProject);
      if (requestId !== repairRequest.current) return;
      const nextChangeSet = await api.plan(targetProject, currentManifest, false);
      if (requestId !== repairRequest.current) return;
      if (useWorkspaceStore.getState().selectedWorkspace?.id !== workspaceId) return;
      setChangeSet(nextChangeSet);
      setChangeSetOrigin("doctor");
      setHandoffLaunchRequest(undefined);
      void navigate({ to: "/workspace/$workspaceId/changes", params: { workspaceId } });
    } catch (error) {
      if (requestId === repairRequest.current) setMessage(localizeMessage(error));
    }
  };
  return <WorkspaceDoctorPage workspace={selectedWorkspace} onRepair={planRepairs} />;
}

export const Route = createFileRoute("/workspace/$workspaceId/doctor")({
  component: WorkspaceDoctorRoute,
});
