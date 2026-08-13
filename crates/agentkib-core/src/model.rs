use std::collections::BTreeMap;
use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentKind {
    Codex,
    ClaudeCode,
    OpenClaw,
    Hermes,
}

impl AgentKind {
    pub const ALL: [Self; 4] = [Self::Codex, Self::ClaudeCode, Self::OpenClaw, Self::Hermes];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeCode => "claude-code",
            Self::OpenClaw => "openclaw",
            Self::Hermes => "hermes",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceIdentity {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InstructionSet {
    #[serde(default)]
    pub shared: String,
    #[serde(default)]
    pub scoped: Vec<ScopedInstruction>,
    #[serde(default)]
    pub platform_overrides: BTreeMap<AgentKind, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopedInstruction {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDefinition {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub targets: Vec<AgentKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "transport", rename_all = "kebab-case")]
pub enum ConnectionTransport {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
    },
    Http {
        url: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionDefinition {
    pub name: String,
    #[serde(flatten)]
    pub transport: ConnectionTransport,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub allow_tools: Vec<String>,
    #[serde(default)]
    pub targets: Vec<AgentKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryPolicy {
    #[serde(default = "default_true")]
    pub require_approval: bool,
}

impl Default for MemoryPolicy {
    fn default() -> Self {
        Self {
            require_approval: true,
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AdapterState {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub generated_hashes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub workspace: WorkspaceIdentity,
    #[serde(default)]
    pub instructions: InstructionSet,
    #[serde(default)]
    pub skills: Vec<SkillDefinition>,
    #[serde(default)]
    pub connections: Vec<ConnectionDefinition>,
    #[serde(default)]
    pub memories: MemoryPolicy,
    #[serde(default)]
    pub adapters: BTreeMap<AgentKind, AdapterState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AssetKind {
    Instruction,
    Skill,
    Connection,
    Agent,
    Hook,
    Memory,
    Configuration,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetRecord {
    pub agent: AgentKind,
    pub kind: AssetKind,
    pub path: PathBuf,
    pub exists: bool,
    pub size: u64,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDetection {
    pub agent: AgentKind,
    pub detected: bool,
    pub asset_count: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceScan {
    pub root: PathBuf,
    pub manifest_exists: bool,
    pub agents: Vec<AgentDetection>,
    pub assets: Vec<AssetRecord>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceValidation {
    pub valid: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceStatus {
    NeedsImport,
    Healthy,
    Attention,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiscoveryEvidence {
    SessionCwd,
    ConfiguredWorkspace,
    ScanMarker,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryCandidate {
    pub path: PathBuf,
    pub source_agent: Option<AgentKind>,
    pub evidence: DiscoveryEvidence,
    pub last_active_at: Option<DateTime<Utc>>,
    pub session_count: u64,
    pub explicit_workspace: bool,
    pub repository_group_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSource {
    pub agent: Option<AgentKind>,
    pub evidence: DiscoveryEvidence,
    pub session_count: u64,
    pub last_active_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
    pub repository_group_id: Option<String>,
    pub manifest_workspace_id: Option<String>,
    pub status: WorkspaceStatus,
    pub asset_count: u64,
    pub warning_count: u64,
    pub last_active_at: Option<DateTime<Utc>>,
    pub last_scanned_at: Option<DateTime<Utc>>,
    pub sources: Vec<WorkspaceSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepositoryGroup {
    pub id: String,
    pub workspaces: Vec<WorkspaceSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInstallation {
    pub agent: AgentKind,
    pub installed: bool,
    pub configured: bool,
    pub version: Option<String>,
    pub home: Option<PathBuf>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogScope {
    Workspace,
    AgentHome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogAsset {
    pub id: String,
    pub scope: CatalogScope,
    pub workspace_id: Option<String>,
    pub agent: Option<AgentKind>,
    pub kind: AssetKind,
    pub name: String,
    pub path: PathBuf,
    pub summary: String,
    pub size: u64,
    pub modified_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryReport {
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
    pub discovered_count: usize,
    pub removed_count: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanRoot {
    pub id: String,
    pub path: PathBuf,
    pub enabled: bool,
    pub max_depth: usize,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExcludedWorkspace {
    pub path: PathBuf,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityRecord {
    pub id: String,
    pub project_id: Option<String>,
    pub action: String,
    pub detail: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextSection {
    pub source: PathBuf,
    pub scope: String,
    pub content: String,
    pub precedence: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextPreview {
    pub agent: AgentKind,
    pub project: PathBuf,
    pub cwd: PathBuf,
    pub sections: Vec<ContextSection>,
    pub visible_skills: Vec<String>,
    pub visible_connections: Vec<String>,
    pub approved_memories: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeScope {
    Project,
    AgentHome,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChange {
    pub target: PathBuf,
    pub scope: ChangeScope,
    pub original_hash: Option<String>,
    pub before: String,
    pub after: String,
    pub risk: RiskLevel,
    pub validator: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeSet {
    pub id: String,
    pub project_root: PathBuf,
    pub created_at: DateTime<Utc>,
    pub changes: Vec<FileChange>,
    pub requires_home_approval: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyReport {
    pub changeset_id: String,
    pub applied: Vec<PathBuf>,
    pub backup_dir: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryType {
    UserPreference,
    ProjectFact,
    Decision,
    Constraint,
    FailedAttempt,
    OpenLoop,
    TaskState,
    AgentObservation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryStatus {
    Pending,
    Approved,
    Rejected,
    Invalidated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub id: String,
    pub project_id: String,
    pub memory_type: MemoryType,
    pub content: String,
    pub status: MemoryStatus,
    pub source_agent: Option<String>,
    pub source_thread: Option<String>,
    pub source_reference: Option<String>,
    pub created_at: DateTime<Utc>,
    pub approved_at: Option<DateTime<Utc>>,
    pub invalidated_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryProposal {
    pub project_id: String,
    pub memory_type: MemoryType,
    pub content: String,
    pub source_agent: Option<String>,
    pub source_thread: Option<String>,
    pub source_reference: Option<String>,
}
