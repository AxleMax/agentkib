import {
  SkeletonListRows,
  SkeletonPage,
  SkeletonPanel,
  SkeletonPanelHeader,
  SkeletonText,
} from "@/components/ui/skeleton-layouts";
import { Skeleton } from "@/components/ui/skeleton";

export function InsightsSkeleton() {
  return (
    <SkeletonPage className="pb-8" label="Loading insights">
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonText className="h-9 w-24 rounded-lg" key={index} />
        ))}
      </div>
      <SkeletonPanel>
        <SkeletonPanelHeader />
        <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(260px,.75fr)]">
          <Skeleton className="min-h-[260px] w-full rounded-xl" />
          <SkeletonListRows count={5} compact />
        </div>
      </SkeletonPanel>
      <div className="grid gap-4 lg:grid-cols-2">
        <SkeletonPanel>
          <SkeletonPanelHeader />
          <SkeletonListRows count={4} compact />
        </SkeletonPanel>
        <SkeletonPanel>
          <SkeletonPanelHeader />
          <SkeletonListRows count={4} compact />
        </SkeletonPanel>
      </div>
    </SkeletonPage>
  );
}
