import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { tr } from "../i18n";
import type { QuotaCollectorStatus, QuotaSnapshot } from "../types";

export function QuotaDiagnostics({ status }: { status?: QuotaCollectorStatus }) {
  if (!status) return <div className="px-4 py-3 text-xs text-muted-foreground">{tr("quota.statusUnavailable")}</div>;
  return <div className="overflow-hidden rounded-xl border border-border bg-card">
    <DiagnosticRow label={tr("quota.collector")} value={backendLabel(status.backend, status.backend_version)} />
    <DiagnosticRow label={tr("quota.sidecar")} value={tr(status.sidecar_available ? "quota.available" : "quota.unavailable")} />
    <DiagnosticRow label={tr("quota.configSource")} value={tr(`quota.config.${status.config_source}`)} />
    <DiagnosticRow label={tr("quota.lastSuccess")} value={status.last_success_at ? formatDateTime(status.last_success_at) : "—"} />
    {status.error_key && <div className="flex flex-col gap-2 border-t border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"><strong>{tr(status.error_key)}</strong>{status.error_detail && <Collapsible><CollapsibleTrigger className="text-xs font-medium underline-offset-4 hover:underline">{tr("common.details")}</CollapsibleTrigger><CollapsibleContent><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-background/70 p-3 text-xs text-muted-foreground">{status.error_detail}</pre></CollapsibleContent></Collapsible>}</div>}
  </div>;
}

function DiagnosticRow({ label, value }: { label: string; value: string }) { return <div className="flex min-h-[58px] items-center justify-between gap-5 border-b border-border-subtle px-4 py-3 last:border-b-0"><span>{label}</span><strong>{value}</strong></div>; }
function backendLabel(backend: QuotaSnapshot["backend"], version?: string) { return `${backend === "codex-bar-cli" ? "CodexBarCLI" : "Win-CodexBar"}${version ? ` · ${version}` : ""}`; }
function formatDateTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(document.documentElement.lang || "en-US", { dateStyle: "medium", timeStyle: "short" }).format(date); }
