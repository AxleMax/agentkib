use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

pub fn canonical_project(path: &Path) -> Result<PathBuf> {
    let canonical = path
        .canonicalize()
        .with_context(|| format!("Project directory does not exist: {}", path.display()))?;
    if !canonical.is_dir() {
        bail!("Project path is not a directory: {}", canonical.display());
    }
    Ok(canonical)
}

pub fn ensure_allowed_target(
    project: &Path,
    target: &Path,
    approved_home_files: &[PathBuf],
) -> Result<()> {
    let project = canonical_project(project)?;
    let candidate = if target.exists() {
        target.canonicalize()?
    } else {
        let parent = target
            .parent()
            .context("Target file has no parent directory")?;
        let existing = nearest_existing(parent).context("Target parent cannot be resolved")?;
        let canonical_parent = existing.canonicalize()?;
        canonical_parent
            .join(parent.strip_prefix(&existing).unwrap_or(Path::new("")))
            .join(target.file_name().context("Target filename is invalid")?)
    };
    if candidate.starts_with(&project) {
        return Ok(());
    }
    if approved_home_files.iter().any(|path| path == &candidate) {
        return Ok(());
    }
    bail!(
        "Refusing to write outside the project: {}",
        candidate.display()
    )
}

fn nearest_existing(path: &Path) -> Option<PathBuf> {
    let mut current = path;
    loop {
        if current.exists() {
            return Some(current.to_path_buf());
        }
        current = current.parent()?;
    }
}
