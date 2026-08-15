import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { Check, ChevronDown, CircleAlert, Gauge, RefreshCw, Search, Settings2, X } from "lucide-react";
import { api } from "../api";
import { formatRelativeTime, localizeMessage, tr } from "../i18n";
import { normalizePlatform } from "../platform";
import {
  compareQuotaProviders,
  flattenQuotaWindows,
  isQuotaProviderSupported,
  lowestRemaining,
  providerHasPartialData,
  providerIsUnavailable,
  quotaSeverity,
  quotaWindowKey,
} from "../quota";
import type {
  QuotaCollectorStatus,
  QuotaPopoverPreferences,
  QuotaProvider,
  QuotaSnapshot,
  QuotaWindowSelector,
  RefreshJobStatus,
} from "../types";
import { ProviderIcon, QuotaWindowRow } from "./QuotaDisplay";
import "./quota.css";

type QuotaFilter = "all" | "healthy" | "warning" | "unavailable";

export function QuotaPage({
  initialProvider,
  initialWindow,
  configurePopoverRequest = 0,
  popoverSupported = normalizePlatform(import.meta.env.TAURI_ENV_PLATFORM) === "macos",
}: {
  initialProvider?: string;
  initialWindow?: QuotaWindowSelector;
  configurePopoverRequest?: number;
  popoverSupported?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot>();
  const [status, setStatus] = useState<QuotaCollectorStatus>();
  const [preferences, setPreferences] = useState<QuotaPopoverPreferences>({ hidden_providers: [], hidden_windows: [] });
  const [selectedId, setSelectedId] = useState(initialProvider ?? initialWindow?.provider_id ?? "");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<QuotaFilter>("all");
  const [showPreferences, setShowPreferences] = useState(popoverSupported && configurePopoverRequest > 0);
  const [refreshJob, setRefreshJob] = useState<RefreshJobStatus>();
  const [requestPending, setRequestPending] = useState(false);
  const [error, setError] = useState("");
  const pendingRefresh = useRef(false);
  const requestedInitialRefresh = useRef(false);

  const load = async () => {
    const [nextSnapshot, nextStatus, refreshJobs, nextPreferences] = await Promise.all([
      api.quotaSnapshot(),
      api.quotaCollectorStatus(),
      api.refreshStatus(),
      api.quotaPopoverPreferences(),
    ]);
    setSnapshot(nextSnapshot);
    setStatus(nextStatus);
    setPreferences(nextPreferences);
    const nextJob = refreshJobs.find((job) => job.kind === "quota");
    setRefreshJob(nextJob);
    return { snapshot: nextSnapshot, job: nextJob };
  };

  useEffect(() => {
    let disposed = false;
    let unlistenQuota: (() => void) | undefined;
    let unlistenRefresh: (() => void) | undefined;
    let unlistenPreferences: (() => void) | undefined;
    void (async () => {
      [unlistenQuota, unlistenRefresh, unlistenPreferences] = await Promise.all([
        listen<QuotaSnapshot>("agentkib:quota-updated", ({ payload }) => {
          if (disposed) return;
          setSnapshot(payload);
          if (document.visibilityState === "visible") void api.quotaCollectorStatus().then(setStatus);
          else pendingRefresh.current = true;
        }),
        listen<RefreshJobStatus>("agentkib:refresh-state", ({ payload }) => {
          if (disposed || payload.kind !== "quota") return;
          setRefreshJob(payload);
          if (payload.state === "succeeded") {
            setError("");
            if (document.visibilityState === "visible") void load().catch((reason) => setError(localizeMessage(reason)));
            else pendingRefresh.current = true;
          }
          if (payload.state === "failed") setError(payload.error ?? tr("errors.quotaUnavailable"));
        }),
        listen<QuotaPopoverPreferences>("agentkib:quota-popover-preferences-updated", ({ payload }) => {
          if (!disposed) setPreferences(payload);
        }),
      ]);
      if (disposed) {
        unlistenQuota();
        unlistenRefresh();
        unlistenPreferences();
        return;
      }
      const { snapshot: initialSnapshot, job } = await load();
      if (requestedInitialRefresh.current || (job && ["queued", "running", "backoff"].includes(job.state))) return;
      if (initialSnapshot?.freshness === "fresh") return;
      requestedInitialRefresh.current = true;
      const receipt = await api.requestRefresh("quota", false);
      if (!disposed) setRefreshJob(receipt.status);
    })().catch((reason) => { if (!disposed) setError(localizeMessage(reason)); });
    return () => {
      disposed = true;
      unlistenQuota?.();
      unlistenRefresh?.();
      unlistenPreferences?.();
    };
  }, []);

  const refreshActive = refreshJob?.state === "queued" || refreshJob?.state === "running";
  useEffect(() => {
    if (!refreshActive || document.visibilityState !== "visible") return;
    let disposed = false;
    const poll = async () => {
      try {
        const jobs = await api.refreshStatus();
        if (disposed) return;
        const nextJob = jobs.find((job) => job.kind === "quota");
        if (!nextJob) return;
        setRefreshJob(nextJob);
        if (nextJob.state === "failed") setError(nextJob.error ?? tr("errors.quotaUnavailable"));
        if (nextJob.state === "succeeded") {
          setError("");
          await load();
        }
      } catch (reason) {
        if (!disposed) setError(localizeMessage(reason));
      }
    };
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [refreshActive, refreshJob?.request_id]);

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
    if (initialProvider || initialWindow) setSelectedId(initialProvider ?? initialWindow?.provider_id ?? "");
    if (popoverSupported && configurePopoverRequest > 0) setShowPreferences(true);
  }, [configurePopoverRequest, initialProvider, initialWindow, popoverSupported]);

  const providers = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...(snapshot?.providers ?? [])]
      .filter(isQuotaProviderSupported)
      .filter((provider) => {
        const haystack = [provider.name, provider.id, provider.identity?.account_email, provider.identity?.plan]
          .filter(Boolean).join(" ").toLocaleLowerCase();
        return (!needle || haystack.includes(needle)) && matchesFilter(provider, filter);
      })
      .sort(compareQuotaProviders);
  }, [snapshot, query, filter]);

  useEffect(() => {
    if (!providers.length) return;
    if (!providers.some((provider) => provider.id === selectedId)) setSelectedId(providers[0].id);
  }, [providers, selectedId]);

  useEffect(() => {
    if (!initialWindow || selectedId !== initialWindow.provider_id) return;
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLElement>('[data-quota-target="true"]')?.scrollIntoView({ block: "center" });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [initialWindow, selectedId]);

  const selected = providers.find((provider) => provider.id === selectedId);
  const busy = requestPending || refreshActive;
  const refresh = async () => {
    setRequestPending(true);
    setError("");
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
    ? tr("quota.refreshPreparing")
    : refreshJob?.state === "running"
      ? tr("quota.refreshRunning")
      : undefined;
  const emptyLabel = requestPending || refreshJob?.state === "queued"
    ? tr("quota.refreshPreparing")
    : refreshJob?.state === "running"
      ? tr("quota.refreshRunning")
      : refreshJob?.state === "backoff" && refreshJob.next_allowed_at
        ? tr("quota.refreshBackoff", { time: formatDateTime(refreshJob.next_allowed_at) })
        : refreshJob?.state === "failed"
          ? tr("quota.refreshFailed")
          : status?.error_key ? tr(status.error_key) : tr("quota.empty");
  const emptyDetail = refreshJob?.state === "failed" ? (error || refreshJob.error) : undefined;

  return <div className="quota-page">
    {error && snapshot && <div className="alert"><CircleAlert size={16} />{error}</div>}
    <div className="quota-toolbar">
      <label className="search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("quota.search")} /></label>
      <div className="quota-filter" role="group" aria-label={tr("quota.filterLabel")}>
        {(["all", "healthy", "warning", "unavailable"] as QuotaFilter[]).map((value) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{tr(`quota.filter.${value}`)}</button>)}
      </div>
      {popoverSupported && <button className="ghost quota-display-settings-button" type="button" onClick={() => setShowPreferences((value) => !value)} aria-expanded={showPreferences}><Settings2 size={15} />{tr("quota.popoverSettings")}</button>}
      {snapshot && refreshLabel && <span className="badge">{refreshLabel}</span>}
      <button className="ghost icon-only" onClick={() => void refresh()} disabled={busy} title={tr("quota.refresh")} aria-label={tr("quota.refresh")}><RefreshCw size={15} className={busy ? "spin" : ""} /></button>
    </div>

    {popoverSupported && showPreferences && snapshot && <QuotaDisplaySettings snapshot={snapshot} preferences={preferences} onChange={setPreferences} onClose={() => setShowPreferences(false)} />}

    {!snapshot && <div className="quota-empty compact"><Gauge size={26} /><strong>{emptyLabel}</strong>{emptyDetail && <small>{emptyDetail}</small>}<button className="primary" onClick={() => void refresh()} disabled={busy}>{tr("quota.refresh")}</button></div>}
    {snapshot && <>
      <ProviderTabs providers={providers} selectedId={selectedId} onSelect={setSelectedId} />
      {!providers.length && <div className="quota-list-empty">{tr("quota.noMatch")}</div>}
      {selected && <QuotaProviderDetail provider={selected} snapshot={snapshot} targetWindow={initialWindow} />}
    </>}
  </div>;
}

function ProviderTabs({ providers, selectedId, onSelect }: { providers: QuotaProvider[]; selectedId: string; onSelect: (id: string) => void }) {
  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !providers.length) return;
    event.preventDefault();
    const current = Math.max(0, providers.findIndex((provider) => provider.id === selectedId));
    const index = event.key === "Home" ? 0 : event.key === "End" ? providers.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + providers.length) % providers.length;
    onSelect(providers[index].id);
    event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
  };
  return <div className="quota-provider-tabs" role="tablist" aria-label={tr("quota.providers")} onKeyDown={handleKey}>
    {providers.map((provider) => {
      const remaining = lowestRemaining(provider);
      const unavailable = remaining === undefined;
      return <button key={provider.id} role="tab" tabIndex={selectedId === provider.id ? 0 : -1} aria-selected={selectedId === provider.id} className={`${selectedId === provider.id ? "active" : ""}${unavailable ? " unavailable" : ""}`} onClick={() => onSelect(provider.id)}>
        <ProviderIcon provider={provider} />
        <span><strong>{provider.name}</strong><small>{provider.identity?.account_email ?? provider.identity?.plan ?? tr(unavailable ? "quota.unavailable" : "quota.available")}</small></span>
        {remaining === undefined ? <em>—</em> : <><em className={quotaSeverity(remaining)}>{Math.round(remaining)}%</em><i className="quota-tab-progress"><b className={quotaSeverity(remaining)} style={{ width: `${remaining}%` }} /></i></>}
      </button>;
    })}
  </div>;
}

