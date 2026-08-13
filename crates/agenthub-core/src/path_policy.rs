use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

pub fn canonical_project(path: &Path) -> Result<PathBuf> {
    let canonical = path
        .canonicalize()
        .with_context(|| format!("项目目录不存在：{}", path.display()))?;
    if !canonical.is_dir() {
        bail!("项目路径不是目录：{}", canonical.display());
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
        let parent = target.parent().context("目标文件缺少父目录")?;
        let existing = nearest_existing(parent).context("目标文件没有可解析的父目录")?;
        let canonical_parent = existing.canonicalize()?;
        canonical_parent
            .join(parent.strip_prefix(&existing).unwrap_or(Path::new("")))
            .join(target.file_name().context("目标文件名无效")?)
    };
    if candidate.starts_with(&project) {
        return Ok(());
    }
    if approved_home_files.iter().any(|path| path == &candidate) {
        return Ok(());
    }
    bail!("拒绝写入项目外路径：{}", candidate.display())
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
