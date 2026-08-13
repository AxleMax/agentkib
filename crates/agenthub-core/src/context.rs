use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use crate::{AgentKind, ContextPreview, ContextSection, Manifest, canonical_project};

const MAX_CONTEXT_CHARS_PER_FILE: usize = 128 * 1024;

pub fn resolve_context(
    project: &Path,
    cwd: &Path,
    agent: AgentKind,
    manifest: Option<&Manifest>,
    approved_memories: Vec<String>,
) -> Result<ContextPreview> {
    let root = canonical_project(project)?;
    let cwd = if cwd.is_absolute() {
        cwd.to_path_buf()
    } else {
        root.join(cwd)
    };
    let cwd = cwd
        .canonicalize()
        .with_context(|| format!("工作目录不存在：{}", cwd.display()))?;
    if !cwd.starts_with(&root) {
        bail!("工作目录必须位于项目内");
    }

    let dirs = directory_chain(&root, &cwd)?;
    let mut warnings = Vec::new();
    let sources = match agent {
        AgentKind::Codex => codex_sources(&dirs),
        AgentKind::ClaudeCode => claude_sources(&dirs),
        AgentKind::OpenClaw => openclaw_sources(&root),
        AgentKind::Hermes => hermes_sources(&dirs),
    };
    let mut sections = Vec::new();
    for source in sources {
        match load_with_imports(&source, &root, &mut HashSet::new(), 0, &mut warnings) {
            Ok(content) => sections.push(ContextSection {
                scope: source
                    .parent()
                    .unwrap_or(&root)
                    .strip_prefix(&root)
                    .unwrap_or(Path::new("."))
                    .display()
                    .to_string(),
                source,
                content,
                precedence: sections.len(),
            }),
            Err(error) => warnings.push(error.to_string()),
        }
    }
    if sections.is_empty() {
        warnings.push("没有发现该 Agent 的项目指令文件".into());
    }

    if let Some(manifest) = manifest
        && let Some(override_text) = manifest.instructions.platform_overrides.get(&agent)
    {
        let already_generated = sections
            .iter()
            .any(|section| section.content.contains(override_text.trim()));
        if !override_text.trim().is_empty() && !already_generated {
            if !sections.is_empty() {
                warnings.push("平台覆盖将在原生项目指令之后生效，请检查是否存在语义冲突".into());
            }
            sections.push(ContextSection {
                source: root.join(".agenthub/manifest.yaml"),
                scope: "platform-override".into(),
                content: override_text.clone(),
                precedence: sections.len(),
            });
        }
    }
    let visible_skills = manifest
        .map(|value| {
            value
                .skills
                .iter()
                .filter(|skill| skill.targets.is_empty() || skill.targets.contains(&agent))
                .map(|skill| skill.name.clone())
                .collect()
        })
        .unwrap_or_default();
    let visible_connections = manifest
        .map(|value| {
            value
                .connections
                .iter()
                .filter(|connection| {
                    connection.targets.is_empty() || connection.targets.contains(&agent)
                })
                .map(|connection| connection.name.clone())
                .collect()
        })
        .unwrap_or_default();

    Ok(ContextPreview {
        agent,
        project: root,
        cwd,
        sections,
        visible_skills,
        visible_connections,
        approved_memories,
        warnings,
    })
}

fn directory_chain(root: &Path, cwd: &Path) -> Result<Vec<PathBuf>> {
    let relative = cwd.strip_prefix(root)?;
    let mut dirs = vec![root.to_path_buf()];
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        dirs.push(current.clone());
    }
    Ok(dirs)
}

fn codex_sources(dirs: &[PathBuf]) -> Vec<PathBuf> {
    dirs.iter()
        .filter_map(|dir| first_existing(dir, &["AGENTS.override.md", "AGENTS.md"]))
        .collect()
}

fn claude_sources(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for dir in dirs {
        for path in [
            dir.join("CLAUDE.md"),
            dir.join("CLAUDE.local.md"),
            dir.join(".claude/CLAUDE.md"),
        ] {
            if path.is_file() {
                result.push(path);
            }
        }
    }
    if let Some(root) = dirs.first() {
        let rules = root.join(".claude/rules");
        if let Ok(entries) = fs::read_dir(rules) {
            let mut files: Vec<_> = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
                .collect();
            files.sort();
            result.extend(files);
        }
    }
    result
}

