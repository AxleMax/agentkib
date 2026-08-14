import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CircleAlert, Coins, Gauge, RefreshCw, Search } from "lucide-react";
import { api } from "../api";
import { localizeMessage, tr } from "../i18n";
import type { QuotaCollectorStatus, QuotaProvider, QuotaSnapshot, QuotaWindow, RefreshJobStatus } from "../types";
import "./quota.css";

type QuotaFilter = "all" | "healthy" | "warning" | "unavailable";

export function QuotaPage({ initialProvider }: { initialProvider?: string }) {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot>();
  const [status, setStatus] = useState<QuotaCollectorStatus>();
  const [selectedId, setSelectedId] = useState(initialProvider ?? "");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<QuotaFilter>("all");
  const [refreshJob, setRefreshJob] = useState<RefreshJobStatus>();
  const [requestPending, setRequestPending] = useState(false);
  const [error, setError] = useState("");
  const pendingRefresh = useRef(false);
  const requestedInitialRefresh = useRef(false);

  const load = async () => {
    const [nextSnapshot, nextStatus, refreshJobs] = await Promise.all([
      api.quotaSnapshot(),
      api.quotaCollectorStatus(),
      api.refreshStatus(),
    ]);
    setSnapshot(nextSnapshot);
    setStatus(nextStatus);
    const nextJob = refreshJobs.find((job) => job.kind === "quota");
    setRefreshJob(nextJob);
    return { snapshot: nextSnapshot, job: nextJob };
  };

  useEffect(() => {
    void load()
      .then(async ({ snapshot: initialSnapshot, job }) => {
        if (requestedInitialRefresh.current || (job && (job.state === "queued" || job.state === "running" || job.state === "backoff"))) return;
        if (initialSnapshot?.freshness === "fresh") return;
        requestedInitialRefresh.current = true;
        const receipt = await api.requestRefresh("quota", false);
        setRefreshJob(receipt.status);
      })
      .catch((reason) => setError(localizeMessage(reason)));
    const unlistenQuota = listen<QuotaSnapshot>("agentkib:quota-updated", ({ payload }) => {
      setSnapshot(payload);
      if (document.visibilityState === "visible") void api.quotaCollectorStatus().then(setStatus);
      else pendingRefresh.current = true;
    });
    const unlistenRefresh = listen<RefreshJobStatus>("agentkib:refresh-state", ({ payload }) => {
      if (payload.kind !== "quota") return;
      setRefreshJob(payload);
      if (payload.state === "succeeded") {
        setError("");
        if (document.visibilityState === "visible") void load().catch((reason) => setError(localizeMessage(reason)));
        else pendingRefresh.current = true;
      }
      if (payload.state === "failed") setError(payload.error ?? tr("errors.quotaUnavailable"));
    });
    return () => {
      void unlistenQuota.then((dispose) => dispose());
      void unlistenRefresh.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    const refreshVisibleQuota = () => {
      if (!pendingRefresh.current) return;
      pendingRefresh.current = false;
      void load().catch((reason) => setError(localizeMessage(reason)));
    };
    window.addEventListener("focus", refreshVisibleQuota);
    return () => window.removeEventListener("focus", refreshVisibleQuota);
  }, []);

  useEffect(() => {
    if (initialProvider) setSelectedId(initialProvider);
  }, [initialProvider]);

  const providers = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...(snapshot?.providers ?? [])]
      .filter((provider) => {
        const haystack = [provider.name, provider.id, provider.identity?.account_email, provider.identity?.plan]
          .filter(Boolean).join(" ").toLocaleLowerCase();
        return (!needle || haystack.includes(needle)) && matchesFilter(provider, filter);
      })
      .sort(compareProviders);
  }, [snapshot, query, filter]);

  useEffect(() => {
    if (!providers.length) return;
    if (!providers.some((provider) => provider.id === selectedId)) setSelectedId(providers[0].id);
  }, [providers, selectedId]);

  const selected = providers.find((provider) => provider.id === selectedId);
  const busy = requestPending || refreshJob?.state === "queued" || refreshJob?.state === "running";
  const refresh = async () => {
    setRequestPending(true); setError("");
    try {
      const receipt = await api.refreshQuota();
      setRefreshJob(receipt.status);
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setRequestPending(false);
    }
  };
  const refreshLabel = refreshJob?.state === "queued"
    ? tr("quota.refreshQueued")
    : refreshJob?.state === "running"
      ? tr("quota.refreshRunning")
      : undefined;
  const emptyLabel = refreshJob?.state === "queued"
    ? tr("quota.refreshQueued")
    : refreshJob?.state === "running"
      ? tr("quota.refreshRunning")
      : refreshJob?.state === "backoff" && refreshJob.next_allowed_at
        ? tr("quota.refreshBackoff", { time: formatDateTime(refreshJob.next_allowed_at) })
        : status?.error_key ? tr(status.error_key) : tr("quota.empty");

  return <div className="quota-page">
    {error && <div className="alert"><CircleAlert size={16} />{error}</div>}
    <div className="quota-toolbar">
      <label className="search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("quota.search")} /></label>
      <div className="quota-filter" role="group" aria-label={tr("quota.filterLabel")}>
        {(["all", "healthy", "warning", "unavailable"] as QuotaFilter[]).map((value) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{tr(`quota.filter.${value}`)}</button>)}
      </div>
      {refreshLabel && <span className="badge">{refreshLabel}</span>}
      <button className="ghost icon-only" onClick={() => void refresh()} disabled={busy} title={tr("quota.refresh")} aria-label={tr("quota.refresh")}><RefreshCw size={15} className={busy ? "spin" : ""} /></button>
    </div>

    {!snapshot && <div className="quota-empty"><Gauge size={28} /><strong>{emptyLabel}</strong><button className="primary" onClick={() => void refresh()} disabled={busy}>{tr("quota.refresh")}</button></div>}
    {snapshot && <>
      <div className={`quota-freshness ${snapshot.freshness}`}>
        <span>{tr(`quota.freshness.${snapshot.freshness}`)}</span>
        <time>{formatDateTime(snapshot.fetched_at)}</time>
        <span>{backendLabel(snapshot.backend, snapshot.backend_version)}</span>
      </div>
      <div className="quota-master-detail">
        <div className="quota-provider-list" role="listbox" aria-label={tr("quota.providers")}>
          {providers.map((provider) => <button role="option" aria-selected={selectedId === provider.id} className={selectedId === provider.id ? "active" : ""} key={provider.id} onClick={() => setSelectedId(provider.id)}>
            <span><strong>{provider.name}</strong><small>{provider.identity?.account_email ?? provider.identity?.plan ?? provider.source ?? "—"}</small></span>
            <QuotaRemaining provider={provider} />
          </button>)}
          {!providers.length && <div className="quota-list-empty">{tr("quota.noMatch")}</div>}
        </div>
        <div className="quota-detail">{selected ? <QuotaProviderDetail provider={selected} /> : <div className="quota-list-empty">{tr("quota.selectProvider")}</div>}</div>
      </div>
    </>}
  </div>;
}

