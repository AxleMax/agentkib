import { lazy, Suspense, useState } from "react";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LoadingState } from "@/components/ui/loading-state";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useAppStore } from "../stores/app-store";
import { api } from "../core/api";
import { localizeMessage, tr } from "../core/i18n";
import type { InsightsSection } from "../components/InsightsPage";

const InsightsPageLazy = lazy(() =>
  import("../components/InsightsPage").then(({ InsightsPage }) => ({ default: InsightsPage })),
);

type InsightsSearch = { insightsSection?: InsightsSection };

function InsightsRoute() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as InsightsSearch;
  const section = search.insightsSection ?? "overview";
  const workspaces = useAppStore((state) => state.workspaces);
  const refreshJobs = useAppStore((state) => state.refreshJobs);
  const setInsightsSummary = useAppStore((state) => state.setInsightsSummary);
  const [refreshError, setRefreshError] = useState("");
  const refreshing = refreshJobs.some(
    (job) => job.kind === "insights" && (job.state === "queued" || job.state === "running"),
  );

  const setSection = (nextSection: InsightsSection) => {
    void navigate({
      to: "/insights",
      search: (current) => ({ ...current, insightsSection: nextSection }) as never,
    });
  };

  const refresh = async () => {
    setRefreshError("");
    try {
      await api.requestRefresh("insights", true);
    } catch (error) {
      setRefreshError(localizeMessage(error));
    }
  };

  return (
    <div className="relative grid gap-5 pb-8" data-view={section}>
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-3 shadow-sm">
        <Tabs
          value={section}
          onValueChange={(value) => setSection(value as InsightsSection)}
          className="min-w-0"
        >
          <TabsList
            className="w-full justify-start gap-1 overflow-x-auto rounded-none bg-transparent pr-2"
            variant="line"
            aria-label={tr("nav.insights")}
          >
            {["overview", "tokens", "commits", "milestones", "sources"].map((value) => (
              <TabsTrigger className="flex-none rounded-none px-3" key={value} value={value}>
                {tr(`insights.section.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Button
          variant="outline"
          size="icon"
          className="size-9 shrink-0 rounded-xl"
          aria-label={tr("insights.refresh")}
          title={tr("insights.refresh")}
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
        </Button>
      </div>
      {refreshError && (
        <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <CircleAlert size={16} />
          {refreshError}
        </div>
      )}
      <Suspense fallback={<LoadingState label={tr("common.loading")} />}>
        <InsightsPageLazy
          section={section}
          workspaces={workspaces}
          onSummary={setInsightsSummary}
        />
      </Suspense>
    </div>
  );
}

export const Route = createFileRoute("/insights")({ component: InsightsRoute });
