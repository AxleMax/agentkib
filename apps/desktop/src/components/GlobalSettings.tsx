import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  CircleAlert,
  ExternalLink,
  FolderGit2,
  GitCommitHorizontal,
  History,
  Trash2,
  X,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SelectControl } from "@/components/ui/select-control";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppDialogs } from "./AppDialogProvider";
import { AgentIcon } from "./AgentIcon";
import { ObsidianSettingsCard } from "./ObsidianIntegration";
import { QuotaDiagnostics } from "./QuotaDiagnostics";
import { RemoteGatewaysSettings } from "./RemoteGateways";
import { api } from "../core/api";
import { changeLocale, formatDateTime, localizeMessage, tr } from "../core/i18n";
import { applyTheme } from "../core/theme";
import {
  normalizePlatform,
  primaryShortcutModifier,
  usesSystemTrayWording,
} from "../core/platform";
import type { SettingsSection } from "./SettingsSidebar";
import type {
  ActivityRecord,
  AgentKind,
  AppIconPreference,
  CloseBehavior,
  DiscoveryReport,
  ExcludedWorkspace,
  GitIdentitySummary,
  InsightsStatus,
  LocalePreference,
  QuotaCollectorStatus,
  RemoteGatewaySummary,
  RuntimeInfo,
  ScanRoot,
  ThemePreference,
  WorkspaceSummary,
} from "../core/types";
import { cn } from "@/lib/utils";

const buildPlatform = import.meta.env.TAURI_ENV_PLATFORM;
const appPlatform = normalizePlatform(buildPlatform);
const hasFileAccessSettings = ["macos", "windows"].includes(appPlatform);
const agentLabels: Record<AgentKind, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  "open-claw": "OpenClaw",
  hermes: "Hermes",
  "deepseek-harness": "DeepSeek Harness",
};

export type GlobalSettingsProps = {
  section: SettingsSection;
  runtime?: RuntimeInfo;
  workspaces: WorkspaceSummary[];
  discovery?: DiscoveryReport;
  insightsStatus?: InsightsStatus;
  quotaStatus?: QuotaCollectorStatus;
  remoteGateways: RemoteGatewaySummary[];
  scanRoots: ScanRoot[];
  excluded: ExcludedWorkspace[];
  activity: ActivityRecord[];
  onAddRoot: () => Promise<void>;
  onRemoveRoot: (id: string) => Promise<void>;
  onRestore: (path: string) => Promise<void>;
  onCloseBehaviorChanged: (behavior?: CloseBehavior) => Promise<void>;
  onLocaleChanged: (runtime: RuntimeInfo) => void;
  onRemoteGatewaysChanged: () => Promise<void>;
};