function QuotaProviderDetail({ provider, snapshot, targetWindow }: { provider: QuotaProvider; snapshot: QuotaSnapshot; targetWindow?: QuotaWindowSelector }) {
  const windows = flattenQuotaWindows(provider);
  const direct = windows.filter((item) => !item.account);
  const accountGroups = provider.accounts.map((account) => ({ account, windows: windows.filter((item) => item.account?.id === account.id) }));
  const targetKey = targetWindow ? quotaWindowKey(targetWindow) : undefined;
  const unavailable = providerIsUnavailable(provider);
  return <section className={`quota-dashboard${unavailable ? " unavailable" : ""}`}>
    <header className="quota-dashboard-header">
      <ProviderIcon provider={provider} />
      <div><h2>{provider.name}</h2><p>{[provider.identity?.account_email, provider.identity?.plan, provider.source].filter(Boolean).join(" · ") || tr("quota.identityUnavailable")}</p></div>
      <div className="quota-updated"><span className={`quota-freshness ${snapshot.freshness}`}>{tr(`quota.freshness.${snapshot.freshness}`)}</span><time>{tr("quota.updated", { time: formatRelativeTime(snapshot.fetched_at) })}</time></div>
      {provider.credits && provider.credits.remaining > 0 && <span className="quota-credit">{formatNumber(provider.credits.remaining)} {provider.credits.unit}</span>}
    </header>

    {direct.length > 0 && <div className="quota-window-stack">{direct.map((item) => <QuotaWindowRow key={item.key} item={item} target={item.key === targetKey} />)}</div>}
    {accountGroups.map(({ account, windows: accountWindows }) => accountWindows.length > 0 && <section className="quota-account-group" key={account.id}>
      <header><div><strong>{account.identity?.account_email ?? account.label}</strong><span>{[account.identity?.plan, account.active ? tr("quota.activeAccount") : undefined].filter(Boolean).join(" · ")}</span></div>{account.updated_at && <time>{formatRelativeTime(account.updated_at)}</time>}</header>
      <div className="quota-window-stack">{accountWindows.map((item) => <QuotaWindowRow key={item.key} item={item} target={item.key === targetKey} />)}</div>
      {account.error && <details className="quota-inline-diagnostic"><summary>{tr("quota.partialData")}</summary><pre>{account.error}</pre></details>}
    </section>)}

    {unavailable && <div className="quota-provider-empty"><Gauge size={24} /><strong>{tr("quota.providerUnavailable")}</strong><span>{tr("quota.noWindows")}</span></div>}
    {provider.error && <details className={`quota-inline-diagnostic${providerHasPartialData(provider) ? " partial" : ""}`}><summary>{tr(providerHasPartialData(provider) ? "quota.partialData" : "common.details")}</summary><pre>{provider.error}</pre></details>}
  </section>;
}

