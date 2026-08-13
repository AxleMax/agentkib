export type AgentKind = "codex" | "claude-code" | "open-claw" | "hermes";
export type MemoryStatus = "pending" | "approved" | "rejected" | "invalidated";
export type MemoryType = "user_preference" | "project_fact" | "decision" | "constraint" | "failed_attempt" | "open_loop" | "task_state" | "agent_observation";

export interface AgentDetection { agent: AgentKind; detected: boolean; asset_count: number; warnings: string[] }
export interface AssetRecord { agent: AgentKind; kind: string; path: string; exists: boolean; size: number; summary: string }
export interface WorkspaceScan { root: string; manifest_exists: boolean; agents: AgentDetection[]; assets: AssetRecord[]; warnings: string[] }
export interface SkillDefinition { name: string; path: string; targets: AgentKind[] }
export type ConnectionDefinition =
  | { name: string; transport: "stdio"; command: string; args: string[]; env: Record<string, string>; allow_tools: string[]; targets: AgentKind[] }
  | { name: string; transport: "http"; url: string; env: Record<string, string>; allow_tools: string[]; targets: AgentKind[] };
export interface Manifest { schema_version: number; workspace: { id: string; name: string }; instructions: { shared: string; scoped: Array<{ path: string; content: string }>; platform_overrides: Partial<Record<AgentKind, string>> }; skills: SkillDefinition[]; connections: ConnectionDefinition[]; memories: { require_approval: boolean }; adapters: Partial<Record<AgentKind, { enabled: boolean; generated_hashes: Record<string, string> }>> }
export interface ContextPreview { agent: AgentKind; project: string; cwd: string; sections: Array<{ source: string; scope: string; content: string; precedence: number }>; visible_skills: string[]; visible_connections: string[]; approved_memories: string[]; warnings: string[] }
export interface FileChange { target: string; scope: "project" | "agent-home"; original_hash?: string; before: string; after: string; risk: "low" | "medium" | "high"; validator: string }
export interface ChangeSet { id: string; project_root: string; created_at: string; changes: FileChange[]; requires_home_approval: boolean }
export interface MemoryRecord { id: string; project_id: string; memory_type: MemoryType; content: string; status: MemoryStatus; source_agent?: string; source_thread?: string; source_reference?: string; created_at: string; approved_at?: string; invalidated_by?: string }
export type CloseBehavior = "minimize-to-tray" | "quit";
export interface RuntimeInfo { data_dir: string; database_path: string; mcp_install_path: string; mcp_installed: boolean; openclaw_config?: string; hermes_config?: string; close_behavior?: CloseBehavior }
export type WorkspaceStatus = "needs-import" | "healthy" | "attention";
export type DiscoveryEvidence = "session-cwd" | "configured-workspace" | "scan-marker" | "manual";
export interface WorkspaceSource { agent?: AgentKind; evidence: DiscoveryEvidence; session_count: number; last_active_at?: string }
export interface WorkspaceSummary { id: string; path: string; name: string; repository_group_id?: string; manifest_workspace_id?: string; status: WorkspaceStatus; asset_count: number; warning_count: number; last_active_at?: string; last_scanned_at?: string; sources: WorkspaceSource[] }
export interface AgentInstallation { agent: AgentKind; installed: boolean; configured: boolean; version?: string; home?: string; warnings: string[] }
export interface CatalogAsset { id: string; scope: "workspace" | "agent-home"; workspace_id?: string; agent?: AgentKind; kind: string; name: string; path: string; summary: string; size: number; modified_at?: string }
export interface DiscoveryReport { started_at: string; finished_at: string; discovered_count: number; removed_count: number; errors: string[] }
export interface ScanRoot { id: string; path: string; enabled: boolean; max_depth: number; created_at: string }
export interface ExcludedWorkspace { path: string; created_at: string }
export interface ActivityRecord { id: string; project_id?: string; action: string; detail: string; created_at: string }
export type UsageQuality = "exact" | "estimated" | "incomplete";
export interface InsightsQuery { from?: string; to?: string; agent?: AgentKind; workspace_id?: string; repository_group_id?: string }
export interface InsightsSummary { total_tokens: number; input_tokens: number; output_tokens: number; cache_tokens: number; reasoning_tokens: number; session_count: number; my_commits: number; all_commits: number; attributed_commits: number; active_days: number; current_streak: number; longest_streak: number; quality: UsageQuality; coverage_from?: string; coverage_to?: string; refreshed_at?: string }
export interface HeatmapPoint { date: string; tokens: number; my_commits: number; all_commits: number; attributed_commits: number; sessions: number; quality: UsageQuality }
export interface AgentUsageBreakdown { agent: AgentKind; total_tokens: number; input_tokens: number; output_tokens: number; cache_tokens: number; reasoning_tokens: number; session_count: number; quality: UsageQuality }
export interface ModelUsageBreakdown { model: string; total_tokens: number; session_count: number }
export interface WorkspaceUsageBreakdown { workspace_id?: string; name: string; total_tokens: number; session_count: number }
export interface RepositoryCommitBreakdown { repository_group_id: string; name: string; my_commits: number; all_commits: number; attributed_commits: number }
export interface Achievement { code: string; category: string; title: string; description: string; threshold: number; progress: number; unlocked_at?: string }
export interface ProviderStatus { agent: AgentKind; available: boolean; quality: UsageQuality; coverage_from?: string; coverage_to?: string; imported_events: number; error?: string }
export interface InsightsStatus { providers: ProviderStatus[]; refreshed_at?: string; running: boolean }
export interface GitIdentitySummary { id: string; label: string; source: string; enabled: boolean }