export function GlobalSettings({
  section,
  runtime,
  workspaces,
  discovery,
  insightsStatus,
  quotaStatus,
  remoteGateways,
  scanRoots,
  excluded,
  activity,
  onAddRoot,
  onRemoveRoot,
  onRestore,
  onCloseBehaviorChanged,
  onLocaleChanged,
  onRemoteGatewaysChanged,
}: GlobalSettingsProps) {
  if (section === "general")
    return (
      <div className="grid gap-5">
        <SettingGroup title={tr("settings.interface")}>
          <ThemeSetting runtime={runtime} onChanged={onLocaleChanged} />
          <AppIconSetting runtime={runtime} onChanged={onLocaleChanged} />
          <LanguageSetting runtime={runtime} onChanged={onLocaleChanged} />
          <SettingsRow>
            <SettingsCopy>
              <strong>{tr("settings.closeBehavior")}</strong>
            </SettingsCopy>
            <CloseBehaviorSelect
              value={runtime?.close_behavior}
              trayAvailable={runtime?.tray_available !== false}
              onChange={onCloseBehaviorChanged}
            />
          </SettingsRow>
          {runtime?.tray_available === false && (
            <SettingDetail variant="warning" role="status">
              <CircleAlert size={14} />
              {tr("settings.trayUnavailable")}
            </SettingDetail>
          )}
        </SettingGroup>
      </div>
    );
  if (section === "discovery")
    return (
      <div className="grid gap-5">
        <SettingGroup title={tr("settings.discovery")}>
          <SettingsRow>
            <SettingsCopy>
              <strong>{tr("settings.discoveryStatus")}</strong>
            </SettingsCopy>
            <span
              className={cn(
                "font-medium",
                discovery?.errors.length ? "text-destructive" : "text-emerald-600",
              )}
            >
              {discovery
                ? tr("settings.workspaceCount", { count: discovery.discovered_count })
                : tr("home.discovering")}
            </span>
          </SettingsRow>
          {discovery?.errors.map((error) => (
            <SettingDetail variant="error" key={error}>
              {error}
            </SettingDetail>
          ))}
        </SettingGroup>
        <SettingGroup title={tr("settings.scanRoots")}>
          <div className="flex justify-end border-b border-border/60 px-5 py-3">
            <Button
              size="sm"
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={() => void onAddRoot()}
            >
              {tr("settings.addFolder")}
            </Button>
          </div>
          <SettingsListEmptyState items={scanRoots.length} emptyText={tr("settings.noScanRoots")}>
            <div className="divide-y divide-border/60">
              {scanRoots.map((root) => (
                <div
                  className="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3"
                  key={root.id}
                >
                  <FolderGit2 size={17} className="text-muted-foreground" />
                  <span className="min-w-0">
                    <strong className="block break-all text-sm font-medium">{root.path}</strong>
                    <small className="mt-1 block text-xs text-muted-foreground">
                      {tr("settings.maxDepth", { depth: root.max_depth })}
                    </small>
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10"
                    aria-label={tr("common.remove")}
                    onClick={() => void onRemoveRoot(root.id)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))}
            </div>
          </SettingsListEmptyState>
        </SettingGroup>
        <SettingGroup title={tr("settings.excluded")}>
          <SettingsListEmptyState items={excluded.length} emptyText={tr("settings.noExcluded")}>
            <div className="divide-y divide-border/60">
              {excluded.map((item) => (
                <div
                  className="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3"
                  key={item.path}
                >
                  <X size={17} className="text-muted-foreground" />
                  <span className="min-w-0">
                    <strong className="block break-all text-sm font-medium">{item.path}</strong>
                    <small className="mt-1 block text-xs text-muted-foreground">
                      {formatDateTime(item.created_at)}
                    </small>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void onRestore(item.path)}>
                    {tr("common.restore")}
                  </Button>
                </div>
              ))}
            </div>
          </SettingsListEmptyState>
        </SettingGroup>
      </div>
    );
  if (section === "integrations")
    return (
      <div className="grid gap-5">
        <SettingGroup title="AgentKib MCP Hub">
          <SettingsRow border={false}>
            <SettingsCopy>
              <strong>{tr("mcp.network")}</strong>
              <code>
                {runtime?.mcp_hub ? runtime.mcp_hub.accessible_addresses.join(" · ") : "—"}
              </code>
            </SettingsCopy>
            <StatusText active={Boolean(runtime?.mcp_hub?.running)}>
              {tr(runtime?.mcp_hub?.running ? "mcp.running" : "mcp.stopped")}
            </StatusText>
          </SettingsRow>
        </SettingGroup>
        <RemoteGatewaysSettings gateways={remoteGateways} onChanged={onRemoteGatewaysChanged} />
        <ObsidianSettingsCard />
      </div>
    );
  if (section === "privacy")
    return (
      <div className="grid gap-5">
        <SettingGroup title={tr("settings.localData")}>
          <SettingsRow border={false}>
            <SettingsCopy>
              <strong>{tr("settings.dataLocation")}</strong>
              <code>{runtime?.data_dir ?? "—"}</code>
            </SettingsCopy>
            <StatusText active>
              <Check size={14} />
              {tr("common.localOnly")}
            </StatusText>
          </SettingsRow>
          {hasFileAccessSettings && <FileAccessSettingsRow />}
        </SettingGroup>
        <ConversationPrivacySettings
          runtime={runtime}
          workspaces={workspaces}
          onChanged={onLocaleChanged}
        />
        <GitIdentitySettings />
      </div>
    );
  return (
    <div className="grid gap-5">
      <div className="grid gap-5 xl:grid-cols-2">
        <SettingGroup title={tr("quota.diagnostics")}>
          <QuotaDiagnostics status={quotaStatus} />
        </SettingGroup>
        <SettingGroup title={tr("settings.providerStatus")}>
          {insightsStatus?.providers.map((provider) => (
            <SettingsRow key={provider.agent}>
              <div className="flex items-center gap-3">
                <AgentIcon agent={provider.agent} />
                <strong className="text-sm font-medium">{agentLabels[provider.agent]}</strong>
              </div>
              <StatusText active={provider.available}>
                {tr(provider.available ? "quota.available" : "insights.noData")}
              </StatusText>
            </SettingsRow>
          ))}
          {!insightsStatus?.providers.length && (
            <div className="px-5 py-4 text-sm text-muted-foreground">{tr("insights.noData")}</div>
          )}
        </SettingGroup>
      </div>
      <ActivityPage records={activity} />
    </div>
  );
}

