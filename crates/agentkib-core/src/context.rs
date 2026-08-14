use std::collections::{BTreeSet, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use crate::{AgentKind, ContextPreview, ContextSection, Manifest, canonical_project};

const MAX_CONTEXT_CHARS_PER_FILE: usize = 128 * 1024;
const DSH_MAX_CONTEXT_BYTES: usize = 64 * 1024;
const DSH_MAX_SOURCE_BYTES: u64 = 1024 * 1024;

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
        .with_context(|| format!("Working directory does not exist: {}", cwd.display()))?;
    if !cwd.starts_with(&root) {
        bail!("Working directory must be inside the project");
    }

    let context_root = if agent == AgentKind::DeepSeekHarness {
        deepseek_project_root(&root, &cwd)
    } else {
        root.clone()
    };
    let dirs = directory_chain(&context_root, &cwd)?;
    let mut warnings = Vec::new();
    let sources = match agent {
        AgentKind::Codex => codex_sources(&dirs),
        AgentKind::ClaudeCode => claude_sources(&dirs),
        AgentKind::Cursor => cursor_sources(&dirs),
        AgentKind::OpenClaw => openclaw_sources(&root),
        AgentKind::Hermes => hermes_sources(&dirs),
        AgentKind::DeepSeekHarness => Vec::new(),
    };
    let mut sections = if agent == AgentKind::DeepSeekHarness {
        deepseek_harness_sections(&context_root, &dirs, &mut warnings)
    } else {
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
        sections
    };
    if sections.is_empty() {
        warnings.push("No project instruction file was found for this Agent".into());
    }

    if let Some(manifest) = manifest
        && let Some(override_text) = manifest.instructions.platform_overrides.get(&agent)
    {
        let already_generated = sections
            .iter()
            .any(|section| section.content.contains(override_text.trim()));
        if !override_text.trim().is_empty() && !already_generated {
            if !sections.is_empty() {
                warnings.push("The platform override is applied after native project instructions; check for semantic conflicts".into());
            }
            sections.push(ContextSection {
                source: root.join(".agentkib/manifest.yaml"),
                scope: "platform-override".into(),
                content: override_text.clone(),
                precedence: sections.len(),
            });
        }
    }
    let visible_skills = if agent == AgentKind::DeepSeekHarness {
        deepseek_harness_skills(&context_root)
    } else {
        manifest
            .map(|value| {
                value
                    .skills
                    .iter()
                    .filter(|skill| skill.targets.is_empty() || skill.targets.contains(&agent))
                    .map(|skill| skill.name.clone())
                    .collect()
            })
            .unwrap_or_default()
    };
    let visible_connections = if agent == AgentKind::DeepSeekHarness {
        Vec::new()
    } else {
        manifest
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
            .unwrap_or_default()
    };

    Ok(ContextPreview {
        agent,
        project: context_root,
        cwd,
        sections,
        visible_skills,
        visible_connections,
        approved_memories: if agent == AgentKind::DeepSeekHarness {
            Vec::new()
        } else {
            approved_memories
        },
        warnings,
    })
}

fn deepseek_project_root(workspace: &Path, cwd: &Path) -> PathBuf {
    let mut current = cwd;
    loop {
        if current.join(".git").exists() {
            return current.to_path_buf();
        }
        if current == workspace {
            return cwd.to_path_buf();
        }
        let Some(parent) = current
            .parent()
            .filter(|parent| parent.starts_with(workspace))
        else {
            return cwd.to_path_buf();
        };
        current = parent;
    }
}

fn deepseek_harness_home() -> Option<PathBuf> {
    env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .or_else(|| user_home().map(|home| home.join(".dsh")))
}

fn user_home() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

