use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

use crate::{ApplyReport, ChangeScope, ChangeSet, ensure_allowed_target};

#[derive(Debug, Clone, Default)]
pub struct ApplyOptions {
    pub approved_home_files: Vec<PathBuf>,
    pub home_approval: bool,
}

pub fn hash_content(content: &[u8]) -> String {
    hex::encode(Sha256::digest(content))
}

pub fn apply_changeset(
    changeset: &ChangeSet,
    backup_root: &Path,
    options: &ApplyOptions,
) -> Result<ApplyReport> {
    if changeset.requires_home_approval && !options.home_approval {
        bail!("该变更包含 Agent Home 文件，需要单独授权");
    }
    for change in &changeset.changes {
        ensure_allowed_target(
            &changeset.project_root,
            &change.target,
            &options.approved_home_files,
        )?;
        if matches!(change.scope, ChangeScope::AgentHome) && !options.home_approval {
            bail!("Agent Home 写入未授权");
        }
        let current = fs::read(&change.target).unwrap_or_default();
        let current_hash = if change.target.exists() {
            Some(hash_content(&current))
        } else {
            None
        };
        if current_hash != change.original_hash {
            bail!("文件已被外部修改：{}", change.target.display());
        }
    }

    let backup_dir = backup_root.join(&changeset.id);
    fs::create_dir_all(&backup_dir)?;
    let mut prepared = Vec::new();
    for (index, change) in changeset.changes.iter().enumerate() {
        let parent = change.target.parent().context("目标缺少父目录")?;
        fs::create_dir_all(parent)?;
        if change.target.exists() {
            fs::copy(&change.target, backup_dir.join(format!("{index}.bak")))?;
        }
        let mut temp = NamedTempFile::new_in(parent)?;
        use std::io::Write;
        temp.write_all(change.after.as_bytes())?;
        temp.as_file().sync_all()?;
        prepared.push(temp);
    }

    let mut applied = Vec::new();
    for (index, (change, temp)) in changeset.changes.iter().zip(prepared).enumerate() {
        let write_result = temp
            .persist(&change.target)
            .map_err(|error| anyhow::anyhow!("写入 {} 失败：{}", change.target.display(), error))
            .and_then(|_| {
                let written = fs::read_to_string(&change.target)?;
                validate_written(&change.validator, &written)
                    .with_context(|| format!("写入后验证失败：{}", change.target.display()))
            });
        if let Err(error) = write_result {
            rollback(changeset, &backup_dir, index);
            return Err(error);
        }
        applied.push(change.target.clone());
    }
    Ok(ApplyReport {
        changeset_id: changeset.id.clone(),
        applied,
        backup_dir,
    })
}

fn rollback(changeset: &ChangeSet, backup_dir: &Path, last_index: usize) {
    for index in (0..=last_index).rev() {
        let target = &changeset.changes[index].target;
        let backup = backup_dir.join(format!("{index}.bak"));
        if backup.exists() {
            let _ = fs::copy(backup, target);
        } else {
            let _ = fs::remove_file(target);
        }
    }
}

fn validate_written(validator: &str, content: &str) -> Result<()> {
    match validator {
        "yaml" => {
            let _: serde_yaml::Value = serde_yaml::from_str(content)?;
        }
        "json" => {
            let _: serde_json::Value = serde_json::from_str(content)?;
        }
        "toml" => {
            let _: toml::Value = toml::from_str(content)?;
        }
        "markdown" | "text" => {}
        other => bail!("未知验证器：{other}"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FileChange, RiskLevel};
    use chrono::Utc;
    use tempfile::tempdir;
    use uuid::Uuid;

    #[test]
    fn rejects_hash_conflict() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("AGENTS.md");
        fs::write(&target, "new").unwrap();
        let set = ChangeSet {
            id: Uuid::new_v4().to_string(),
            project_root: dir.path().canonicalize().unwrap(),
            created_at: Utc::now(),
            requires_home_approval: false,
            changes: vec![FileChange {
                target,
                scope: ChangeScope::Project,
                original_hash: Some(hash_content(b"old")),
                before: "old".into(),
                after: "next".into(),
                risk: RiskLevel::Low,
                validator: "markdown".into(),
            }],
        };
        assert!(
            apply_changeset(&set, &dir.path().join("backup"), &ApplyOptions::default()).is_err()
        );
    }

    #[test]
    fn restores_all_files_when_post_write_validation_fails() {
        let dir = tempdir().unwrap();
        let first = dir.path().join("AGENTS.md");
        let second = dir.path().join("config.json");
        fs::write(&first, "original").unwrap();
        fs::write(&second, "{}").unwrap();
        let set = ChangeSet {
            id: Uuid::new_v4().to_string(),
            project_root: dir.path().canonicalize().unwrap(),
            created_at: Utc::now(),
            requires_home_approval: false,
            changes: vec![
                FileChange {
                    target: first.clone(),
                    scope: ChangeScope::Project,
                    original_hash: Some(hash_content(b"original")),
                    before: "original".into(),
                    after: "changed".into(),
                    risk: RiskLevel::Low,
                    validator: "markdown".into(),
                },
                FileChange {
                    target: second.clone(),
                    scope: ChangeScope::Project,
                    original_hash: Some(hash_content(b"{}")),
                    before: "{}".into(),
                    after: "not-json".into(),
                    risk: RiskLevel::Low,
                    validator: "json".into(),
                },
            ],
        };
        assert!(
            apply_changeset(&set, &dir.path().join("backup"), &ApplyOptions::default()).is_err()
        );
        assert_eq!(fs::read_to_string(first).unwrap(), "original");
        assert_eq!(fs::read_to_string(second).unwrap(), "{}");
    }
}