function ActivityPage({ records }: { records: ActivityRecord[] }) {
  return (
    <Card className="rounded-xl border border-border bg-card shadow-sm">
      <CardHeader className="flex items-center justify-between gap-3 border-b border-border px-4 py-4">
        <div>
          <h2>{tr("activity.title")}</h2>
          <p>{tr("activity.description")}</p>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid gap-4">
          {records.map((record) => (
            <ActivityRow key={record.id} record={record} />
          ))}
          {!records.length && (
            <div className="grid min-h-[260px] place-content-center justify-items-center gap-1.5 p-[30px] text-center text-muted-foreground">
              <History size={28} className="mb-1.5" />
              <h3 className="m-0 text-[13px] font-semibold text-foreground">
                {tr("home.noActivity")}
              </h3>
              <p className="m-0 max-w-[380px] leading-relaxed">{tr("activity.emptyText")}</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
function ActivityRow({ record }: { record: ActivityRecord }) {
  const key = `activity.action.${record.action}`;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border p-3">
      <span className="mt-1 size-2 shrink-0 rounded-full bg-primary" />
      <div>
        <strong>{tr(key, { defaultValue: record.action })}</strong>
        <small title={record.detail}>{record.detail}</small>
      </div>
      <time>{formatDateTime(record.created_at)}</time>
    </div>
  );
}

function SettingsRow({ children, border = true }: { children: ReactNode; border?: boolean }) {
  return (
    <div
      className={cn(
        "flex min-h-16 flex-wrap items-center justify-between gap-4 px-5 py-3",
        border && "border-b border-border/60",
      )}
    >
      {children}
    </div>
  );
}
function SettingsCopy({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1 [&_code]:max-w-full [&_code]:truncate [&_code]:font-mono [&_code]:text-xs [&_code]:text-muted-foreground [&_strong]:text-sm [&_strong]:font-medium">
      {children}
    </div>
  );
}
function SettingDetail({
  children,
  variant = "default",
  role,
}: {
  children: ReactNode;
  variant?: "default" | "error" | "warning";
  role?: "alert" | "status";
}) {
  return (
    <div
      className={cn(
        "mx-5 my-3 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs",
        variant === "default" && "border-border/60 bg-muted/20 text-muted-foreground",
        variant === "error" && "border-destructive/30 bg-destructive/5 text-destructive",
        variant === "warning" && "border-amber-500/30 bg-amber-500/5 text-amber-700",
      )}
      role={role}
    >
      {children}
    </div>
  );
}
function SettingGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="overflow-hidden rounded-2xl border-border/70 bg-card shadow-sm">
      <CardHeader className="border-b border-border/60 bg-muted/20 px-5 py-4">
        <CardTitle className="text-sm font-semibold tracking-tight">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  );
}
function SettingsListEmptyState({
  items,
  emptyText,
  children,
}: {
  items: number;
  emptyText: string;
  children: ReactNode;
}) {
  return items ? (
    <>{children}</>
  ) : (
    <p className="px-5 py-5 text-sm text-muted-foreground">{emptyText}</p>
  );
}
function StatusText({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium",
        active ? "text-emerald-600" : "text-muted-foreground",
      )}
    >
      {active && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

function FileAccessSettingsRow() {
  const [error, setError] = useState("");
  const openSettings = async () => {
    setError("");
    try {
      await api.openFilesAndFoldersSettings();
    } catch (reason) {
      setError(localizeMessage(reason));
    }
  };
  return (
    <>
      <SettingsRow border={false}>
        <SettingsCopy>
          <strong>{tr("settings.appDataAccess")}</strong>
        </SettingsCopy>
        <Button
          className="border border-transparent bg-transparent text-foreground hover:bg-muted"
          type="button"
          onClick={() => void openSettings()}
        >
          <ExternalLink size={14} />
          {tr("settings.openFilesAndFolders")}
        </Button>
      </SettingsRow>
      {error && (
        <SettingDetail variant="error" role="alert">
          {error}
        </SettingDetail>
      )}
    </>
  );
}

function ConversationPrivacySettings({
  runtime,
  workspaces,
  onChanged,
}: {
  runtime?: RuntimeInfo;
  workspaces: WorkspaceSummary[];
  onChanged: (runtime: RuntimeInfo) => void;
}) {
  const dialogs = useAppDialogs();
  const [indexedCount, setIndexedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const loadCount = async () => {
    const statuses = await Promise.all(
      workspaces.map((workspace) => api.workspaceSessionStatus(workspace.id)),
    );
    setIndexedCount(statuses.filter((items) => items.some((item) => item.last_success_at)).length);
  };
  useEffect(() => {
    void loadCount().catch(() => undefined);
  }, [workspaces]);
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError("");
    try {
      onChanged(await api.setSessionIndexEnabled(enabled));
      if (!enabled) setIndexedCount(0);
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    if (
      !(await dialogs.confirm({
        description: tr("conversations.clearConfirm"),
        tone: "destructive",
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api.clearSessionIndex();
      setIndexedCount(0);
    } catch (reason) {
      setError(localizeMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingGroup title={tr("conversations.settingsTitle")}>
      <SettingsRow>
        <SettingsCopy>
          <strong>{tr("conversations.indexSetting")}</strong>
        </SettingsCopy>
        <Label className="inline-flex items-center">
          <Switch
            checked={runtime?.session_index_enabled !== false}
            disabled={busy}
            onCheckedChange={(checked) => void toggle(checked)}
          />
        </Label>
      </SettingsRow>
      <SettingsRow>
        <SettingsCopy>
          <strong>{tr("conversations.indexedWorkspaces", { count: indexedCount })}</strong>
        </SettingsCopy>
        <Button
          className="border border-transparent bg-transparent text-foreground hover:bg-muted"
          disabled={busy || indexedCount === 0}
          onClick={() => void clear()}
        >
          <Trash2 size={14} />
          {tr("conversations.clearIndex")}
        </Button>
      </SettingsRow>
      {error && (
        <SettingDetail variant="error" role="alert">
          {error}
        </SettingDetail>
      )}
    </SettingGroup>
  );
}

function LanguageSetting({
  runtime,
  onChanged,
}: {
  runtime?: RuntimeInfo;
  onChanged: (runtime: RuntimeInfo) => void;
}) {
  const update = async (preference: LocalePreference) => {
    const nextRuntime = await api.setLocale(preference);
    await changeLocale(nextRuntime.effective_locale);
    onChanged(nextRuntime);
  };
  return (
    <SettingsRow>
      <SettingsCopy>
        <strong>{tr("settings.language")}</strong>
      </SettingsCopy>
      <SelectControl
        aria-label={tr("settings.language")}
        className="h-9 min-w-40 rounded-lg border-input bg-background px-3 text-sm shadow-sm"
        value={runtime?.locale_preference ?? "system"}
        onChange={(event) => void update(event.target.value as LocalePreference)}
      >
        {(["system", "zh-CN", "zh-TW", "ja-JP", "en-US"] as LocalePreference[]).map((locale) => (
          <option key={locale} value={locale}>
            {tr(`settings.language.${locale}`)}
          </option>
        ))}
      </SelectControl>
    </SettingsRow>
  );
}

function ThemeSetting({
  runtime,
  onChanged,
}: {
  runtime?: RuntimeInfo;
  onChanged: (runtime: RuntimeInfo) => void;
}) {
  const update = async (preference: ThemePreference) => {
    const nextRuntime = await api.setThemePreference(preference);
    applyTheme(nextRuntime.effective_theme);
    onChanged(nextRuntime);
  };
  const selected = runtime?.theme_preference ?? "system";
  return (
    <SettingsRow>
      <SettingsCopy>
        <strong>{tr("settings.theme")}</strong>
      </SettingsCopy>
      <ToggleGroup
        spacing={0}
        variant="outline"
        className="shrink-0 rounded-lg shadow-sm"
        value={[selected]}
        onValueChange={(values) => {
          const theme = values[0];
          if (theme === "light" || theme === "dark" || theme === "system") void update(theme);
        }}
        aria-label={tr("settings.theme")}
      >
        {(["light", "dark", "system"] as ThemePreference[]).map((theme) => (
          <ToggleGroupItem key={theme} value={theme} className="h-9 min-w-[66px] px-3 text-sm">
            {tr(`settings.theme.${theme}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </SettingsRow>
  );
}

function AppIconSetting({
  runtime,
  onChanged,
}: {
  runtime?: RuntimeInfo;
  onChanged: (runtime: RuntimeInfo) => void;
}) {
  const update = async (preference: AppIconPreference) => {
    onChanged(await api.setAppIconPreference(preference));
  };
  const selected = runtime?.app_icon_preference ?? "white";
  return (
    <SettingsRow>
      <SettingsCopy>
        <strong>{tr("settings.appIcon")}</strong>
      </SettingsCopy>
      <ToggleGroup
        spacing={0}
        variant="outline"
        className="shrink-0 rounded-lg shadow-sm"
        value={[selected]}
        onValueChange={(values) => {
          const icon = values[0];
          if (icon === "white" || icon === "black") void update(icon);
        }}
        aria-label={tr("settings.appIcon")}
      >
        {(["white", "black"] as AppIconPreference[]).map((icon) => (
          <ToggleGroupItem
            key={icon}
            value={icon}
            className="inline-flex h-9 min-w-[90px] items-center justify-center gap-1.5 px-3 text-sm"
          >
            {icon === "white" ? (
              <span className="size-4 rounded border border-border bg-white" aria-hidden="true" />
            ) : (
              <span className="size-4 rounded border border-border bg-black" aria-hidden="true" />
            )}
            {tr(`settings.appIcon.${icon}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </SettingsRow>
  );
}

function CloseBehaviorSelect({
  value,
  trayAvailable = true,
  onChange,
}: {
  value?: CloseBehavior;
  trayAvailable?: boolean;
  onChange: (behavior?: CloseBehavior) => Promise<void>;
}) {
  const modifier = primaryShortcutModifier(buildPlatform);
  const trayKey = usesSystemTrayWording(buildPlatform)
    ? "settings.close.systemTray"
    : "settings.close.tray";
  const selected = value ?? "ask";
  return (
    <SelectControl
      aria-label={tr("settings.closeBehavior")}
      className="h-9 min-w-40 rounded-lg border-input bg-background px-3 text-sm shadow-sm"
      title={tr("settings.close.quitShortcut", { modifier })}
      value={selected}
      onChange={(event) =>
        void onChange(
          event.target.value === "ask" ? undefined : (event.target.value as CloseBehavior),
        )
      }
    >
      <option value="ask">{tr("settings.close.ask")}</option>
      <option value="minimize-to-tray" disabled={!trayAvailable}>
        {tr(trayKey)}
      </option>
      <option value="quit">{tr("settings.close.quit")}</option>
    </SelectControl>
  );
}

function GitIdentitySettings() {
  const [identities, setIdentities] = useState<GitIdentitySummary[]>([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const load = async () => {
    try {
      setIdentities(await api.gitIdentities());
    } catch (reason) {
      setError(localizeMessage(reason));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const add = async () => {
    if (!email.trim()) return;
    try {
      setError("");
      await api.addGitIdentityAlias(email);
      setEmail("");
      await load();
    } catch (reason) {
      setError(localizeMessage(reason));
    }
  };
  return (
    <SettingGroup title={tr("settings.gitIdentity")}>
      {error && (
        <SettingDetail variant="error" role="alert">
          {error}
        </SettingDetail>
      )}
      <div className="flex flex-col gap-2.5 border-b border-border/60 p-5 sm:flex-row">
        <Input
          className="min-w-0 flex-1"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add();
          }}
          placeholder={tr("settings.gitAliasPlaceholder")}
        />
        <Button className="shrink-0" onClick={() => void add()}>
          {tr("settings.addAlias")}
        </Button>
      </div>
      <div className="divide-y divide-border/60">
        {identities.map((identity) => (
          <Label
            className="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3"
            key={identity.id}
          >
            <GitCommitHorizontal size={15} className="text-muted-foreground" />
            <span className="min-w-0">
              <strong className="block break-all text-sm font-medium">
                {metadataLabel(identity.label)}
              </strong>
              <small className="mt-1 block text-xs text-muted-foreground">
                {identity.source} · {identity.id.slice(0, 10)}…
              </small>
            </span>
            <Switch
              checked={identity.enabled}
              onCheckedChange={async (checked) => {
                await api.setGitIdentityEnabled(identity.id, checked);
                await load();
              }}
            />
          </Label>
        ))}
        {!identities.length && (
          <p className="px-5 py-5 text-sm text-muted-foreground">
            {tr("settings.gitIdentityEmpty")}
          </p>
        )}
      </div>
    </SettingGroup>
  );
}

function metadataLabel(value: string) {
  if (value === "__unknown_model__") return tr("insights.unknownModel");
  if (value === "__unlinked_workspace__") return tr("insights.unlinkedWorkspace");
  if (value === "仓庫 Git 身份") return tr("settings.gitIdentityRepository");
  if (value === "全局 Git 身份") return tr("settings.gitIdentityGlobal");
  if (value === "历史邮箱别名") return tr("settings.gitIdentityAlias");
  return value.startsWith("settings.gitIdentity") ? tr(value) : value;
}
