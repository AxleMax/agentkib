import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { ExternalLink, Gauge, RefreshCw, Settings2 } from "lucide-react";
import { api } from "../api";
import { changeLocale, formatRelativeTime, localizeMessage, tr } from "../i18n";
import { compareQuotaProviders, isQuotaProviderSupported, lowestRemaining, visibleQuotaWindows } from "../quota";
import { applyTheme } from "../theme";
import type { EffectiveTheme, QuotaPopoverPreferences, QuotaProvider, QuotaSnapshot, RefreshJobStatus } from "../types";
import { ProviderIcon, QuotaWindowRow } from "./QuotaDisplay";
import { cn } from "@/lib/utils";

export function QuotaPopover() {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot>();
  const [preferences, setPreferences] = useState<QuotaPopoverPreferences>({ hidden_providers: [], hidden_windows: [] });
  const [selectedId, setSelectedId] = useState("");
  const [refreshJob, setRefreshJob] = useState<RefreshJobStatus>();
  const [error, setError] = useState("");
  const initialRefreshRequested = useRef(false);

  const load = async () => {
    const [nextSnapshot, nextPreferences, jobs] = await Promise.all([
      api.quotaSnapshot(),
      api.quotaPopoverPreferences(),
      api.refreshStatus(),
    ]);
    setSnapshot(nextSnapshot);
    setPreferences(nextPreferences);
    const job = jobs.find((item) => item.kind === "quota");
    setRefreshJob(job);
    return { snapshot: nextSnapshot, job };
  };

  useEffect(() => {
    let disposed = false;
    let unlistenQuota: (() => void) | undefined;
    let unlistenRefresh: (() => void) | undefined;
    let unlistenPreferences: (() => void) | undefined;
    void (async () => {
      [unlistenQuota, unlistenRefresh, unlistenPreferences] = await Promise.all([
        listen<QuotaSnapshot>("agentkib:quota-updated", ({ payload }) => { if (!disposed) setSnapshot(payload); }),
        listen<RefreshJobStatus>("agentkib:refresh-state", ({ payload }) => {
          if (disposed || payload.kind !== "quota") return;
          setRefreshJob(payload);
          if (payload.state === "failed") setError(payload.error ?? tr("errors.quotaUnavailable"));
          if (payload.state === "succeeded") setError("");
        }),
        listen<QuotaPopoverPreferences>("agentkib:quota-popover-preferences-updated", ({ payload }) => { if (!disposed) setPreferences(payload); }),
      ]);
      const current = await load();
      if (!disposed && !initialRefreshRequested.current && (!current.snapshot || current.snapshot.freshness !== "fresh") && !["queued", "running", "backoff"].includes(current.job?.state ?? "")) {
        initialRefreshRequested.current = true;
        const receipt = await api.requestRefresh("quota", false);
        setRefreshJob(receipt.status);
      }
    })().catch((reason) => { if (!disposed) setError(localizeMessage(reason)); });
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") void getCurrentWindow().hide();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      disposed = true;
      unlistenQuota?.();
      unlistenRefresh?.();
      unlistenPreferences?.();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const refreshActive = refreshJob?.state === "queued" || refreshJob?.state === "running";
  useEffect(() => {
    if (!refreshActive) return;
    let disposed = false;
    const poll = async () => {
      try {
        const jobs = await api.refreshStatus();
        if (disposed) return;
        const job = jobs.find((item) => item.kind === "quota");
        if (!job) return;
        setRefreshJob(job);
        if (job.state === "failed") setError(job.error ?? tr("errors.quotaUnavailable"));
        if (job.state === "succeeded") {
          setError("");
          const current = await api.quotaSnapshot();
          if (!disposed) setSnapshot(current);
        }
      } catch (reason) {
        if (!disposed) setError(localizeMessage(reason));
      }
    };
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [refreshActive, refreshJob?.request_id]);

  useEffect(() => {
    let disposed = false;
    let unlistenTheme: (() => void) | undefined;
    const syncAppearance = async () => {
      try {
        const runtime = await api.runtime();
        if (disposed) return;
        applyTheme(runtime.effective_theme);
        await changeLocale(runtime.effective_locale);
      } catch {
        // The main bootstrap already supplied a safe browser/system fallback.
      }
    };
    void listen<EffectiveTheme>("tauri://theme-changed", ({ payload }) => applyTheme(payload))
      .then((dispose) => { unlistenTheme = dispose; });
    window.addEventListener("focus", syncAppearance);
    return () => {
      disposed = true;
      unlistenTheme?.();
      window.removeEventListener("focus", syncAppearance);
    };
  }, []);

  const providers = useMemo(() => (snapshot?.providers ?? [])
    .filter(isQuotaProviderSupported)
    .filter((provider) => visibleQuotaWindows(provider, preferences).length > 0)
    .sort(compareQuotaProviders), [preferences, snapshot]);

  useEffect(() => {
    if (!providers.length) return;
    if (!providers.some((provider) => provider.id === selectedId)) setSelectedId(providers[0].id);
  }, [providers, selectedId]);

  const selected = providers.find((provider) => provider.id === selectedId);
  const windows = selected ? visibleQuotaWindows(selected, preferences) : [];
  const busy = refreshActive;
  const refresh = async () => {
    setError("");
    try {
      const receipt = await api.refreshQuota();
      setRefreshJob(receipt.status);
    } catch (reason) {
      setError(localizeMessage(reason));
    }
  };
  const openDashboard = async (provider?: QuotaProvider, configure = false, windowIndex?: number) => {
    const item = windowIndex === undefined ? undefined : windows[windowIndex];
    await api.openQuotaDashboard(provider?.id, item?.selector, configure);
  };

  return <main className="quota-popover-shell">
    <header className="quota-popover-head" data-tauri-drag-region>
      <strong>{tr("nav.quota")}</strong>
      {snapshot && <span className={snapshot.freshness}>{snapshot.freshness === "stale" ? tr("quota.freshness.stale") : tr("quota.updated", { time: formatRelativeTime(snapshot.fetched_at) })}</span>}
      <Button className="ghost icon-only" type="button" onClick={() => void refresh()} disabled={busy} aria-label={tr("quota.refresh")}><RefreshCw size={15} className={busy ? "spin" : ""} /></Button>
    </header>

    {providers.length > 0 && <Tabs value={selectedId} onValueChange={setSelectedId}><TabsList className="h-auto w-full gap-1 overflow-x-auto border-b border-border bg-transparent p-2" variant="line" aria-label={tr("quota.providers")}>
      {providers.map((provider) => {
        const remaining = lowestRemaining(provider);
        return <TabsTrigger className="h-auto min-w-[72px] flex-none flex-col gap-1 rounded-md px-1 py-2 text-xs" key={provider.id} value={provider.id}>
          <ProviderIcon provider={provider} /><span className="max-w-[68px] truncate">{provider.name}</span><i className="h-0.5 w-10 overflow-hidden rounded-full bg-muted"><b className={cn("block h-full bg-primary", remaining !== undefined && remaining < 30 && "bg-amber-500")} style={{ width: `${remaining ?? 0}%` }} /></i>
        </TabsTrigger>;
      })}
    </TabsList></Tabs>}

    <section className="quota-popover-content">
      {!snapshot && <div className="quota-popover-empty"><Gauge size={25} /><strong>{busy ? tr("quota.refreshRunning") : tr("quota.empty")}</strong>{error && <small>{error}</small>}</div>}
      {snapshot && !providers.length && <div className="quota-popover-empty"><Gauge size={25} /><strong>{tr("quota.popoverEmpty")}</strong><small>{tr("quota.popoverEmptyHint")}</small></div>}
      {selected && <>
        <div className="quota-popover-provider"><ProviderIcon provider={selected} /><div><h1>{selected.name}</h1><span>{selected.identity?.account_email ?? selected.identity?.plan ?? "—"}</span></div></div>
        <div className="quota-popover-windows">{windows.map((item, index) => <div key={item.key}>{item.accountLabel && <small className="quota-popover-account">{item.accountLabel}</small>}<QuotaWindowRow item={item} onOpen={() => void openDashboard(selected, false, index)} /></div>)}</div>
        {selected.error && <Collapsible className="quota-inline-diagnostic partial"><CollapsibleTrigger>{tr("quota.partialData")}</CollapsibleTrigger><CollapsibleContent><pre>{selected.error}</pre></CollapsibleContent></Collapsible>}
      </>}
    </section>

    <footer className="quota-popover-footer">
      <Button type="button" onClick={() => void openDashboard(selected)}><ExternalLink size={15} />{tr("quota.openDashboard")}</Button>
      <Button type="button" onClick={() => void openDashboard(selected, true)}><Settings2 size={15} />{tr("quota.popoverSettings")}</Button>
    </footer>
  </main>;
}
