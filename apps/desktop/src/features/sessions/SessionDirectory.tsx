import { useLayoutEffect, useRef } from "react";
import { Ellipsis, Folder, FolderOpen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { tr } from "@/core/i18n";
import { useSessionHub } from "./SessionHubContext";
import { useSessionViewStore, type SessionRecordFilter } from "./session-view-store";
import { sessionAgentNames, sessionRecordLabel } from "./session-labels";
import type { AgentKind } from "@/core/types";

export function SessionDirectory({
  onMenuOpenChange,
}: { onMenuOpenChange?: (open: boolean) => void } = {}) {
  const hub = useSessionHub();
  const view = useSessionViewStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = useSessionViewStore.getState().scrollTop;
  }, [hub.ready]);
  const agents = [...new Set(hub.sessions.map((session) => session.agent))];
  const groups = hub.workspaces
    .map((workspace) => ({
      workspace,
      sessions: hub.filtered.filter((session) => session.workspace_id === workspace.id),
    }))
    .filter((group) => group.sessions.length > 0)
    .sort(
      (a, b) =>
        (b.sessions[0]?.updated_at ?? "").localeCompare(a.sessions[0]?.updated_at ?? "") ||
        a.workspace.id.localeCompare(b.workspace.id),
    );
  return (
    <div className="session-directory" aria-label={tr("sessions.directory")}>
      <div className="session-directory-controls">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <span className="text-sm font-medium text-muted-foreground">
            {tr("sessions.directory")}
          </span>
          <DropdownMenu onOpenChange={onMenuOpenChange}>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" />}
              aria-label={tr("sessions.directoryOptions")}
              disabled={!hub.enabled}
            >
              <Ellipsis size={18} aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48" positionerClassName="z-80">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>{tr("conversations.agentFilter")}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-44" positionerClassName="z-80">
                  <DropdownMenuRadioGroup
                    value={view.agent}
                    onValueChange={(value) => view.setAgent(value as AgentKind | "all")}
                  >
                    <DropdownMenuRadioItem value="all">
                      {tr("sessions.allAgents")}
                    </DropdownMenuRadioItem>
                    {[...new Set([...agents, ...(view.agent === "all" ? [] : [view.agent])])].map(
                      (agent) => (
                        <DropdownMenuRadioItem key={agent} value={agent}>
                          {sessionAgentNames[agent]}
                        </DropdownMenuRadioItem>
                      ),
                    )}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>{tr("conversations.filterLabel")}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-44" positionerClassName="z-80">
                  <DropdownMenuRadioGroup
                    value={view.filter}
                    onValueChange={(value) => view.setFilter(value as SessionRecordFilter)}
                  >
                    {(["current", "archived", "metadata", "all"] as const).map((filter) => (
                      <DropdownMenuRadioItem key={filter} value={filter}>
                        {tr(`conversations.filter.${filter}`)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={view.agent === "all" && view.filter === "current"}
                onClick={view.resetFilters}
              >
                {tr("sessions.clearFilters")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {(view.agent !== "all" || view.filter !== "current") && (
          <div className="flex flex-wrap gap-1.5">
            {view.agent !== "all" && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 rounded-full px-2 text-xs"
                aria-label={`${tr("sessions.clearAgentFilter")}: ${sessionAgentNames[view.agent]}`}
                disabled={!hub.enabled}
                onClick={() => view.setAgent("all")}
              >
                {sessionAgentNames[view.agent]}
                <X size={12} aria-hidden="true" />
              </Button>
            )}
            {view.filter !== "current" && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 rounded-full px-2 text-xs"
                aria-label={`${tr("sessions.clearRecordFilter")}: ${tr(`conversations.filter.${view.filter}`)}`}
                disabled={!hub.enabled}
                onClick={() => view.setFilter("current")}
              >
                {tr(`conversations.filter.${view.filter}`)}
                <X size={12} aria-hidden="true" />
              </Button>
            )}
          </div>
        )}
      </div>
      <div
        className="session-directory-tree"
        ref={scrollRef}
        onScroll={(event) => view.setScrollTop(event.currentTarget.scrollTop)}
      >
        {groups.map(({ workspace, sessions }) => (
          <Collapsible
            className="session-workspace"
            key={workspace.id}
            open={!view.collapsed[workspace.id]}
            onOpenChange={() => view.toggleWorkspace(workspace.id)}
          >
            <CollapsibleTrigger
              render={<Button variant="bare" size="content" className="session-workspace-heading" />}
              title={`${workspace.name}\n${workspace.path}`}
            >
              {view.collapsed[workspace.id] ? (
                <Folder size={16} aria-hidden="true" />
              ) : (
                <FolderOpen size={16} aria-hidden="true" />
              )}
              <strong>{workspace.name}</strong>
              <span>{sessions.length}</span>
            </CollapsibleTrigger>
            <CollapsibleContent
              className="session-workspace-items"
              inert={Boolean(view.collapsed[workspace.id])}
              aria-hidden={view.collapsed[workspace.id] || undefined}
            >
              {sessions.map((session) => (
                <Button
                  variant="bare"
                  size="content"
                  key={session.id}
                  data-session-entry
                  className="session-directory-item"
                  aria-current={hub.selected?.id === session.id ? "page" : undefined}
                  onClick={() => hub.select(session.id)}
                  title={`${displaySessionTitle(session.title)}\n${sessionAgentNames[session.agent]} · ${sessionRecordLabel(session)}\n${workspace.path}`}
                >
                  <AgentIcon agent={session.agent} compact />
                  <span>
                    <strong>{displaySessionTitle(session.title)}</strong>
                  </span>
                </Button>
              ))}
            </CollapsibleContent>
          </Collapsible>
        ))}
        {hub.enabled && !hub.loading && !groups.length && (
          <div className="session-directory-empty">
            <p>{tr(hub.sessions.length ? "sessions.noMatches" : "sessions.noSessions")}</p>
            {hub.sessions.length > 0 && (
              <Button variant="ghost" onClick={view.resetFilters}>
                {tr("sessions.clearFilters")}
              </Button>
            )}
          </div>
        )}
        {hub.loading && (
          <p className="session-directory-empty" role="status">
            {tr("conversations.scanning")}
          </p>
        )}
      </div>
    </div>
  );
}