export function QuotaDiagnostics({ status }: { status?: QuotaCollectorStatus }) {
  if (!status) return <div className="setting-empty">{tr("quota.statusUnavailable")}</div>;
  return <div className="quota-diagnostics">
    <DiagnosticRow label={tr("quota.collector")} value={backendLabel(status.backend, status.backend_version)} />
    <DiagnosticRow label={tr("quota.sidecar")} value={tr(status.sidecar_available ? "quota.available" : "quota.unavailable")} />
    <DiagnosticRow label={tr("quota.configSource")} value={tr(`quota.config.${status.config_source}`)} />
    <DiagnosticRow label={tr("quota.lastSuccess")} value={status.last_success_at ? formatDateTime(status.last_success_at) : "—"} />
    {status.error_key && <div className="quota-diagnostic-error"><strong>{tr(status.error_key)}</strong>{status.error_detail && <details><summary>{tr("common.details")}</summary><pre>{status.error_detail}</pre></details>}</div>}
  </div>;
}

function QuotaProviderDetail({ provider }: { provider: QuotaProvider }) {
  const windows = provider.windows;
  return <>
    <header className="quota-detail-header"><div><h2>{provider.name}</h2><div>{[provider.identity?.account_email, provider.identity?.plan, provider.source].filter(Boolean).join(" · ")}</div></div>{provider.credits && <span className="quota-credit"><Coins size={14} />{formatNumber(provider.credits.remaining)} {provider.credits.unit}</span>}</header>
    {provider.error && <div className="quota-provider-error"><CircleAlert size={15} /><span><strong>{tr("quota.providerUnavailable")}</strong><details><summary>{tr("common.details")}</summary><pre>{provider.error}</pre></details></span></div>}
    <div className="quota-window-list">{windows.map((window, index) => <QuotaWindowRow key={`${window.kind}-${index}`} window={window} />)}{!windows.length && !provider.accounts.length && <div className="quota-list-empty">{tr("quota.noWindows")}</div>}</div>
    {provider.accounts.length > 0 && <section className="quota-accounts"><h3>{tr("quota.accounts")}</h3>{provider.accounts.map((account) => <article key={account.id}><header><span><strong>{account.identity?.account_email ?? account.label}</strong><small>{account.identity?.plan}{account.active ? ` · ${tr("quota.activeAccount")}` : ""}</small></span></header>{account.error && <p className="quota-account-error">{account.error}</p>}{account.windows.map((window, index) => <QuotaWindowRow key={`${account.id}-${window.kind}-${index}`} window={window} />)}</article>)}</section>}
  </>;
}

