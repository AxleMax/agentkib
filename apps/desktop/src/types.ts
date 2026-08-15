export type AgentKind = "codex" | "claude-code" | "cursor" | "open-claw" | "hermes" | "deepseek-harness";
export type MemoryStatus = "pending" | "approved" | "rejected" | "invalidated";
export type MemoryType = "user_preference" | "project_fact" | "decision" | "constraint" | "failed_attempt" | "open_loop" | "task_state" | "agent_observation";

export interface AgentDetection { agent: AgentKind; detected: boolean; asset_count: number; warnings: string[] }
export interface AssetRecord { agent: AgentKind; kind: string; path: string; exists: boolean; size: number; summary: string; summary_key?: string; summary_params?: Record<string, string> }
export interface WorkspaceScan { root: string; manifest_exists: boolean; agents: AgentDetection[]; assets: AssetRecord[]; warnings: string[] }
export interface SkillDefinition { name: string; path: string; targets: AgentKind[] }
export type ConnectionDefinition =
  | { name: string; transport: "stdio"; command: string; args: string[]; env: Record<string, string>; allow_tools: string[]; targets: AgentKind[] }
  | { name: string; transport: "http"; url: string; env: Record<string, string>; allow_tools: string[]; targets: AgentKind[] };
export interface Manifest { schema_version: number; workspace: { id: string; name: string }; instructions: { shared: string; scoped: Array<{ path: string; content: string }>; platform_overrides: Partial<Record<AgentKind, string>> }; skills: SkillDefinition[]; mcp: { config: string }; connections: ConnectionDefinition[]; memories: { require_approval: boolean }; adapters: Partial<Record<AgentKind, { enabled: boolean; generated_hashes: Record<string, string> }>> }
export interface ContextPreview { agent: AgentKind; project: string; cwd: string; sections: Array<{ source: string; scope: string; content: string; precedence: number }>; visible_skills: string[]; visible_connections: string[]; approved_memories: string[]; warnings: string[] }
export interface FileChange { target: string; scope: "project" | "agent-home"; original_hash?: string; before: string; after: string; risk: "low" | "medium" | "high"; validator: string }
export interface ChangeSet { id: string; project_root: string; created_at: string; changes: FileChange[]; requires_home_approval: boolean }
export interface MemoryRecord { id: string; project_id: string; memory_type: MemoryType; content: string; status: MemoryStatus; source_agent?: string; source_thread?: string; source_reference?: string; created_at: string; approved_at?: string; invalidated_by?: string }
export type CloseBehavior = "minimize-to-tray" | "quit";
export type SupportedLocale = "zh-CN" | "zh-TW" | "ja-JP" | "en-US";
export type LocalePreference = "system" | SupportedLocale;
export type ThemePreference = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";
export interface LocalizedMessage { key: string; params?: Record<string, string | number>; detail?: string }
export interface McpNetworkSettings { port: number; lan_enabled: boolean; lan_risk_accepted: boolean }
export interface McpHubStatus { running: boolean; bind_address: string; port: number; lan_enabled: boolean; accessible_addresses: string[]; runtime_count: number; error_count: number; last_error?: string }
export type McpRuntimeState = "stopped" | "starting" | "running" | "error";
export interface McpRuntimeStatus { server_id: string; server_name: string; config_hash: string; state: McpRuntimeState; started_at?: string; last_used_at?: string; error?: string }
export type McpPackageKind = "npm" | "pypi" | "remote" | "local";
export type McpServerTransport = { transport: "stdio"; command: string; args: string[]; cwd?: string } | { transport: "streamable-http"; url: string } | { transport: "sse"; url: string };
export type McpServerConfig = { id: string; name: string; enabled: boolean; env: Record<string, string>; headers: Record<string, string>; targets: AgentKind[]; allow_tools: string[]; lan_allow_tools: string[]; supports_parallel_tool_calls: boolean; package?: { kind: McpPackageKind; identifier: string; version?: string } } & McpServerTransport;
export interface McpToolDescriptor { server_id: string; name: string; description?: string; input_schema: unknown; read_only: boolean }
export interface McpRegistryEntry { name: string; description: string; version: string; package_kind: McpPackageKind; identifier: string; runtime_hint?: string; url?: string; required_env: string[]; runtime_arguments: string[]; package_arguments: string[] }
export interface McpInstallation { id: string; name: string; package_kind: McpPackageKind; identifier: string; version?: string; install_path?: string; status: string; installed_at: string; updated_at: string }
export interface McpMigrationCandidate { id: string; agent: AgentKind; scope: string; name: string; source_path: string; transport: string; endpoint: string; has_secret_values: boolean; supported: boolean; warnings: string[] }
export interface McpOAuthStart { authorization_url: string }
export interface McpInstallResult { installation: McpInstallation; server: McpServerConfig; tools: McpToolDescriptor[] }
export interface RuntimeInfo { data_dir: string; database_path: string; mcp_package_root: string; mcp_hub: McpHubStatus; mcp_network: McpNetworkSettings; openclaw_config?: string; hermes_config?: string; close_behavior?: CloseBehavior; locale_preference: LocalePreference; effective_locale: SupportedLocale; theme_preference: ThemePreference; effective_theme: EffectiveTheme; tray_available: boolean }
export type WorkspaceStatus = "healthy" | "attention";
export type DiscoveryEvidence = "session-cwd" | "configured-workspace" | "scan-marker" | "manual";
export interface WorkspaceSource { agent?: AgentKind; evidence: DiscoveryEvidence; session_count: number; last_active_at?: string }
export interface WorkspaceSummary { id: string; path: string; name: string; repository_group_id?: string; manifest_workspace_id?: string; status: WorkspaceStatus; asset_count: number; warning_count: number; last_active_at?: string; last_scanned_at?: string; sources: WorkspaceSource[] }
export interface AgentInstallation { agent: AgentKind; installed: boolean; configured: boolean; version?: string; home?: string; warnings: string[] }
export interface CatalogAsset { id: string; scope: "workspace" | "agent-home"; workspace_id?: string; agent?: AgentKind; kind: string; name: string; path: string; summary: string; summary_key?: string; summary_params?: Record<string, string>; size: number; modified_at?: string }
export interface DiscoveryReport { started_at: string; finished_at: string; discovered_count: number; removed_count: number; errors: string[] }
export interface ScanRoot { id: string; path: string; enabled: boolean; max_depth: number; created_at: string }
export interface ExcludedWorkspace { path: string; created_at: string }
export interface ObsidianInstallation { installed: boolean; app_path?: string; version?: string; cli_available: boolean }
export interface ObsidianVault { path: string; name: string; source: "discovered" | "manual"; last_opened_at?: number }
export interface ObsidianWorkspaceLink { workspace_id: string; vault_path: string; target_path: string }
export interface ObsidianIntegration { installation: ObsidianInstallation; vaults: ObsidianVault[]; workspace_links: ObsidianWorkspaceLink[] }
export type RemoteGatewayKind = "open-claw" | "hermes";
export type RemoteGatewayAuthKind = "none" | "token" | "password" | "session-token" | "basic";
export type RemoteGatewayState = "pending" | "connected" | "pairing-required" | "error";
export interface RemoteGatewayInput { id?: string; kind: RemoteGatewayKind; name: string; url: string; auth_kind: RemoteGatewayAuthKind; username?: string; secret?: string }
export interface RemoteGatewayWorkspace { id: string; agent_id?: string; name: string; path?: string; session_count: number; last_active_at?: string }
export interface RemoteGatewayAsset { id: string; agent_id?: string; kind: string; name: string; path: string; size: number }
export interface RemoteGatewaySummary { id: string; kind: RemoteGatewayKind; name: string; url: string; auth_kind: RemoteGatewayAuthKind; username?: string; has_credentials: boolean; state: RemoteGatewayState; version?: string; capabilities: string[]; session_count: number; workspaces: RemoteGatewayWorkspace[]; assets: RemoteGatewayAsset[]; pairing_request_id?: string; last_connected_at?: string; last_error?: string }
export interface ActivityRecord { id: string; project_id?: string; action: string; detail: string; created_at: string }
export type UsageQuality = "exact" | "estimated" | "incomplete";
export interface InsightsQuery { from?: string; to?: string; agent?: AgentKind; workspace_id?: string; repository_group_id?: string }
export interface InsightsSummary { total_tokens: number; input_tokens: number; output_tokens: number; cache_tokens: number; reasoning_tokens: number; session_count: number; my_commits: number; all_commits: number; attributed_commits: number; active_days: number; current_streak: number; longest_streak: number; quality: UsageQuality; coverage_from?: string; coverage_to?: string; refreshed_at?: string }
export interface HeatmapPoint { date: string; tokens: number; my_commits: number; all_commits: number; attributed_commits: number; sessions: number; quality: UsageQuality }
export interface AgentUsageBreakdown { agent: AgentKind; total_tokens: number; input_tokens: number; output_tokens: number; cache_tokens: number; reasoning_tokens: number; session_count: number; quality: UsageQuality }
export interface ModelUsageBreakdown { model: string; total_tokens: number; session_count: number }
export interface WorkspaceUsageBreakdown { workspace_id?: string; name: string; total_tokens: number; session_count: number }
export interface RepositoryCommitBreakdown { repository_group_id: string; name: string; my_commits: number; all_commits: number; attributed_commits: number }
export interface Achievement { code: string; category: string; threshold: number; progress: number; unlocked_at?: string }
export interface ProviderStatus { agent: AgentKind; available: boolean; quality: UsageQuality; coverage_from?: string; coverage_to?: string; imported_events: number; error_key?: string; error_params?: Record<string, string>; error?: string }
export interface InsightsStatus { providers: ProviderStatus[]; refreshed_at?: string; running: boolean }
export type RefreshKind = "discovery" | "insights" | "gateways" | "quota" | "storage";
export type RefreshState = "idle" | "queued" | "running" | "succeeded" | "failed" | "backoff";
export interface RefreshReceipt { kind: RefreshKind; disposition: "queued" | "already-running" | "backoff"; request_id: string; status: RefreshJobStatus }
export interface RefreshJobStatus { kind: RefreshKind; state: RefreshState; request_id?: string; queued_at?: string; started_at?: string; finished_at?: string; progress_current?: number; progress_total?: number; error?: string; next_allowed_at?: string }
export type StorageMeasurement = "allocated-exact" | "logical-estimate";
export type StorageQuality = "complete" | "partial" | "unavailable";
export type StorageBreakdownKind = "directory" | "root-files";
export interface StorageBreakdown { name: string; relative_path: string; kind: StorageBreakdownKind; allocated_bytes: number; logical_bytes: number; regenerable_bytes: number; agent_asset_bytes: number }
export interface WorkspaceStorage { workspace_id: string; name: string; path: string; measurement: StorageMeasurement; quality: StorageQuality; allocated_bytes: number; logical_bytes: number; regenerable_bytes: number; agent_asset_bytes: number; file_count: number; directory_count: number; breakdown: StorageBreakdown[]; last_attempt_at: string; last_success_at?: string; error_key?: string; error_detail?: string }
export interface StorageOverview { total_workspace_count: number; scanned_workspace_count: number; allocated_bytes: number; logical_bytes: number; regenerable_bytes: number; agent_asset_bytes: number; last_scanned_at?: string; workspaces: WorkspaceStorage[] }
export interface InsightsView { summary: InsightsSummary; heatmap: HeatmapPoint[]; agents: AgentUsageBreakdown[]; models: ModelUsageBreakdown[]; workspaces: WorkspaceUsageBreakdown[]; repositories: RepositoryCommitBreakdown[]; achievements: Achievement[]; status: InsightsStatus }
export interface GitIdentitySummary { id: string; label: string; source: string; enabled: boolean }
export type QuotaBackend = "codex-bar-cli" | "win-codex-bar";
export type QuotaFreshness = "fresh" | "stale" | "unavailable";
export interface QuotaIdentity { account_email?: string; plan?: string }
export interface QuotaWindow { kind: string; label: string; used_percent: number; remaining_percent: number; reset_at?: string }
export interface QuotaCredits { remaining: number; unit: string }
export interface QuotaAccount { id: string; label: string; active: boolean; identity?: QuotaIdentity; windows: QuotaWindow[]; error?: string; updated_at?: string }
export interface QuotaProviderStatus { level: string; label: string; updated_at?: string }
export interface QuotaProvider { id: string; name: string; enabled: boolean; source?: string; status?: QuotaProviderStatus; identity?: QuotaIdentity; windows: QuotaWindow[]; credits?: QuotaCredits; error?: string; updated_at?: string; accounts: QuotaAccount[] }
export interface QuotaSnapshot { schema_version: number; backend: QuotaBackend; backend_version?: string; generated_at: string; fetched_at: string; stale_after_seconds: number; freshness: QuotaFreshness; providers: QuotaProvider[] }
export interface QuotaCollectorStatus { backend: QuotaBackend; backend_version?: string; platform_supported: boolean; sidecar_available: boolean; config_source: string; last_attempt_at?: string; last_success_at?: string; running: boolean; error_key?: string; error_detail?: string }
export interface QuotaWindowSelector { provider_id: string; account_id?: string; kind: string; label: string }
export interface QuotaPopoverPreferences { hidden_providers: string[]; hidden_windows: QuotaWindowSelector[] }
export type AppMenuCommand = "add-workspace" | "add-scan-root" | "toggle-sidebar" | "refresh-current" | "refresh-all";
export interface AppMenuCommandRequest { command: AppMenuCommand }
export interface AppNavigationRequest {
  page: "home" | "workspaces" | "catalog" | "agents" | "quota" | "insights" | "settings";
  settings_section?: "general" | "discovery" | "integrations" | "privacy" | "diagnostics";
  provider?: string;
  window?: QuotaWindowSelector;
  configure_popover?: boolean;
}
