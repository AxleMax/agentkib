import { createFileRoute } from "@tanstack/react-router";
import { SessionHubPage } from "@/features/sessions/SessionHubPage";

export const Route = createFileRoute("/sessions")({ component: SessionHubPage });