function QuotaWindowRow({ window }: { window: QuotaWindow }) {
  const severity = quotaSeverity(window.remaining_percent);
  return <div className={`quota-window ${severity}`}><div><strong>{window.label || tr(`quota.window.${window.kind}`)}</strong><span>{tr("quota.remaining", { value: Math.round(window.remaining_percent) })}</span></div><div className="quota-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(window.remaining_percent)}><i style={{ width: `${window.remaining_percent}%` }} /></div><small>{window.reset_at ? tr("quota.resets", { time: relativeReset(window.reset_at) }) : tr("quota.noReset")}</small></div>;
}

function QuotaRemaining({ provider }: { provider: QuotaProvider }) {
  const remaining = lowestRemaining(provider);
  if (remaining === undefined) return <em className={provider.error ? "unavailable" : "unknown"}>{provider.error ? tr("quota.unavailable") : "—"}</em>;
  return <em className={quotaSeverity(remaining)}>{Math.round(remaining)}%</em>;
}

function DiagnosticRow({ label, value }: { label: string; value: string }) { return <div className="setting-row"><span>{label}</span><strong>{value}</strong></div>; }
function lowestRemaining(provider: QuotaProvider) { const values = [...provider.windows, ...provider.accounts.flatMap((account) => account.windows)].map((window) => window.remaining_percent); return values.length ? Math.min(...values) : undefined; }
function quotaSeverity(remaining: number) { return remaining <= 10 ? "danger" : remaining <= 20 ? "warning" : "healthy"; }
function compareProviders(left: QuotaProvider, right: QuotaProvider) { return (lowestRemaining(left) ?? 101) - (lowestRemaining(right) ?? 101) || left.name.localeCompare(right.name); }
function matchesFilter(provider: QuotaProvider, filter: QuotaFilter) { if (filter === "all") return true; const remaining = lowestRemaining(provider); if (filter === "unavailable") return Boolean(provider.error) || remaining === undefined; if (remaining === undefined) return false; return filter === "warning" ? remaining <= 20 : remaining > 20 && !provider.error; }
function backendLabel(backend: QuotaSnapshot["backend"], version?: string) { return `${backend === "codex-bar-cli" ? "CodexBarCLI" : "Win-CodexBar"}${version ? ` · ${version}` : ""}`; }
function formatDateTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(document.documentElement.lang || "en-US", { dateStyle: "medium", timeStyle: "short" }).format(date); }
function formatNumber(value: number) { return new Intl.NumberFormat(document.documentElement.lang || "en-US", { maximumFractionDigits: 2 }).format(value); }
function relativeReset(value: string) { const seconds = Math.max(0, Math.round((new Date(value).getTime() - Date.now()) / 1000)); if (seconds < 3600) return tr("quota.duration.minutes", { value: Math.max(1, Math.round(seconds / 60)) }); if (seconds < 86400) return tr("quota.duration.hours", { value: Math.round(seconds / 3600) }); return tr("quota.duration.days", { value: Math.round(seconds / 86400) }); }
