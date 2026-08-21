import { LoaderCircle } from "lucide-react"

import { cn } from "@/lib/utils"

function LoadingState({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("grid min-h-[calc(100dvh-8rem)] w-full place-items-center text-muted-foreground", className)} role="status" aria-live="polite">
      <div className="grid justify-items-center gap-3">
        <LoaderCircle className="size-5 animate-spin text-primary" aria-hidden="true" />
        <span className="text-sm">{label}</span>
      </div>
    </div>
  )
}

export { LoadingState }