fn deepseek_harness_sections(
    root: &Path,
    dirs: &[PathBuf],
    warnings: &mut Vec<String>,
) -> Vec<ContextSection> {
    let mut sections = Vec::new();
    let mut remaining = DSH_MAX_CONTEXT_BYTES;
    if let Some(home) = deepseek_harness_home() {
        let global = home.join("AGENTS.md");
        push_deepseek_section(
            &mut sections,
            global,
            "agent-home".into(),
            &mut remaining,
            warnings,
        );
        if deepseek_custom_loading_rules(&home) {
            warnings.push(
                "DeepSeek Harness custom instruction or Skill loading rules were detected; this preview uses the public default rules"
                    .into(),
            );
        }
    }
    for dir in dirs {
        let scope = dir
            .strip_prefix(root)
            .unwrap_or(Path::new("."))
            .display()
            .to_string();
        let mut seen = HashSet::new();
        for name in [
            "AGENTS.md",
            "CLAUDE.md",
            "AGENTS.local.md",
            "CLAUDE.local.md",
        ] {
            let path = dir.join(name);
            let Ok(metadata) = fs::metadata(&path) else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            if metadata.len() > DSH_MAX_SOURCE_BYTES {
                warnings.push(format!(
                    "DeepSeek Harness instruction file exceeds 1 MiB and was skipped: {}",
                    path.display()
                ));
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                warnings.push(format!("Could not read {}", path.display()));
                continue;
            };
            let normalized = content.trim().to_string();
            if !seen.insert(normalized) {
                continue;
            }
            if name == "CLAUDE.md" && content.lines().any(|line| line.trim() == "@AGENTS.md") {
                warnings.push(
                    "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import"
                        .into(),
                );
            }
            push_deepseek_content(
                &mut sections,
                path,
                scope.clone(),
                content,
                &mut remaining,
                warnings,
            );
        }
    }
    sections
}

fn push_deepseek_section(
    sections: &mut Vec<ContextSection>,
    path: PathBuf,
    scope: String,
    remaining: &mut usize,
    warnings: &mut Vec<String>,
) {
    let Ok(metadata) = fs::metadata(&path) else {
        return;
    };
    if !metadata.is_file() {
        return;
    }
    if metadata.len() > DSH_MAX_SOURCE_BYTES {
        warnings.push(format!(
            "DeepSeek Harness instruction file exceeds 1 MiB and was skipped: {}",
            path.display()
        ));
        return;
    }
    match fs::read_to_string(&path) {
        Ok(content) => push_deepseek_content(sections, path, scope, content, remaining, warnings),
        Err(error) => warnings.push(format!("Could not read {}: {error}", path.display())),
    }
}

fn push_deepseek_content(
    sections: &mut Vec<ContextSection>,
    path: PathBuf,
    scope: String,
    content: String,
    remaining: &mut usize,
    warnings: &mut Vec<String>,
) {
    if *remaining == 0 {
        warnings.push("DeepSeek Harness instruction budget of 64 KiB was exhausted".into());
        return;
    }
    let take = content.len().min(*remaining);
    let mut boundary = take;
    while boundary > 0 && !content.is_char_boundary(boundary) {
        boundary -= 1;
    }
    let truncated = boundary < content.len();
    sections.push(ContextSection {
        source: path.clone(),
        scope,
        content: content[..boundary].to_string(),
        precedence: sections.len(),
    });
    *remaining = remaining.saturating_sub(boundary);
    if truncated {
        warnings.push(format!(
            "DeepSeek Harness instruction budget of 64 KiB truncated {}",
            path.display()
        ));
    }
}

fn deepseek_custom_loading_rules(home: &Path) -> bool {
    let mut candidates = vec![home.join("cordis.patch.yml")];
    let profiles = home.join("profiles");
    if let Ok(entries) = fs::read_dir(profiles) {
        candidates.extend(
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path().join("cordis.patch.yml")),
        );
    }
    candidates.into_iter().any(|path| {
        fs::read_to_string(path).is_ok_and(|content| {
            content.contains("agent-instructions") || content.contains("skill-filesystem")
        })
    })
}

fn deepseek_harness_skills(root: &Path) -> Vec<String> {
    let mut names = BTreeSet::new();
    let mut roots = vec![root.join(".dsh/skills"), root.join(".agents/skills")];
    if let Some(home) = deepseek_harness_home() {
        roots.push(home.join("skills"));
    }
    if let Some(home) = user_home() {
        roots.push(home.join(".agents/skills"));
    }
    for skill_root in roots {
        let Ok(entries) = fs::read_dir(skill_root) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            let is_skill = path.is_dir() && path.join("SKILL.md").is_file()
                || path.extension().is_some_and(|extension| extension == "md");
            if is_skill && let Some(name) = path.file_stem().and_then(|value| value.to_str()) {
                names.insert(name.to_string());
            }
        }
    }
    names.into_iter().collect()
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

