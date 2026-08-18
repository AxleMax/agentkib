#[cfg(unix)]
use std::collections::HashSet;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::Metadata;
use std::path::{Path, PathBuf};

use agentkib_platform::path as platform_path;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use walkdir::{DirEntry, WalkDir};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StorageMeasurement {
    AllocatedExact,
    LogicalEstimate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StorageQuality {
    Complete,
    Partial,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StorageBreakdownKind {
    Directory,
    RootFiles,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StorageNodeKind {
    Workspace,
    Directory,
    RootFiles,
    Aggregate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageNode {
    pub id: String,
    pub name: String,
    pub relative_path: PathBuf,
    pub kind: StorageNodeKind,
    pub allocated_bytes: u64,
    pub logical_bytes: u64,
    pub regenerable_bytes: u64,
    pub agent_asset_bytes: u64,
    pub file_count: u64,
    pub directory_count: u64,
    pub child_count: u64,
    pub children: Vec<StorageNode>,
    pub expandable: bool,
    pub partial: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageBreakdown {
    pub name: String,
    pub relative_path: PathBuf,
    pub kind: StorageBreakdownKind,
    pub allocated_bytes: u64,
    pub logical_bytes: u64,
    pub regenerable_bytes: u64,
    pub agent_asset_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceStorage {
    pub workspace_id: String,
    pub name: String,
    pub path: PathBuf,
    #[serde(default)]
    pub snapshot_version: u32,
    #[serde(default)]
    pub root: Option<StorageNode>,
    pub measurement: StorageMeasurement,
    pub quality: StorageQuality,
    pub allocated_bytes: u64,
    pub logical_bytes: u64,
    pub regenerable_bytes: u64,
    pub agent_asset_bytes: u64,
    pub file_count: u64,
    pub directory_count: u64,
    pub breakdown: Vec<StorageBreakdown>,
    pub last_attempt_at: DateTime<Utc>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub error_key: Option<String>,
    pub error_detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageOverview {
    pub total_workspace_count: u64,
    pub scanned_workspace_count: u64,
    pub allocated_bytes: u64,
    pub logical_bytes: u64,
    pub regenerable_bytes: u64,
    pub agent_asset_bytes: u64,
    pub last_scanned_at: Option<DateTime<Utc>>,
    pub workspaces: Vec<WorkspaceStorage>,
}

impl StorageOverview {
    pub fn from_workspaces(
        total_workspace_count: usize,
        workspaces: Vec<WorkspaceStorage>,
    ) -> Self {
        let successful = workspaces
            .iter()
            .filter(|value| value.last_success_at.is_some())
            .collect::<Vec<_>>();
        Self {
            total_workspace_count: total_workspace_count as u64,
            scanned_workspace_count: successful.len() as u64,
            allocated_bytes: successful.iter().map(|value| value.allocated_bytes).sum(),
            logical_bytes: successful.iter().map(|value| value.logical_bytes).sum(),
            regenerable_bytes: successful.iter().map(|value| value.regenerable_bytes).sum(),
            agent_asset_bytes: successful.iter().map(|value| value.agent_asset_bytes).sum(),
            last_scanned_at: successful
                .iter()
                .filter_map(|value| value.last_success_at)
                .max(),
            workspaces,
        }
    }
}

#[derive(Debug, Clone)]
pub struct StorageWorkspace {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug)]
pub struct WorkspaceScanResult {
    pub storage: WorkspaceStorage,
    pub cancelled: bool,
}

#[derive(Debug)]
pub struct StorageNodeScanResult {
    pub node: StorageNode,
    pub cancelled: bool,
}

#[derive(Default)]
pub struct HardLinkSet {
    #[cfg(unix)]
    entries: HashSet<(u64, u64)>,
}

#[derive(Clone, Default)]
struct Totals {
    allocated: u64,
    logical: u64,
    regenerable: u64,
    agent_asset: u64,
    file_count: u64,
    directory_count: u64,
}

impl Totals {
    fn merge(&mut self, other: &Self) {
        self.allocated = self.allocated.saturating_add(other.allocated);
        self.logical = self.logical.saturating_add(other.logical);
        self.regenerable = self.regenerable.saturating_add(other.regenerable);
        self.agent_asset = self.agent_asset.saturating_add(other.agent_asset);
        self.file_count = self.file_count.saturating_add(other.file_count);
        self.directory_count = self.directory_count.saturating_add(other.directory_count);
    }
}

#[derive(Default)]
struct DirectoryTotals {
    totals: Totals,
    direct_files: Totals,
    children: BTreeSet<PathBuf>,
}

const STORAGE_SNAPSHOT_VERSION: u32 = 2;
const SNAPSHOT_DEPTH: usize = 4;
const SNAPSHOT_NODE_BUDGET: usize = 10_000;
const MAX_VISIBLE_CHILDREN: usize = 200;
pub const INTERACTIVE_ENTRY_LIMIT: usize = 100_000;

pub fn scan_workspace(
    workspace: &StorageWorkspace,
    excluded_roots: &[PathBuf],
    hard_links: &mut HardLinkSet,
    cancelled: impl Fn() -> bool,
) -> WorkspaceScanResult {
    let attempted_at = Utc::now();
    let tree = scan_tree(
        &workspace.path,
        &workspace.path,
        excluded_roots,
        hard_links,
        usize::MAX,
        cancelled,
    );
    let totals = tree
        .directories
        .get(Path::new(""))
        .map(|value| value.totals.clone())
        .unwrap_or_default();
    let unavailable = !tree.cancelled
        && !tree.errors.is_empty()
        && totals.file_count == 0
        && totals.directory_count == 0;
    let quality = if unavailable {
        StorageQuality::Unavailable
    } else if tree.cancelled || tree.limit_reached || !tree.errors.is_empty() {
        StorageQuality::Partial
    } else {
        StorageQuality::Complete
    };
    let error_key = if tree.cancelled {
        Some("storage.scanStopped".to_string())
    } else if unavailable {
        Some("storage.scanUnavailable".to_string())
    } else if tree.errors.is_empty() {
        None
    } else {
        Some("storage.scanPartial".to_string())
    };
    let error_detail = (!tree.errors.is_empty()).then(|| {
        let remaining = tree.errors.len().saturating_sub(3);
        let mut detail = tree
            .errors
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        if remaining > 0 {
            detail.push_str(&format!("\n+{remaining} more"));
        }
        detail
    });
    let success_at = (!tree.cancelled && !unavailable).then_some(Utc::now());
    let breakdown = legacy_breakdown(&tree.directories, Path::new(""));
    let mut budget = 1;
    let root = (!unavailable).then(|| {
        build_directory_node(
            Path::new(""),
            workspace.name.clone(),
            StorageNodeKind::Workspace,
            &tree.directories,
            0,
            SNAPSHOT_DEPTH,
            &mut budget,
            SNAPSHOT_NODE_BUDGET,
            quality == StorageQuality::Partial,
        )
    });

    WorkspaceScanResult {
        storage: WorkspaceStorage {
            workspace_id: workspace.id.clone(),
            name: workspace.name.clone(),
            path: workspace.path.clone(),
            snapshot_version: STORAGE_SNAPSHOT_VERSION,
            root,
            measurement: measurement(),
            quality,
            allocated_bytes: totals.allocated,
            logical_bytes: totals.logical,
            regenerable_bytes: totals.regenerable,
            agent_asset_bytes: totals.agent_asset,
            file_count: totals.file_count,
            directory_count: totals.directory_count,
            breakdown,
            last_attempt_at: attempted_at,
            last_success_at: success_at,
            error_key,
            error_detail,
        },
        cancelled: tree.cancelled,
    }
}

pub fn scan_workspace_children(
    workspace: &StorageWorkspace,
    relative_path: &Path,
    excluded_roots: &[PathBuf],
    hard_links: &mut HardLinkSet,
    cancelled: impl Fn() -> bool,
) -> StorageNodeScanResult {
    let target = workspace.path.join(relative_path);
    let tree = scan_tree(
        &workspace.path,
        &target,
        excluded_roots,
        hard_links,
        INTERACTIVE_ENTRY_LIMIT,
        cancelled,
    );
    let name = relative_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| workspace.name.clone());
    let mut budget = 1;
    let node = build_directory_node(
        relative_path,
        name,
        if relative_path.as_os_str().is_empty() {
            StorageNodeKind::Workspace
        } else {
            StorageNodeKind::Directory
        },
        &tree.directories,
        0,
        1,
        &mut budget,
        SNAPSHOT_NODE_BUDGET,
        tree.cancelled || tree.limit_reached || !tree.errors.is_empty(),
    );
    StorageNodeScanResult {
        node,
        cancelled: tree.cancelled,
    }
}

struct TreeScan {
    directories: BTreeMap<PathBuf, DirectoryTotals>,
    errors: Vec<String>,
    cancelled: bool,
    limit_reached: bool,
}

fn scan_tree(
    workspace_root: &Path,
    target_root: &Path,
    excluded_roots: &[PathBuf],
    hard_links: &mut HardLinkSet,
    max_entries: usize,
    cancelled: impl Fn() -> bool,
) -> TreeScan {
    let base_relative = target_root
        .strip_prefix(workspace_root)
        .unwrap_or_else(|_| Path::new(""));
    let mut directories = BTreeMap::new();
    directories.insert(base_relative.to_path_buf(), DirectoryTotals::default());
    let mut errors = Vec::new();
    let mut was_cancelled = false;
    let mut limit_reached = false;
    let mut visited = 0_usize;
    let walker = WalkDir::new(target_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| should_visit(entry, target_root, excluded_roots));

    for entry in walker {
        if cancelled() {
            was_cancelled = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                errors.push(error.to_string());
                continue;
            }
        };
        if entry.path() == target_root {
            continue;
        }
        if visited >= max_entries {
            limit_reached = true;
            break;
        }
        visited += 1;
        let metadata = match entry.path().symlink_metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                errors.push(format!("{}: {error}", entry.path().display()));
                continue;
            }
        };
        if metadata.is_file() && !hard_links.insert(&metadata) {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(workspace_root)
            .unwrap_or_else(|_| entry.path());
        let logical = if metadata.is_file() || metadata.file_type().is_symlink() {
            metadata.len()
        } else {
            0
        };
        let allocated = allocated_size(&metadata);
        let entry_totals = Totals {
            allocated,
            logical,
            regenerable: if is_regenerable(relative) {
                allocated
            } else {
                0
            },
            agent_asset: if is_agent_asset(relative) {
                allocated
            } else {
                0
            },
            file_count: u64::from(metadata.is_file()),
            directory_count: 0,
        };

        if metadata.is_dir() {
            directories.entry(relative.to_path_buf()).or_default();
            if let Some(parent) = relative.parent() {
                directories
                    .entry(parent.to_path_buf())
                    .or_default()
                    .children
                    .insert(relative.to_path_buf());
            }
            for ancestor in ancestors_between(base_relative, relative) {
                let value = directories.entry(ancestor.clone()).or_default();
                value.totals.merge(&entry_totals);
                if ancestor != relative {
                    value.totals.directory_count = value.totals.directory_count.saturating_add(1);
                }
            }
        } else {
            let parent = relative.parent().unwrap_or(base_relative);
            for ancestor in ancestors_between(base_relative, parent) {
                directories
                    .entry(ancestor)
                    .or_default()
                    .totals
                    .merge(&entry_totals);
            }
            let direct = &mut directories
                .entry(parent.to_path_buf())
                .or_default()
                .direct_files;
            direct.merge(&entry_totals);
        }
    }

    TreeScan {
        directories,
        errors,
        cancelled: was_cancelled,
        limit_reached,
    }
}

fn ancestors_between(base: &Path, value: &Path) -> Vec<PathBuf> {
    let mut output = vec![base.to_path_buf()];
    let mut current = base.to_path_buf();
    if let Ok(suffix) = value.strip_prefix(base) {
        for component in suffix.components() {
            current.push(component.as_os_str());
            output.push(current.clone());
        }
    }
    output
}

#[derive(Clone)]
struct NodeCandidate {
    name: String,
    relative_path: PathBuf,
    kind: StorageNodeKind,
    totals: Totals,
}

#[allow(clippy::too_many_arguments)]
fn build_directory_node(
    relative_path: &Path,
    name: String,
    kind: StorageNodeKind,
    directories: &BTreeMap<PathBuf, DirectoryTotals>,
    depth: usize,
    max_depth: usize,
    budget: &mut usize,
    max_nodes: usize,
    partial: bool,
) -> StorageNode {
    let current = directories.get(relative_path);
    let totals = current
        .map(|value| value.totals.clone())
        .unwrap_or_default();
    let mut candidates = current
        .map(|value| {
            value
                .children
                .iter()
                .map(|path| {
                    let totals = directories
                        .get(path)
                        .map(|child| child.totals.clone())
                        .unwrap_or_default();
                    NodeCandidate {
                        name: path
                            .file_name()
                            .map(|value| value.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        relative_path: path.clone(),
                        kind: StorageNodeKind::Directory,
                        totals,
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(files) = current.map(|value| value.direct_files.clone())
        && (files.allocated > 0 || files.file_count > 0)
    {
        candidates.push(NodeCandidate {
            name: "__root_files__".to_string(),
            relative_path: relative_path.to_path_buf(),
            kind: StorageNodeKind::RootFiles,
            totals: files,
        });
    }
    candidates.sort_by(|left, right| {
        right
            .totals
            .allocated
            .cmp(&left.totals.allocated)
            .then_with(|| left.name.cmp(&right.name))
    });
    let child_count = candidates.len() as u64;
    let mut children = Vec::new();
    let mut omitted = Vec::new();
    let visible_limit = if max_depth == 1 {
        max_nodes.saturating_sub(1)
    } else {
        MAX_VISIBLE_CHILDREN.saturating_sub(1)
    };
    if depth < max_depth {
        for candidate in candidates {
            let reserve_aggregate = usize::from(!omitted.is_empty());
            if children.len() >= visible_limit
                || budget.saturating_add(reserve_aggregate) >= max_nodes
            {
                omitted.push(candidate);
                continue;
            }
            *budget = budget.saturating_add(1);
            let child = if candidate.kind == StorageNodeKind::Directory {
                build_directory_node(
                    &candidate.relative_path,
                    candidate.name,
                    candidate.kind,
                    directories,
                    depth + 1,
                    max_depth,
                    budget,
                    max_nodes,
                    partial,
                )
            } else {
                leaf_node(candidate, partial)
            };
            children.push(child);
        }
    }
    if !omitted.is_empty() && *budget < max_nodes {
        let omitted_count = omitted.len() as u64;
        let mut omitted_totals = Totals::default();
        for candidate in &omitted {
            omitted_totals.merge(&candidate.totals);
        }
        *budget = budget.saturating_add(1);
        children.push(StorageNode {
            id: node_id(StorageNodeKind::Aggregate, relative_path),
            name: "__other__".to_string(),
            relative_path: relative_path.to_path_buf(),
            kind: StorageNodeKind::Aggregate,
            allocated_bytes: omitted_totals.allocated,
            logical_bytes: omitted_totals.logical,
            regenerable_bytes: omitted_totals.regenerable,
            agent_asset_bytes: omitted_totals.agent_asset,
            file_count: omitted_totals.file_count,
            directory_count: omitted_totals.directory_count,
            child_count: omitted_count,
            children: Vec::new(),
            expandable: true,
            partial,
        });
    } else if !omitted.is_empty()
        && let Some(last) = children.pop()
    {
        let removed_nodes = count_nodes(&last);
        *budget = budget.saturating_sub(removed_nodes);
        let omitted_count = omitted.len() as u64 + 1;
        let mut omitted_totals = Totals {
            allocated: last.allocated_bytes,
            logical: last.logical_bytes,
            regenerable: last.regenerable_bytes,
            agent_asset: last.agent_asset_bytes,
            file_count: last.file_count,
            directory_count: last.directory_count,
        };
        for candidate in &omitted {
            omitted_totals.merge(&candidate.totals);
        }
        *budget = budget.saturating_add(1);
        children.push(StorageNode {
            id: node_id(StorageNodeKind::Aggregate, relative_path),
            name: "__other__".to_string(),
            relative_path: relative_path.to_path_buf(),
            kind: StorageNodeKind::Aggregate,
            allocated_bytes: omitted_totals.allocated,
            logical_bytes: omitted_totals.logical,
            regenerable_bytes: omitted_totals.regenerable,
            agent_asset_bytes: omitted_totals.agent_asset,
            file_count: omitted_totals.file_count,
            directory_count: omitted_totals.directory_count,
            child_count: omitted_count,
            children: Vec::new(),
            expandable: true,
            partial,
        });
    }
    StorageNode {
        id: node_id(kind, relative_path),
        name,
        relative_path: relative_path.to_path_buf(),
        kind,
        allocated_bytes: totals.allocated,
        logical_bytes: totals.logical,
        regenerable_bytes: totals.regenerable,
        agent_asset_bytes: totals.agent_asset,
        file_count: totals.file_count,
        directory_count: totals.directory_count,
        child_count,
        expandable: child_count > 0,
        children,
        partial,
    }
}

fn count_nodes(node: &StorageNode) -> usize {
    1 + node.children.iter().map(count_nodes).sum::<usize>()
}

fn leaf_node(candidate: NodeCandidate, partial: bool) -> StorageNode {
    StorageNode {
        id: node_id(candidate.kind, &candidate.relative_path),
        name: candidate.name,
        relative_path: candidate.relative_path,
        kind: candidate.kind,
        allocated_bytes: candidate.totals.allocated,
        logical_bytes: candidate.totals.logical,
        regenerable_bytes: candidate.totals.regenerable,
        agent_asset_bytes: candidate.totals.agent_asset,
        file_count: candidate.totals.file_count,
        directory_count: candidate.totals.directory_count,
        child_count: 0,
        children: Vec::new(),
        expandable: false,
        partial,
    }
}

fn node_id(kind: StorageNodeKind, relative_path: &Path) -> String {
    let prefix = match kind {
        StorageNodeKind::Workspace => "workspace",
        StorageNodeKind::Directory => "directory",
        StorageNodeKind::RootFiles => "root-files",
        StorageNodeKind::Aggregate => "aggregate",
    };
    format!("{prefix}:{}", relative_path.to_string_lossy())
}

fn legacy_breakdown(
    directories: &BTreeMap<PathBuf, DirectoryTotals>,
    root: &Path,
) -> Vec<StorageBreakdown> {
    let Some(value) = directories.get(root) else {
        return Vec::new();
    };
    let mut output = value
        .children
        .iter()
        .filter_map(|path| directories.get(path).map(|child| (path, &child.totals)))
        .map(|(path, totals)| StorageBreakdown {
            name: path
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default(),
            relative_path: path.clone(),
            kind: StorageBreakdownKind::Directory,
            allocated_bytes: totals.allocated,
            logical_bytes: totals.logical,
            regenerable_bytes: totals.regenerable,
            agent_asset_bytes: totals.agent_asset,
        })
        .collect::<Vec<_>>();
    if value.direct_files.allocated > 0 || value.direct_files.file_count > 0 {
        output.push(StorageBreakdown {
            name: "__root_files__".to_string(),
            relative_path: root.to_path_buf(),
            kind: StorageBreakdownKind::RootFiles,
            allocated_bytes: value.direct_files.allocated,
            logical_bytes: value.direct_files.logical,
            regenerable_bytes: value.direct_files.regenerable,
            agent_asset_bytes: value.direct_files.agent_asset,
        });
    }
    output
}

fn should_visit(entry: &DirEntry, root: &Path, excluded_roots: &[PathBuf]) -> bool {
    entry.path() == root
        || (platform_path::is_safe_scan_entry(entry.path())
            && !excluded_roots
                .iter()
                .any(|path| platform_path::equivalent(entry.path(), path)))
}

fn is_regenerable(relative: &Path) -> bool {
    const NAMES: &[&str] = &[
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        ".nuxt",
        ".turbo",
        ".cache",
        "coverage",
        ".gradle",
        ".dart_tool",
        ".venv",
        "__pycache__",
    ];
    relative.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|name| NAMES.contains(&name))
    })
}

fn is_agent_asset(relative: &Path) -> bool {
    relative.components().any(|component| {
        let name = component.as_os_str();
        [
            ".agentkib",
            ".agents",
            ".codex",
            ".claude",
            ".cursor",
            "AGENTS.md",
            "CLAUDE.md",
            ".mcp.json",
        ]
        .iter()
        .any(|candidate| name == *candidate)
    })
}

impl HardLinkSet {
    fn insert(&mut self, metadata: &Metadata) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() > 1 {
                return self.entries.insert((metadata.dev(), metadata.ino()));
            }
        }
        #[cfg(not(unix))]
        let _ = metadata;
        true
    }
}

#[cfg(unix)]
fn allocated_size(metadata: &Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    metadata.blocks().saturating_mul(512)
}

#[cfg(not(unix))]
fn allocated_size(metadata: &Metadata) -> u64 {
    metadata.len()
}

#[cfg(unix)]
fn measurement() -> StorageMeasurement {
    StorageMeasurement::AllocatedExact
}

#[cfg(not(unix))]
fn measurement() -> StorageMeasurement {
    StorageMeasurement::LogicalEstimate
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn workspace(path: &Path) -> StorageWorkspace {
        StorageWorkspace {
            id: "workspace".into(),
            name: "Workspace".into(),
            path: path.to_path_buf(),
        }
    }

    #[test]
    fn classifies_regenerable_and_agent_assets() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir_all(directory.path().join("node_modules/pkg")).unwrap();
        fs::create_dir_all(directory.path().join(".agentkib")).unwrap();
        fs::write(
            directory.path().join("node_modules/pkg/index.js"),
            vec![1; 1024],
        )
        .unwrap();
        fs::write(
            directory.path().join(".agentkib/manifest.yaml"),
            vec![1; 128],
        )
        .unwrap();

        let result = scan_workspace(
            &workspace(directory.path()),
            &[],
            &mut HardLinkSet::default(),
            || false,
        );

        assert!(result.storage.regenerable_bytes > 0);
        assert!(result.storage.agent_asset_bytes > 0);
        assert_eq!(result.storage.quality, StorageQuality::Complete);
        assert_eq!(result.storage.file_count, 2);
    }

    #[test]
    fn snapshot_preserves_recursive_directory_structure() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir_all(directory.path().join("target/debug/deps")).unwrap();
        fs::write(
            directory.path().join("target/debug/deps/library.rlib"),
            vec![1; 1024],
        )
        .unwrap();

        let result = scan_workspace(
            &workspace(directory.path()),
            &[],
            &mut HardLinkSet::default(),
            || false,
        );
        let root = result.storage.root.expect("recursive root");
        let target = root
            .children
            .iter()
            .find(|node| node.name == "target")
            .expect("target node");
        let debug = target
            .children
            .iter()
            .find(|node| node.name == "debug")
            .expect("debug node");

        assert_eq!(result.storage.snapshot_version, STORAGE_SNAPSHOT_VERSION);
        assert_eq!(target.regenerable_bytes, result.storage.regenerable_bytes);
        assert!(debug.children.iter().any(|node| node.name == "deps"));
    }

    #[test]
    fn interactive_scan_returns_direct_children_for_a_subtree() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir_all(directory.path().join("src/features/profile")).unwrap();
        fs::create_dir_all(directory.path().join("src/features/settings")).unwrap();
        fs::write(
            directory.path().join("src/features/profile/view.ts"),
            vec![1; 256],
        )
        .unwrap();

        let result = scan_workspace_children(
            &workspace(directory.path()),
            Path::new("src/features"),
            &[],
            &mut HardLinkSet::default(),
            || false,
        );

        assert_eq!(result.node.relative_path, Path::new("src/features"));
        assert!(
            result
                .node
                .children
                .iter()
                .any(|node| node.name == "profile")
        );
        assert!(
            result
                .node
                .children
                .iter()
                .any(|node| node.name == "settings")
        );
    }

    #[test]
    fn snapshot_budget_keeps_an_expandable_aggregate() {
        let directory = tempfile::tempdir().unwrap();
        for index in 0..(MAX_VISIBLE_CHILDREN + 5) {
            let child = directory.path().join(format!("child-{index:03}"));
            fs::create_dir(&child).unwrap();
            fs::write(child.join("file.bin"), vec![1; 32]).unwrap();
        }

        let result = scan_workspace(
            &workspace(directory.path()),
            &[],
            &mut HardLinkSet::default(),
            || false,
        );
        let root = result.storage.root.expect("recursive root");
        let aggregate = root
            .children
            .iter()
            .find(|node| node.kind == StorageNodeKind::Aggregate)
            .expect("aggregate node");

        assert!(aggregate.expandable);
        assert!(aggregate.child_count > 0);
        assert!(root.children.len() <= MAX_VISIBLE_CHILDREN);
    }

    #[test]
    fn entry_limit_marks_lazy_scan_as_partial() {
        let directory = tempfile::tempdir().unwrap();
        fs::create_dir_all(directory.path().join("one/two")).unwrap();
        fs::write(directory.path().join("one/two/file.bin"), vec![1; 16]).unwrap();
        let tree = scan_tree(
            directory.path(),
            directory.path(),
            &[],
            &mut HardLinkSet::default(),
            1,
            || false,
        );

        assert!(tree.limit_reached);
    }

    #[test]
    fn excludes_nested_workspace_roots() {
        let directory = tempfile::tempdir().unwrap();
        let nested = directory.path().join("nested");
        fs::create_dir(&nested).unwrap();
        fs::write(directory.path().join("root.txt"), vec![1; 100]).unwrap();
        fs::write(nested.join("nested.txt"), vec![1; 100]).unwrap();

        let result = scan_workspace(
            &workspace(directory.path()),
            &[nested],
            &mut HardLinkSet::default(),
            || false,
        );

        assert_eq!(result.storage.file_count, 1);
        assert!(result.storage.breakdown.iter().any(|item| {
            item.kind == StorageBreakdownKind::RootFiles && item.name == "__root_files__"
        }));
    }

    #[cfg(unix)]
    #[test]
    fn hard_links_are_counted_once_across_scans() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        fs::write(first.path().join("data.bin"), vec![7; 4096]).unwrap();
        fs::hard_link(
            first.path().join("data.bin"),
            second.path().join("data.bin"),
        )
        .unwrap();
        let mut links = HardLinkSet::default();

        let one = scan_workspace(&workspace(first.path()), &[], &mut links, || false);
        let two = scan_workspace(&workspace(second.path()), &[], &mut links, || false);

        assert!(one.storage.allocated_bytes > 0);
        assert_eq!(two.storage.file_count, 0);
    }

    #[test]
    fn cancellation_returns_partial_results() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("data.bin"), vec![1; 64]).unwrap();

        let result = scan_workspace(
            &workspace(directory.path()),
            &[],
            &mut HardLinkSet::default(),
            || true,
        );

        assert!(result.cancelled);
        assert_eq!(result.storage.quality, StorageQuality::Partial);
        assert!(result.storage.last_success_at.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_do_not_include_their_targets() {
        use std::os::unix::fs::symlink;

        let workspace_dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("large.bin"), vec![9; 4096]).unwrap();
        symlink(outside.path(), workspace_dir.path().join("outside")).unwrap();

        let result = scan_workspace(
            &workspace(workspace_dir.path()),
            &[],
            &mut HardLinkSet::default(),
            || false,
        );

        assert_eq!(result.storage.file_count, 0);
        assert!(result.storage.logical_bytes < 4096);
    }

    #[test]
    fn missing_workspace_is_unavailable() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing");
        let result = scan_workspace(
            &workspace(&missing),
            &[],
            &mut HardLinkSet::default(),
            || false,
        );

        assert_eq!(result.storage.quality, StorageQuality::Unavailable);
        assert!(result.storage.last_success_at.is_none());
    }
}
