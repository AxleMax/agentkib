import { Bot, UserRound, Wrench } from "lucide-react";
import { MarkdownContent } from "@/components/MarkdownContent";
import { formatDateTime, tr } from "@/core/i18n";
import type { ConversationEvent } from "@/core/types";

export function ConversationEventRow({
  event,
  variant = "workspace",
}: {
  event: ConversationEvent;
  variant?: "workspace" | "hub";
}) {
  const hub = variant === "hub";
  if (event.kind === "tool-summary") {
    return (
      <div
        className={`${hub ? "session-hub-event session-hub-tool text-sm" : "text-xs"} flex min-h-[38px] items-center gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-muted-foreground shadow-xs`}
      >
        <span className="grid size-5 place-items-center rounded-md bg-muted">
          <Wrench size={12} />
        </span>
        <strong className="text-foreground">{event.tool_name || tr("conversations.tool")}</strong>
        <span>{tr(`conversations.toolStatus.${event.tool_status ?? "unknown"}`)}</span>
        {(event.timestamp || event.duration_ms != null) && (
          <time className={`ml-auto ${hub ? "text-sm" : "text-[11px]"}`}>
            {event.timestamp ? formatDateTime(event.timestamp) : ""}
            {event.timestamp && event.duration_ms != null ? " · " : ""}
            {event.duration_ms != null ? formatDuration(event.duration_ms) : ""}
          </time>
        )}
      </div>
    );
  }
  const isUser = event.kind === "user-message";
  const coloredUser = isUser && !hub;
  return (
    <article
      className={`${hub ? `session-hub-event session-hub-message ${isUser ? "session-hub-user" : "session-hub-agent"}` : ""} max-w-[min(820px,92%)] self-start rounded-2xl border px-4 py-3.5 shadow-xs ${coloredUser ? "ml-auto border-primary bg-primary text-primary-foreground" : isUser ? "ml-auto border-border/70 bg-muted text-foreground" : "border-border/70 bg-card text-foreground"}`}
    >
      <header
        className={`mb-2.5 flex items-center gap-1.5 ${hub ? "text-sm" : "text-xs"} ${coloredUser ? "text-primary-foreground/70" : "text-muted-foreground"}`}
      >
        {isUser ? <UserRound size={14} /> : <Bot size={14} />}
        <strong className={coloredUser ? "text-primary-foreground" : "text-foreground"}>
          {tr(isUser ? "conversations.you" : "conversations.agent")}
        </strong>
        {event.timestamp && <time className="ml-auto">{formatDateTime(event.timestamp)}</time>}
      </header>
      <MarkdownContent
        content={event.content ?? ""}
        className="select-text text-sm leading-7 [overflow-wrap:anywhere]"
      />
      {(event.attachment_count > 0 || event.truncated) && (
        <footer
          className={`mt-3 flex gap-2 ${hub ? "text-sm" : "text-xs"} ${coloredUser ? "text-primary-foreground/70" : "text-muted-foreground"}`}
        >
          {event.attachment_count > 0 && (
            <span>{tr("conversations.attachments", { count: event.attachment_count })}</span>
          )}
          {event.truncated && <span>{tr("conversations.contentTruncated")}</span>}
        </footer>
      )}
    </article>
  );
}

function formatDuration(milliseconds: number) {
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}
