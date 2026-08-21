import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { tr } from "../i18n";
import type { QuotaCollectorStatus, QuotaSnapshot } from "../types";

export function QuotaDiagnostics({ status }: { status?: QuotaCollectorStatus }) {
  if (!status) return <div className="setting-empty">{tr("quota.statusUnavailable")}</div>;
  return <div className="quota-diagnostics">
    <DiagnosticRow label={tr("quota.collector")} value={backendLabel(status.backend, status.backend_version)} />
    <DiagnosticRow label={tr("quota.sidecar")} value={tr(status.sidecar_available ? "quota.available" : "quota.unavailable")} />
    <DiagnosticRow label={tr("quota.configSource")} value={tr(`quota.config.${status.config_source}`)} />
    <DiagnosticRow label={tr("quota.lastSuccess")} value={status.last_success_at ? formatDateTime(status.last_success_at) : "—"} />
    {status.error_key && <div className="quota-diagnostic-error"><strong>{tr(status.error_key)}</strong>{status.error_detail && <Collapsible><CollapsibleTrigger>{tr("common.details")}</CollapsibleTrigger><CollapsibleContent><pre>{status.error_detail}</pre></CollapsibleContent></Collapsible>}</div>}
  </div>;
}

function DiagnosticRow({ label, value }: { label: string; value: string }) { return <div className="flex min-h-[58px] items-center justify-between gap-5 border-b border-border-subtle px-4 py-3 last:border-b-0"><span>{label}</span><strong>{value}</strong></div>; }
function backendLabel(backend: QuotaSnapshot["backend"], version?: string) { return `${backend === "codex-bar-cli" ? "CodexBarCLI" : "Win-CodexBar"}${version ? ` · ${version}` : ""}`; }
function formatDateTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(document.documentElement.lang || "en-US", { dateStyle: "medium", timeStyle: "short" }).format(date); }