function QuotaDisplaySettings({ snapshot, preferences, onChange, onClose }: { snapshot: QuotaSnapshot; preferences: QuotaPopoverPreferences; onChange: (preferences: QuotaPopoverPreferences) => void; onClose: () => void }) {
  const [saveError, setSaveError] = useState("");
  const currentPreferences = useRef(preferences);
  const saveSequence = useRef(0);
  useEffect(() => { currentPreferences.current = preferences; }, [preferences]);
  const persist = async (next: QuotaPopoverPreferences) => {
    const sequence = ++saveSequence.current;
    const previous = currentPreferences.current;
    currentPreferences.current = next;
    onChange(next);
    setSaveError("");
    try {
      const stored = await api.setQuotaPopoverPreferences(next);
      if (sequence === saveSequence.current) {
        currentPreferences.current = stored;
        onChange(stored);
      }
    } catch (reason) {
      if (sequence === saveSequence.current) {
        currentPreferences.current = previous;
        onChange(previous);
        setSaveError(localizeMessage(reason));
      }
    }
  };
  const toggleProvider = (providerId: string) => {
    const current = currentPreferences.current;
    const hidden = current.hidden_providers.includes(providerId);
    void persist({ ...current, hidden_providers: hidden ? current.hidden_providers.filter((id) => id !== providerId) : [...current.hidden_providers, providerId] });
  };
  const toggleWindow = (selector: QuotaWindowSelector) => {
    const current = currentPreferences.current;
    const key = quotaWindowKey(selector);
    const hidden = current.hidden_windows.some((item) => quotaWindowKey(item) === key);
    void persist({ ...current, hidden_windows: hidden ? current.hidden_windows.filter((item) => quotaWindowKey(item) !== key) : [...current.hidden_windows, selector] });
  };
  return <aside className="quota-display-settings" role="dialog" aria-modal="false" aria-label={tr("quota.popoverSettings")}>
    <header><div><strong>{tr("quota.popoverSettings")}</strong><span>{tr("quota.popoverSettingsHint")}</span></div><button className="ghost icon-only" type="button" onClick={onClose} aria-label={tr("common.close")}><X size={15} /></button></header>
    <div className="quota-display-options">
      {snapshot.providers.filter(isQuotaProviderSupported).map((provider) => <QuotaDisplayProviderOption
        key={provider.id}
        provider={provider}
        preferences={preferences}
        onToggleProvider={toggleProvider}
        onToggleWindow={toggleWindow}
      />)}
    </div>
    {saveError && <div className="setting-detail error" role="alert">{saveError}</div>}
    <footer><button className="ghost" type="button" onClick={() => void persist({ hidden_providers: [], hidden_windows: [] })}><Check size={14} />{tr("quota.restorePopoverDefaults")}</button></footer>
  </aside>;
}