fn cursor_sources(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut result = Vec::new();
    if let Some(root) = dirs.first() {
        let agents = root.join("AGENTS.md");
        if agents.is_file() {
            result.push(agents);
        }
    }
    for dir in dirs {
        let rules = dir.join(".cursor/rules");
        let Ok(entries) = fs::read_dir(rules) else {
            continue;
        };
        let mut files: Vec<_> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "mdc"))
            .collect();
        files.sort();
        result.extend(files.into_iter().filter(|path| cursor_rule_is_always(path)));
    }
    result
}

fn cursor_rule_is_always(path: &Path) -> bool {
    fs::read_to_string(path).is_ok_and(|content| {
        let mut lines = content.lines();
        if lines.next().map(str::trim) != Some("---") {
            return false;
        }
        lines.take_while(|line| line.trim() != "---").any(|line| {
            line.split_once(':').is_some_and(|(key, value)| {
                key.trim() == "alwaysApply" && value.trim().eq_ignore_ascii_case("true")
            })
        })
    })
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
        bail!("Instruction import depth exceeds 5: {}", path.display());
    }
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(project) {
        bail!(
            "Refusing to import instructions outside the project: {}",
            path.display()
        );
    }
    if !visited.insert(canonical.clone()) {
        bail!("Circular instruction import detected: {}", path.display());
    }
    let raw = fs::read_to_string(&canonical)
        .with_context(|| format!("Could not read {}", path.display()))?;
    let content = if raw.chars().count() > MAX_CONTEXT_CHARS_PER_FILE {
        warnings.push(format!(
            "Instruction file exceeds {} characters and was truncated for preview: {}",
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
                "Imported file is missing: {} (source: {})",
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
                .any(|warning| warning.contains("Imported file is missing"))
        );
    }

    #[test]
    fn cursor_context_uses_agents_and_only_always_rules() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".cursor/rules")).unwrap();
        fs::write(dir.path().join("AGENTS.md"), "shared").unwrap();
        fs::write(
            dir.path().join(".cursor/rules/always.mdc"),
            "---\nalwaysApply: true\n---\ncursor override",
        )
        .unwrap();
        fs::write(
            dir.path().join(".cursor/rules/manual.mdc"),
            "---\nalwaysApply: false\n---\nmanual rule",
        )
        .unwrap();

        let preview =
            resolve_context(dir.path(), dir.path(), AgentKind::Cursor, None, vec![]).unwrap();
        assert_eq!(preview.sections.len(), 2);
        assert_eq!(preview.sections[0].content.trim(), "shared");
        assert!(preview.sections[1].content.contains("cursor override"));
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
                .any(|warning| warning.contains("outside the project"))
        );
        assert!(preview.sections.is_empty());
    }

    #[test]
    fn deepseek_harness_loads_overlays_in_order_and_keeps_claude_import_literal() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("src");
        fs::create_dir(&nested).unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join("AGENTS.md"), "root rules").unwrap();
        fs::write(dir.path().join("CLAUDE.md"), "@AGENTS.md\nclaude rules").unwrap();
        fs::write(nested.join("AGENTS.md"), "nested rules").unwrap();
        fs::write(nested.join("AGENTS.local.md"), "local override").unwrap();

        let preview = resolve_context(
            dir.path(),
            &nested,
            AgentKind::DeepSeekHarness,
            None,
            vec!["must not be shared".into()],
        )
        .unwrap();
        let project = dir.path().canonicalize().unwrap();
        let project_sections: Vec<_> = preview
            .sections
            .iter()
            .filter(|section| section.source.starts_with(&project))
            .collect();

        assert_eq!(project_sections.len(), 4);
        assert_eq!(project_sections[0].source, project.join("AGENTS.md"));
        assert_eq!(project_sections[1].source, project.join("CLAUDE.md"));
        assert_eq!(project_sections[2].source, project.join("src/AGENTS.md"));
        assert_eq!(
            project_sections[3].source,
            project.join("src/AGENTS.local.md")
        );
        assert!(project_sections[1].content.contains("@AGENTS.md"));
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.contains("literal text"))
        );
        assert!(preview.approved_memories.is_empty());
        assert!(preview.visible_connections.is_empty());
    }
}
