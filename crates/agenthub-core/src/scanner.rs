use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use walkdir::WalkDir;

use crate::{
    AgentDetection, AgentKind, AssetKind, AssetRecord, WorkspaceScan, canonical_project,
    manifest_path,
};

pub fn scan_workspace(project: &Path) -> Result<WorkspaceScan> {
    let root = canonical_project(project)?;
    let mut assets = Vec::new();
    let mut validation_warnings = Vec::new();

    for agent in AgentKind::ALL {
        for (path, kind, summary) in candidates(agent) {
            let absolute = root.join(path);
            if absolute.is_file() {
                assets.push(record(agent, kind, absolute, summary)?);
                if let Some(warning) = validate_native_config(&root.join(path)) {
                    validation_warnings.push((agent, warning));
                }
            } else if absolute.is_dir() {
                for entry in WalkDir::new(&absolute)
                    .max_depth(4)
                    .into_iter()
                    .filter_map(|entry| entry.ok())
                {
                    if entry.file_type().is_file() {
                        let entry_path = entry.into_path();
                        let is_asset =
                            entry_path
                                .file_name()
                                .and_then(|v| v.to_str())
                                .is_some_and(|name| {
                                    name == "SKILL.md"
                                        || name.ends_with(".toml")
                                        || name.ends_with(".json")
                                        || name.ends_with(".md")
                                });
                        if is_asset {
                            assets.push(record(agent, kind, entry_path, summary)?);
                        }
                    }
                }
            }
        }
    }

    assets.sort_by(|a, b| a.path.cmp(&b.path));
    assets.dedup_by(|a, b| a.agent == b.agent && a.path == b.path);
    let agents = AgentKind::ALL
        .into_iter()
        .map(|agent| {
            let agent_assets: Vec<_> = assets.iter().filter(|asset| asset.agent == agent).collect();
            let warnings = validation_warnings
                .iter()
                .filter(|(owner, _)| *owner == agent)
                .map(|(_, warning)| warning.clone())
                .collect();
            AgentDetection {
                agent,
                detected: !agent_assets.is_empty(),
                asset_count: agent_assets.len(),
                warnings,
            }
        })
        .collect();

    let mut warnings: Vec<_> = validation_warnings
        .into_iter()
        .map(|(_, warning)| warning)
        .collect();
    if manifest_path(&root).is_file()
        && let Err(error) = crate::load_manifest(&root)
    {
        warnings.push(error.to_string());
    }

    Ok(WorkspaceScan {
        root: root.clone(),
        manifest_exists: manifest_path(&root).is_file(),
        agents,
        assets,
        warnings,
    })
}

fn validate_native_config(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let content = fs::read_to_string(path).ok()?;
    let error = if name.ends_with(".json") {
        serde_json::from_str::<serde_json::Value>(&content)
            .err()
            .map(|error| error.to_string())
    } else if name.ends_with(".toml") {
        toml::from_str::<toml::Value>(&content)
            .err()
            .map(|error| error.to_string())
    } else {
        None
    };
    error.map(|error| format!("配置文件损坏：{}（{}）", path.display(), error))
}

fn candidates(agent: AgentKind) -> Vec<(&'static str, AssetKind, &'static str)> {
    match agent {
        AgentKind::Codex => vec![
            ("AGENTS.md", AssetKind::Instruction, "Codex 项目指令"),
            (".agents/skills", AssetKind::Skill, "共享 Agent Skill"),
            (
                ".codex/config.toml",
                AssetKind::Configuration,
                "Codex 项目配置",
            ),
            (".codex/agents", AssetKind::Agent, "Codex 自定义 Agent"),
            (".codex/hooks.json", AssetKind::Hook, "Codex Hooks"),
        ],
        AgentKind::ClaudeCode => vec![
            ("CLAUDE.md", AssetKind::Instruction, "Claude Code 项目指令"),
            (
                ".claude/CLAUDE.md",
                AssetKind::Instruction,
                "Claude Code 项目指令",
            ),
            (
                ".claude/rules",
                AssetKind::Instruction,
                "Claude Code 目录规则",
            ),
            (".claude/skills", AssetKind::Skill, "Claude Code Skills"),
            (".claude/agents", AssetKind::Agent, "Claude Code Subagents"),
            (
                ".claude/settings.json",
                AssetKind::Configuration,
                "Claude Code 设置",
            ),
            (".mcp.json", AssetKind::Connection, "Claude Code MCP"),
        ],
        AgentKind::OpenClaw => vec![
            ("AGENTS.md", AssetKind::Instruction, "OpenClaw 工作区指令"),
            ("SOUL.md", AssetKind::Instruction, "OpenClaw 人格"),
            ("IDENTITY.md", AssetKind::Instruction, "OpenClaw 身份"),
            ("USER.md", AssetKind::Memory, "OpenClaw 用户画像"),
            ("MEMORY.md", AssetKind::Memory, "OpenClaw 长期记忆"),
            ("TOOLS.md", AssetKind::Configuration, "OpenClaw 工具说明"),
            ("skills", AssetKind::Skill, "OpenClaw Workspace Skills"),
            (".agents/skills", AssetKind::Skill, "共享 Agent Skill"),
        ],
        AgentKind::Hermes => vec![
            (".hermes.md", AssetKind::Instruction, "Hermes 项目指令"),
            ("HERMES.md", AssetKind::Instruction, "Hermes 项目指令"),
            ("AGENTS.md", AssetKind::Instruction, "Hermes 兼容项目指令"),
            ("CLAUDE.md", AssetKind::Instruction, "Hermes 兼容项目指令"),
            (
                ".cursorrules",
                AssetKind::Instruction,
                "Hermes Cursor 兼容规则",
            ),
        ],
    }
}

fn record(agent: AgentKind, kind: AssetKind, path: PathBuf, summary: &str) -> Result<AssetRecord> {
    let metadata = fs::metadata(&path)?;
    Ok(AssetRecord {
        agent,
        kind,
        path,
        exists: true,
        size: metadata.len(),
        summary: summary.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn reports_broken_native_configuration() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".codex")).unwrap();
        fs::write(dir.path().join(".codex/config.toml"), "[broken").unwrap();
        let scan = scan_workspace(dir.path()).unwrap();
        assert!(
            scan.warnings
                .iter()
                .any(|warning| warning.contains("配置文件损坏"))
        );
        assert_eq!(
            scan.agents
                .iter()
                .find(|agent| agent.agent == AgentKind::Codex)
                .unwrap()
                .warnings
                .len(),
            1
        );
    }
}
