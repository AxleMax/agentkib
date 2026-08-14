use std::collections::BTreeMap;
#[cfg(unix)]
use std::collections::HashSet;
use std::fs::Metadata;
use std::path::{Component, Path, PathBuf};

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

#[derive(Default)]
pub struct HardLinkSet {
    #[cfg(unix)]
    entries: HashSet<(u64, u64)>,
}

#[derive(Default)]
struct Totals {
    allocated: u64,
    logical: u64,
    regenerable: u64,
    agent_asset: u64,
}

pub fn scan_workspace(
    workspace: &StorageWorkspace,
    excluded_roots: &[PathBuf],
    hard_links: &mut HardLinkSet,
    cancelled: impl Fn() -> bool,
) -> WorkspaceScanResult {
    let attempted_at = Utc::now();
    let mut totals = Totals::default();
    let mut breakdowns: BTreeMap<String, (StorageBreakdownKind, PathBuf, Totals)> = BTreeMap::new();
    let mut file_count = 0_u64;
    let mut directory_count = 0_u64;
    let mut errors = Vec::new();
    let mut was_cancelled = false;

    let walker = WalkDir::new(&workspace.path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| should_visit(entry, &workspace.path, excluded_roots));

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
        let metadata = match entry.path().symlink_metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                errors.push(format!("{}: {error}", entry.path().display()));
                continue;
            }
        };
        if entry.path() == workspace.path {
            continue;
        }
        if metadata.is_file() && !hard_links.insert(&metadata) {
            continue;
        }
        if metadata.is_file() {
            file_count = file_count.saturating_add(1);
        } else if metadata.is_dir() {
            directory_count = directory_count.saturating_add(1);
        }

        let relative = entry
            .path()
            .strip_prefix(&workspace.path)
            .unwrap_or_else(|_| entry.path());
        let logical = if metadata.is_file() || metadata.file_type().is_symlink() {
            metadata.len()
        } else {
            0
        };
        let allocated = allocated_size(&metadata);
        let regenerable = is_regenerable(relative);
        let agent_asset = is_agent_asset(relative);
        add_size(&mut totals, allocated, logical, regenerable, agent_asset);

        let (key, kind, path) = breakdown_key(relative, metadata.is_dir());
        let value = breakdowns
            .entry(key)
            .or_insert_with(|| (kind, path, Totals::default()));
        add_size(&mut value.2, allocated, logical, regenerable, agent_asset);
    }

    let unavailable =
        !was_cancelled && !errors.is_empty() && file_count == 0 && directory_count == 0;
    let quality = if unavailable {
        StorageQuality::Unavailable
    } else if was_cancelled || !errors.is_empty() {
        StorageQuality::Partial
    } else {
        StorageQuality::Complete
    };
    let error_key = if was_cancelled {
        Some("storage.scanStopped".to_string())
    } else if unavailable {
        Some("storage.scanUnavailable".to_string())
    } else if errors.is_empty() {
        None
    } else {
        Some("storage.scanPartial".to_string())
    };
    let error_detail = (!errors.is_empty()).then(|| {
        let remaining = errors.len().saturating_sub(3);
        let mut detail = errors.into_iter().take(3).collect::<Vec<_>>().join("\n");
        if remaining > 0 {
            detail.push_str(&format!("\n+{remaining} more"));
        }
        detail
    });
    let success_at = (!was_cancelled && !unavailable).then_some(Utc::now());
    let breakdown = breakdowns
        .into_iter()
        .map(|(name, (kind, relative_path, value))| StorageBreakdown {
            name,
            relative_path,
            kind,
            allocated_bytes: value.allocated,
            logical_bytes: value.logical,
            regenerable_bytes: value.regenerable,
            agent_asset_bytes: value.agent_asset,
        })
        .collect();

    WorkspaceScanResult {
        storage: WorkspaceStorage {
            workspace_id: workspace.id.clone(),
            name: workspace.name.clone(),
            path: workspace.path.clone(),
            measurement: measurement(),
            quality,
            allocated_bytes: totals.allocated,
            logical_bytes: totals.logical,
            regenerable_bytes: totals.regenerable,
            agent_asset_bytes: totals.agent_asset,
            file_count,
            directory_count,
            breakdown,
            last_attempt_at: attempted_at,
            last_success_at: success_at,
            error_key,
            error_detail,
        },
        cancelled: was_cancelled,
    }
}

fn should_visit(entry: &DirEntry, root: &Path, excluded_roots: &[PathBuf]) -> bool {
    entry.path() == root
        || (platform_path::is_safe_scan_entry(entry.path())
            && !excluded_roots
                .iter()
                .any(|path| platform_path::equivalent(entry.path(), path)))
}

fn breakdown_key(relative: &Path, is_directory: bool) -> (String, StorageBreakdownKind, PathBuf) {
    if relative.as_os_str().is_empty() || (relative.components().count() == 1 && !is_directory) {
        return (
            "__root_files__".to_string(),
            StorageBreakdownKind::RootFiles,
            PathBuf::new(),
        );
    }
    match relative.components().next() {
        Some(Component::Normal(name)) => (
            name.to_string_lossy().into_owned(),
            StorageBreakdownKind::Directory,
            PathBuf::from(name),
        ),
        _ => unreachable!("non-empty relative paths have a first component"),
    }
}

fn add_size(
    totals: &mut Totals,
    allocated: u64,
    logical: u64,
    regenerable: bool,
    agent_asset: bool,
) {
    totals.allocated = totals.allocated.saturating_add(allocated);
    totals.logical = totals.logical.saturating_add(logical);
    if regenerable {
        totals.regenerable = totals.regenerable.saturating_add(allocated);
    }
    if agent_asset {
        totals.agent_asset = totals.agent_asset.saturating_add(allocated);
    }
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
    let first = relative.components().next().map(|value| value.as_os_str());
    first.is_some_and(|name| {
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
