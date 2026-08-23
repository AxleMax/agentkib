import { createFileRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { LoadingState } from "@/components/ui/loading-state";
import { WorkspaceGitPage, type GitSubview } from "@/features/workspace/WorkspaceGitPage";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";

type GitSearch = { gitSubview?: GitSubview };

function WorkspaceGitRoute() {
  const navigate = useNavigate();
  const { workspaceId } = useParams({ from: "/workspace/$workspaceId/git" });
  const search = useSearch({ strict: false }) as GitSearch;
  const { selectedWorkspace } = useWorkspaceStore();
  if (!selectedWorkspace) return <LoadingState label="Loading…" />;
  return (
    <WorkspaceGitPage
      workspace={selectedWorkspace}
      subview={search.gitSubview}
      onSubviewChange={(gitSubview) =>
        void navigate({
          to: "/workspace/$workspaceId/git",
          params: { workspaceId },
          search: (current) => ({ ...current, gitSubview }) as never,
        })
      }
    />
  );
}

export const Route = createFileRoute("/workspace/$workspaceId/git")({
  component: WorkspaceGitRoute,
});
