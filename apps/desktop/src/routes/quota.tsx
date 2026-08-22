import { lazy, Suspense } from "react";
import { LoadingState } from "@/components/ui/loading-state";
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useAppStore } from "../stores/app-store";
import type { QuotaWindowSelector } from "../core/types";

const QuotaPageLazy = lazy(() => import("../components/QuotaPage").then(({ QuotaPage }) => ({ default: QuotaPage })));

type QuotaSearch = { quotaProvider?: string; quotaWindow?: QuotaWindowSelector };

function QuotaRoute() {
  const search = useSearch({ strict: false }) as QuotaSearch;
  const configurePopoverRequest = useAppStore((state) => state.quotaConfigureRequest);

  return <Suspense fallback={<LoadingState label="Loading…" />}>
    <QuotaPageLazy initialProvider={search.quotaProvider} initialWindow={search.quotaWindow} configurePopoverRequest={configurePopoverRequest} />
  </Suspense>;
}

export const Route = createFileRoute("/quota")({ component: QuotaRoute });
