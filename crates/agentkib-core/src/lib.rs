mod changeset;
mod context;
mod doctor;
mod manifest;
mod model;
mod path_policy;
mod scanner;

pub use changeset::{ApplyOptions, apply_changeset, hash_content};
pub use context::resolve_context;
pub use doctor::diagnose_workspace;
pub use manifest::{load_manifest, manifest_path, validate_manifest};
pub use model::*;
pub use path_policy::{canonical_project, ensure_allowed_target};
pub use scanner::scan_workspace;

pub fn validate_workspace(project: &std::path::Path) -> anyhow::Result<WorkspaceValidation> {
    let scan = scan_workspace(project)?;
    Ok(WorkspaceValidation {
        valid: scan.warnings.is_empty(),
        warnings: scan.warnings,
    })
}
