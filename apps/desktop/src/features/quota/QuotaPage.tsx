import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Check,
  ChevronDown,
  CircleAlert,
  Gauge,
  RefreshCw,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { api } from "@/core/api";
import { formatRelativeTime, localizeMessage, tr } from "@/core/i18n";
import { normalizePlatform } from "@/core/platform";
import { cn } from "@/lib/utils";
import {
  compareQuotaProviders,
  flattenQuotaWindows,
  isQuotaProviderSupported,
  lowestRemaining,
  providerHasPartialData,
  providerIsUnavailable,
  quotaSeverity,
  quotaWindowKey,
} from "@/features/quota/quota";
import type {
  QuotaCollectorStatus,
  QuotaPopoverPreferences,
  QuotaProvider,
  QuotaSnapshot,
  QuotaWindowSelector,
  RefreshJobStatus,
} from "@/core/types";
import { ProviderIcon, QuotaWindowRow } from "./QuotaDisplay";

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
  const [preferences, setPreferences] = useState<QuotaPopoverPreferences>({
    hidden_providers: [],
    hidden_windows: [],
  });
  const [selectedId, setSelectedId] = useState(initialProvider ?? initialWindow?.provider_id ?? "");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<QuotaFilter>("all");
  const [showPreferences, setShowPreferences] = useState(
    popoverSupported && configurePopoverRequest > 0,
  );
  const [refreshJob, setRefreshJob] = useState<RefreshJobStatus>();
  const [requestPending, setRequestPending] = useState(false);
  const [error, setError] = useState("");
  const [initializing, setInitializing] = useState(true);
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
          if (document.visibilityState === "visible")
            void api.quotaCollectorStatus().then(setStatus);
          else pendingRefresh.current = true;
        }),
        listen<RefreshJobStatus>("agentkib:refresh-state", ({ payload }) => {
          if (disposed || payload.kind !== "quota") return;
          setRefreshJob(payload);
          if (payload.state === "succeeded") {
            setError("");
            if (document.visibilityState === "visible")
              void load().catch((reason) => setError(localizeMessage(reason)));
            else pendingRefresh.current = true;
          }
          if (payload.state === "failed") setError(payload.error ?? tr("errors.quotaUnavailable"));
        }),
        listen<QuotaPopoverPreferences>(
          "agentkib:quota-popover-preferences-updated",
          ({ payload }) => {
            if (!disposed) setPreferences(payload);
          },
        ),
      ]);
      if (disposed) {
        unlistenQuota();
        unlistenRefresh();
        unlistenPreferences();
        return;
      }
      const { snapshot: initialSnapshot, job } = await load();
      if (!disposed) setInitializing(false);
      if (
        requestedInitialRefresh.current ||
        (job && ["queued", "running", "backoff"].includes(job.state))
      )
        return;
      if (initialSnapshot?.freshness === "fresh") return;
      requestedInitialRefresh.current = true;
      const receipt = await api.requestRefresh("quota", false);
      if (!disposed) setRefreshJob(receipt.status);
    })().catch((reason) => {
      if (!disposed) {
        setInitializing(false);
        setError(localizeMessage(reason));
      }
    });
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
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
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
    if (initialProvider || initialWindow)
      setSelectedId(initialProvider ?? initialWindow?.provider_id ?? "");
    if (popoverSupported && configurePopoverRequest > 0) setShowPreferences(true);
  }, [configurePopoverRequest, initialProvider, initialWindow, popoverSupported]);

  const providers = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...(snapshot?.providers ?? [])]
      .filter(isQuotaProviderSupported)
      .filter((provider) => {
        const haystack = [
          provider.name,
          provider.id,
          provider.identity?.account_email,
          provider.identity?.plan,
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase();
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
      document
        .querySelector<HTMLElement>('[data-quota-target="true"]')
        ?.scrollIntoView({ block: "center" });
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
  const refreshLabel =
    refreshJob?.state === "queued"
      ? tr("quota.refreshPreparing")
      : refreshJob?.state === "running"
        ? tr("quota.refreshRunning")
        : undefined;
  const emptyLabel =
    requestPending || refreshJob?.state === "queued"
      ? tr("quota.refreshPreparing")
      : refreshJob?.state === "running"
        ? tr("quota.refreshRunning")
        : refreshJob?.state === "backoff" && refreshJob.next_allowed_at
          ? tr("quota.refreshBackoff", { time: formatDateTime(refreshJob.next_allowed_at) })
          : refreshJob?.state === "failed"
            ? tr("quota.refreshFailed")
            : status?.error_key
              ? tr(status.error_key)
              : tr("quota.empty");
  const emptyDetail = error || (refreshJob?.state === "failed" ? refreshJob.error : undefined);

  if (initializing) return <LoadingState label={tr("common.loading")} />;

  return (
    <div className="relative grid gap-5 pb-8">
      <section className="grid gap-4 rounded-2xl border border-border bg-card p-5 shadow-sm max-[900px]:p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-foreground text-background">
                <Gauge size={18} />
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold tracking-tight">{tr("nav.quota")}</h1>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {snapshot && refreshLabel && (
              <Badge variant="secondary" className="hidden sm:inline-flex">
                {refreshLabel}
              </Badge>
            )}
            <Button
              variant="outline"
              size="icon"
              className="size-9 rounded-xl"
              onClick={() => void refresh()}
              disabled={busy}
              title={tr("quota.refresh")}
              aria-label={tr("quota.refresh")}
            >
              <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
            </Button>
          </div>
        </div>
        {error && snapshot && (
          <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <CircleAlert size={16} />
            {error}
          </div>
        )}
      </section>
      <Collapsible open={showPreferences} onOpenChange={setShowPreferences}>
        <div className="grid gap-3 rounded-2xl border border-border bg-card p-3 shadow-sm sm:grid-cols-[minmax(220px,1fr)_auto_auto] sm:items-center">
          <Label className="!flex !h-10 min-w-0 items-center gap-2 rounded-xl border border-border bg-background px-3 text-muted-foreground">
            <Search size={14} />
            <Input
              className="!border-0 !bg-transparent !px-0 !text-foreground !shadow-none placeholder:!text-muted-foreground focus-visible:!ring-0"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tr("quota.search")}
            />
          </Label>
          <ToggleGroup
            className="w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-muted/60 p-1 max-sm:w-full"
            value={[filter]}
            onValueChange={(values) => {
              const value = values[0];
              if (value) setFilter(value as QuotaFilter);
            }}
            aria-label={tr("quota.filterLabel")}
          >
            {(["all", "healthy", "warning", "unavailable"] as QuotaFilter[]).map((value) => (
              <ToggleGroupItem
                key={value}
                value={value}
                className="min-h-8 flex-1 rounded-lg px-3 text-xs text-muted-foreground hover:bg-background/70 hover:text-foreground data-[state=on]:bg-background data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-sm"
              >
                {tr(`quota.filter.${value}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {popoverSupported && (
            <CollapsibleTrigger
              className="inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
            >
              <Settings2 size={15} />
              {tr("quota.popoverSettings")}
            </CollapsibleTrigger>
          )}
        </div>

        {popoverSupported && snapshot && (
          <CollapsibleContent>
            <QuotaDisplaySettings
              snapshot={snapshot}
              preferences={preferences}
              onChange={setPreferences}
              onClose={() => setShowPreferences(false)}
            />
          </CollapsibleContent>
        )}
      </Collapsible>

      {!snapshot && (
        <div className="grid min-h-[240px] place-content-center justify-items-center gap-3 text-muted-foreground">
          <Gauge size={26} />
          <strong className="text-foreground">{emptyLabel}</strong>
          {emptyDetail && (
            <small className="max-w-[520px] whitespace-pre-wrap text-center text-xs">
              {emptyDetail}
            </small>
          )}
          <Button onClick={() => void refresh()} disabled={busy}>
            {tr("quota.refresh")}
          </Button>
        </div>
      )}
      {snapshot && (
        <>
          <section className="grid gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm max-[900px]:p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold tracking-tight">{tr("quota.providers")}</h2>
                <div className="mt-1 flex items-center gap-2">
                  <Badge variant="secondary">{providers.length}</Badge>
                  <span className="text-xs text-muted-foreground">{tr("quota.filterLabel")}</span>
                </div>
              </div>
              <Badge variant="outline">{tr(`quota.freshness.${snapshot.freshness}`)}</Badge>
            </div>
            <ProviderTabs providers={providers} selectedId={selectedId} onSelect={setSelectedId} />
          </section>
          {!providers.length && (
            <div className="grid min-h-[180px] place-content-center text-sm text-muted-foreground">
              {tr("quota.noMatch")}
            </div>
          )}
          {selected && (
            <QuotaProviderDetail
              provider={selected}
              snapshot={snapshot}
              targetWindow={initialWindow}
            />
          )}
        </>
      )}
    </div>
  );
}

function ProviderTabs({
  providers,
  selectedId,
  onSelect,
}: {
  providers: QuotaProvider[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <Tabs value={selectedId} onValueChange={onSelect}>
      <TabsList
        className="h-auto w-full items-stretch justify-start gap-3 overflow-x-auto rounded-xl bg-transparent p-0"
        variant="line"
        aria-label={tr("quota.providers")}
      >
        {providers.map((provider) => {
          const remaining = lowestRemaining(provider);
          const unavailable = remaining === undefined;
          const severity = remaining === undefined ? undefined : quotaSeverity(remaining);
          return (
            <TabsTrigger
              key={provider.id}
              value={provider.id}
              className={cn(
                "relative grid h-auto min-h-[92px] min-w-[210px] flex-none grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[auto_auto] items-start gap-x-2.5 gap-y-0.5 justify-start rounded-xl border border-border bg-background px-3.5 py-3.5 text-left transition-colors hover:border-foreground/25 hover:bg-muted/30 data-[state=active]:border-foreground/45 data-[state=active]:bg-background data-[state=active]:shadow-sm",
                unavailable && "opacity-60",
              )}
            >
              <ProviderIcon provider={provider} />
              <span className="min-w-0 grid gap-0.5">
                <strong className="truncate text-[13px]">{provider.name}</strong>
                <small className="truncate text-[11px] text-muted-foreground">
                  {provider.identity?.account_email ??
                    provider.identity?.plan ??
                    tr(unavailable ? "quota.unavailable" : "quota.available")}
                </small>
              </span>
              {remaining === undefined ? (
                <em className="text-[13px] font-bold not-italic">—</em>
              ) : (
                <>
                  <em
                    className={cn(
                      "text-[13px] font-bold not-italic",
                      severity === "healthy" && "text-green-600",
                      severity === "warning" && "text-amber-600",
                      severity === "danger" && "text-red-600",
                    )}
                  >
                    {Math.round(remaining)}%
                  </em>
                  <i className="absolute inset-x-3 bottom-2 h-1 overflow-hidden rounded-full bg-muted">
                    <b
                      className={cn(
                        "block h-full rounded-full bg-primary",
                        severity === "warning" && "bg-amber-500",
                        severity === "danger" && "bg-red-500",
                      )}
                      style={{ width: `${remaining}%` }}
                    />
                  </i>
                </>
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>
    </Tabs>
  );
}

function QuotaProviderDetail({
  provider,
  snapshot,
  targetWindow,
}: {
  provider: QuotaProvider;
  snapshot: QuotaSnapshot;
  targetWindow?: QuotaWindowSelector;
}) {
  const windows = flattenQuotaWindows(provider);
  const direct = windows.filter((item) => !item.account);
  const accountGroups = provider.accounts.map((account) => ({
    account,
    windows: windows.filter((item) => item.account?.id === account.id),
  }));
  const targetKey = targetWindow ? quotaWindowKey(targetWindow) : undefined;
  const unavailable = providerIsUnavailable(provider);
  return (
    <section className="w-full max-w-none overflow-hidden rounded-2xl border border-border bg-card px-5 pb-5 shadow-sm max-[900px]:px-4">
      <header className="-mx-5 grid min-h-[82px] grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border px-5 max-[900px]:mx-[-16px] max-[900px]:grid-cols-[auto_minmax(0,1fr)_auto] max-[900px]:px-4">
        <ProviderIcon provider={provider} />
        <div className="min-w-0">
          <h2 className="text-[21px]">{provider.name}</h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {[provider.identity?.account_email, provider.identity?.plan, provider.source]
              .filter(Boolean)
              .join(" · ") || tr("quota.identityUnavailable")}
          </p>
        </div>
        <div className="grid justify-items-end gap-0.5 text-xs text-muted-foreground">
          <span
            className={cn(
              snapshot.freshness === "stale" && "text-amber-600",
              snapshot.freshness === "unavailable" && "text-red-600",
            )}
          >
            {tr(`quota.freshness.${snapshot.freshness}`)}
          </span>
          <time>{tr("quota.updated", { time: formatRelativeTime(snapshot.fetched_at) })}</time>
        </div>
        {provider.credits && provider.credits.remaining > 0 && (
          <span className="inline-flex h-[30px] items-center rounded-md border border-border px-2.5 text-xs text-muted-foreground max-[900px]:hidden">
            {formatNumber(provider.credits.remaining)} {provider.credits.unit}
          </span>
        )}
      </header>

      {direct.length > 0 && (
        <div className="grid px-1">
          {direct.map((item) => (
            <QuotaWindowRow key={item.key} item={item} target={item.key === targetKey} />
          ))}
        </div>
      )}
      {accountGroups.map(
        ({ account, windows: accountWindows }) =>
          accountWindows.length > 0 && (
            <section className="px-1 pt-5" key={account.id}>
              <header className="flex min-h-[42px] items-center justify-between gap-4">
                <div className="grid gap-0.5">
                  <strong className="text-sm">
                    {account.identity?.account_email ?? account.label}
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    {[
                      account.identity?.plan,
                      account.active ? tr("quota.activeAccount") : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                {account.updated_at && (
                  <time className="text-xs text-muted-foreground">
                    {formatRelativeTime(account.updated_at)}
                  </time>
                )}
              </header>
              <div className="grid">
                {accountWindows.map((item) => (
                  <QuotaWindowRow key={item.key} item={item} target={item.key === targetKey} />
                ))}
              </div>
              {account.error && (
                <Collapsible className="mt-3 text-xs text-muted-foreground">
                  <CollapsibleTrigger className="w-fit cursor-pointer bg-transparent">
                    {tr("quota.partialData")}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2">
                      {account.error}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </section>
          ),
      )}

      {unavailable && (
        <div className="grid min-h-[210px] place-content-center justify-items-center gap-2 text-muted-foreground">
          <Gauge size={24} />
          <strong className="text-sm text-foreground">{tr("quota.providerUnavailable")}</strong>
          <span className="text-xs">{tr("quota.noWindows")}</span>
        </div>
      )}
      {provider.error && (
        <Collapsible
          className={cn(
            "mt-3 text-xs",
            providerHasPartialData(provider) ? "text-amber-600" : "text-muted-foreground",
          )}
        >
          <CollapsibleTrigger className="w-fit cursor-pointer bg-transparent">
            {tr(providerHasPartialData(provider) ? "quota.partialData" : "common.details")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2">
              {provider.error}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}

function QuotaDisplaySettings({
  snapshot,
  preferences,
  onChange,
  onClose,
}: {
  snapshot: QuotaSnapshot;
  preferences: QuotaPopoverPreferences;
  onChange: (preferences: QuotaPopoverPreferences) => void;
  onClose: () => void;
}) {
  const [saveError, setSaveError] = useState("");
  const currentPreferences = useRef(preferences);
  const saveSequence = useRef(0);
  useEffect(() => {
    currentPreferences.current = preferences;
  }, [preferences]);
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
    void persist({
      ...current,
      hidden_providers: hidden
        ? current.hidden_providers.filter((id) => id !== providerId)
        : [...current.hidden_providers, providerId],
    });
  };
  const toggleWindow = (selector: QuotaWindowSelector) => {
    const current = currentPreferences.current;
    const key = quotaWindowKey(selector);
    const hidden = current.hidden_windows.some((item) => quotaWindowKey(item) === key);
    void persist({
      ...current,
      hidden_windows: hidden
        ? current.hidden_windows.filter((item) => quotaWindowKey(item) !== key)
        : [...current.hidden_windows, selector],
    });
  };
  return (
    <aside
      className="absolute right-0 top-14 z-20 grid max-h-[min(620px,calc(100vh-150px))] w-[min(420px,calc(100vw-72px))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-border bg-card shadow-xl"
      aria-label={tr("quota.popoverSettings")}
    >
      <header className="flex items-start justify-between border-b border-border px-3.5 pb-3 pt-3.5">
        <div className="grid gap-1">
          <strong className="text-sm">{tr("quota.popoverSettings")}</strong>
          <span className="text-xs text-muted-foreground">{tr("quota.popoverSettingsHint")}</span>
        </div>
        <Button
          variant="outline"
          size="icon"
          type="button"
          onClick={onClose}
          aria-label={tr("common.close")}
        >
          <X size={15} />
        </Button>
      </header>
      <div className="overflow-auto p-1.5">
        {snapshot.providers.filter(isQuotaProviderSupported).map((provider) => (
          <QuotaDisplayProviderOption
            key={provider.id}
            provider={provider}
            preferences={preferences}
            onToggleProvider={toggleProvider}
            onToggleWindow={toggleWindow}
          />
        ))}
      </div>
      {saveError && (
        <div
          className="border-t border-border-subtle px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {saveError}
        </div>
      )}
      <footer className="flex justify-end border-t border-border px-3 py-2.5">
        <Button
          variant="outline"
          type="button"
          onClick={() => void persist({ hidden_providers: [], hidden_windows: [] })}
        >
          <Check size={14} />
          {tr("quota.restorePopoverDefaults")}
        </Button>
      </footer>
    </aside>
  );
}

function QuotaDisplayProviderOption({
  provider,
  preferences,
  onToggleProvider,
  onToggleWindow,
}: {
  provider: QuotaProvider;
  preferences: QuotaPopoverPreferences;
  onToggleProvider: (providerId: string) => void;
  onToggleWindow: (selector: QuotaWindowSelector) => void;
}) {
  const windows = flattenQuotaWindows(provider);
  const providerVisible = !preferences.hidden_providers.includes(provider.id);
  const [expanded, setExpanded] = useState(providerVisible && windows.length > 0);
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="flex min-h-[52px] items-center justify-between px-2 py-1.5">
        <Label className="grid min-w-0 flex-1 grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2">
          <Checkbox
            checked={providerVisible}
            disabled={!windows.length}
            onCheckedChange={() => onToggleProvider(provider.id)}
          />
          <ProviderIcon provider={provider} />
          <span className="grid min-w-0 gap-0.5">
            <strong className="truncate text-[13px]">{provider.name}</strong>
            <small className="truncate text-xs text-muted-foreground">
              {windows.length
                ? tr("quota.windowCount", { count: windows.length })
                : tr("quota.noWindows")}
            </small>
          </span>
        </Label>
        <CollapsibleTrigger
          className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={tr("common.details")}
        >
          <ChevronDown size={14} />
        </CollapsibleTrigger>
      </div>
      {windows.length > 0 && (
        <CollapsibleContent className="grid gap-1 px-2 pb-2 pl-11">
          {windows.map((item) => (
            <Label
              className="grid min-h-[42px] grid-cols-[auto_minmax(0,1fr)] items-center gap-2"
              key={item.key}
            >
              <Checkbox
                checked={
                  providerVisible &&
                  !preferences.hidden_windows.some((hidden) => quotaWindowKey(hidden) === item.key)
                }
                disabled={!providerVisible}
                onCheckedChange={() => onToggleWindow(item.selector)}
              />
              <span className="grid min-w-0 gap-0.5">
                <strong className="truncate text-[13px]">
                  {item.window.label || tr(`quota.window.${item.window.kind}`)}
                </strong>
                <small className="truncate text-xs text-muted-foreground">
                  {item.accountLabel ??
                    provider.identity?.account_email ??
                    provider.identity?.plan ??
                    provider.name}
                </small>
              </span>
            </Label>
          ))}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
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
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(document.documentElement.lang || "en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(document.documentElement.lang || "en-US", {
    maximumFractionDigits: 2,
  }).format(value);
}