function QuotaDisplayProviderOption({ provider, preferences, onToggleProvider, onToggleWindow }: {
  provider: QuotaProvider;
  preferences: QuotaPopoverPreferences;
  onToggleProvider: (providerId: string) => void;
  onToggleWindow: (selector: QuotaWindowSelector) => void;
}) {
  const windows = flattenQuotaWindows(provider);
  const providerVisible = !preferences.hidden_providers.includes(provider.id);
  const [expanded, setExpanded] = useState(providerVisible && windows.length > 0);
  return <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary><label onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={providerVisible} disabled={!windows.length} onChange={() => onToggleProvider(provider.id)} /><ProviderIcon provider={provider} /><span><strong>{provider.name}</strong><small>{windows.length ? tr("quota.windowCount", { count: windows.length }) : tr("quota.noWindows")}</small></span></label><ChevronDown size={14} /></summary>
    {windows.length > 0 && <div>{windows.map((item) => <label key={item.key}><input type="checkbox" checked={providerVisible && !preferences.hidden_windows.some((hidden) => quotaWindowKey(hidden) === item.key)} disabled={!providerVisible} onChange={() => onToggleWindow(item.selector)} /><span><strong>{item.window.label || tr(`quota.window.${item.window.kind}`)}</strong><small>{item.accountLabel ?? provider.identity?.account_email ?? provider.identity?.plan ?? provider.name}</small></span></label>)}</div>}
  </details>;
}

function matchesFilter(provider: QuotaProvider, filter: QuotaFilter) {
  if (filter === "all") return true;
  const remaining = lowestRemaining(provider);
  if (filter === "unavailable") return providerIsUnavailable(provider);
  if (remaining === undefined) return false;
  return filter === "warning" ? remaining <= 20 : remaining > 20;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(document.documentElement.lang || "en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(document.documentElement.lang || "en-US", { maximumFractionDigits: 2 }).format(value);
}