fn openclaw_sources(root: &Path) -> Vec<PathBuf> {
    [
        "AGENTS.md",
        "SOUL.md",
        "IDENTITY.md",
        "USER.md",
        "TOOLS.md",
        "MEMORY.md",
    ]
    .into_iter()
    .map(|name| root.join(name))
    .filter(|path| path.is_file())
    .collect()
}

fn hermes_sources(dirs: &[PathBuf]) -> Vec<PathBuf> {
    dirs.iter()
        .filter_map(|dir| {
            first_existing(
                dir,
                &[
                    ".hermes.md",
                    "HERMES.md",
                    "AGENTS.md",
                    "CLAUDE.md",
                    ".cursorrules",
                ],
            )
        })
        .collect()
}

fn first_existing(dir: &Path, names: &[&str]) -> Option<PathBuf> {
    names
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file())
}

fn load_with_imports(
    path: &Path,
    project: &Path,
    visited: &mut HashSet<PathBuf>,
    depth: usize,
    warnings: &mut Vec<String>,
) -> Result<String> {
    if depth > 5 {
        bail!("指令导入深度超过 5：{}", path.display());
    }
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(project) {
        bail!("拒绝导入项目外指令：{}", path.display());
    }
    if !visited.insert(canonical.clone()) {
        bail!("检测到循环导入：{}", path.display());
    }
    let raw =
        fs::read_to_string(&canonical).with_context(|| format!("无法读取 {}", path.display()))?;
    let content = if raw.chars().count() > MAX_CONTEXT_CHARS_PER_FILE {
        warnings.push(format!(
            "指令文件超过 {} 字符，预览已截断：{}",
            MAX_CONTEXT_CHARS_PER_FILE,
            path.display()
        ));
        raw.chars()
            .take(MAX_CONTEXT_CHARS_PER_FILE)
            .collect::<String>()
    } else {
        raw
    };
    let mut output = String::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(import_path) = trimmed
            .strip_prefix('@')
            .filter(|value| !value.contains(' '))
        {
            let imported = canonical
                .parent()
                .unwrap_or(Path::new("."))
                .join(import_path);
            if imported.is_file() {
                output.push_str(&load_with_imports(
                    &imported,
                    project,
                    visited,
                    depth + 1,
                    warnings,
                )?);
                output.push('\n');
                continue;
            }
            warnings.push(format!(
                "导入文件缺失：{}（来源 {}）",
                imported.display(),
                canonical.display()
            ));
        }
        output.push_str(line);
        output.push('\n');
    }
    visited.remove(&canonical);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn codex_context_inherits_root_and_nested_rules_in_order() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("src/module");
        fs::create_dir_all(&nested).unwrap();
        fs::write(dir.path().join("AGENTS.md"), "root").unwrap();
        fs::write(dir.path().join("src/AGENTS.md"), "src").unwrap();
        let preview = resolve_context(dir.path(), &nested, AgentKind::Codex, None, vec![]).unwrap();
        assert_eq!(preview.sections.len(), 2);
        assert_eq!(preview.sections[0].content.trim(), "root");
        assert_eq!(preview.sections[1].content.trim(), "src");
    }

    #[test]
    fn missing_import_is_reported() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("CLAUDE.md"), "@missing.md").unwrap();
        let preview =
            resolve_context(dir.path(), dir.path(), AgentKind::ClaudeCode, None, vec![]).unwrap();
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.contains("导入文件缺失"))
        );
    }

    #[test]
    fn import_cannot_escape_project() {
        let parent = tempdir().unwrap();
        let project = parent.path().join("project");
        fs::create_dir(&project).unwrap();
        fs::write(parent.path().join("outside.md"), "secret").unwrap();
        fs::write(project.join("CLAUDE.md"), "@../outside.md").unwrap();
        let preview =
            resolve_context(&project, &project, AgentKind::ClaudeCode, None, vec![]).unwrap();
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.contains("拒绝导入项目外"))
        );
        assert!(preview.sections.is_empty());
    }
}
