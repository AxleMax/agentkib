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
                    .filter_entry(|entry| agentkib_platform::path::is_safe_scan_entry(entry.path()))
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
                                        || name.ends_with(".mdc")
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
    error.map(|error| {
        format!(
            "Configuration file is invalid: {} ({})",
            path.display(),
            error
        )
    })
}

fn candidates(agent: AgentKind) -> Vec<(&'static str, AssetKind, &'static str)> {
    match agent {
        AgentKind::Codex => vec![
            (
                "AGENTS.md",
                AssetKind::Instruction,
                "Codex project instructions",
            ),
            (".agents/skills", AssetKind::Skill, "Shared Agent Skill"),
            (
                ".codex/config.toml",
                AssetKind::Configuration,
                "Codex project configuration",
            ),
            (".codex/agents", AssetKind::Agent, "Codex custom Agent"),
            (".codex/hooks.json", AssetKind::Hook, "Codex Hooks"),
        ],
        AgentKind::ClaudeCode => vec![
            (
                "CLAUDE.md",
                AssetKind::Instruction,
                "Claude Code project instructions",
            ),
            (
                ".claude/CLAUDE.md",
                AssetKind::Instruction,
                "Claude Code project instructions",
            ),
            (
                ".claude/rules",
                AssetKind::Instruction,
                "Claude Code directory rules",
            ),
            (".claude/skills", AssetKind::Skill, "Claude Code Skills"),
            (".claude/agents", AssetKind::Agent, "Claude Code Subagents"),
            (
                ".claude/settings.json",
                AssetKind::Configuration,
                "Claude Code settings",
            ),
            (".mcp.json", AssetKind::Connection, "Claude Code MCP"),
        ],
        AgentKind::Cursor => vec![
            (
                "AGENTS.md",
                AssetKind::Instruction,
                "Cursor project instructions",
            ),
            (
                ".cursor/rules",
                AssetKind::Instruction,
                "Cursor project rules",
            ),
            (
                ".cursor/commands",
                AssetKind::Instruction,
                "Cursor commands",
            ),
            (".cursor/skills", AssetKind::Skill, "Cursor Skills"),
            (".cursor/hooks.json", AssetKind::Hook, "Cursor Hooks"),
            (".cursor/mcp.json", AssetKind::Connection, "Cursor MCP"),
        ],
        AgentKind::OpenClaw => vec![
            (
                "AGENTS.md",
                AssetKind::Instruction,
                "OpenClaw workspace instructions",
            ),
            ("SOUL.md", AssetKind::Instruction, "OpenClaw persona"),
            ("IDENTITY.md", AssetKind::Instruction, "OpenClaw identity"),
            ("USER.md", AssetKind::Memory, "OpenClaw user profile"),
            ("MEMORY.md", AssetKind::Memory, "OpenClaw long-term memory"),
            ("TOOLS.md", AssetKind::Configuration, "OpenClaw tool notes"),
            ("skills", AssetKind::Skill, "OpenClaw Workspace Skills"),
            (".agents/skills", AssetKind::Skill, "Shared Agent Skill"),
        ],
        AgentKind::Hermes => vec![
            (
                ".hermes.md",
                AssetKind::Instruction,
                "Hermes project instructions",
            ),
            (
                "HERMES.md",
                AssetKind::Instruction,
                "Hermes project instructions",
            ),
            (
                "AGENTS.md",
                AssetKind::Instruction,
                "Hermes-compatible project instructions",
            ),
            (
                "CLAUDE.md",
                AssetKind::Instruction,
                "Hermes-compatible project instructions",
            ),
            (
                ".cursorrules",
                AssetKind::Instruction,
                "Hermes Cursor-compatible rules",
            ),
        ],
        AgentKind::DeepSeekHarness => vec![
            (
                "AGENTS.md",
                AssetKind::Instruction,
                "DeepSeek Harness project instructions",
            ),
            (
                "CLAUDE.md",
                AssetKind::Instruction,
                "DeepSeek Harness project instructions",
            ),
            (
                "AGENTS.local.md",
                AssetKind::Instruction,
                "DeepSeek Harness local project instructions",
            ),
            (
                "CLAUDE.local.md",
                AssetKind::Instruction,
                "DeepSeek Harness local project instructions",
            ),
            (".dsh/skills", AssetKind::Skill, "DeepSeek Harness Skills"),
            (".agents/skills", AssetKind::Skill, "Shared Agent Skill"),
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
        summary_key: summary_translation_key(summary).map(str::to_string),
        summary_params: Default::default(),
    })
}

fn summary_translation_key(summary: &str) -> Option<&'static str> {
    if summary.contains("Codex") && summary.to_ascii_lowercase().contains("instruction") {
        Some("assets.summary.codexInstructions")
    } else if summary.contains("Claude Code") && summary.contains("instruction") {
        Some("assets.summary.claudeInstructions")
    } else if summary.contains("OpenClaw") && summary.contains("instruction") {
        Some("assets.summary.openClawInstructions")
    } else if summary.contains("Hermes") && summary.contains("instruction") {
        Some("assets.summary.hermesInstructions")
    } else if summary.contains("DeepSeek Harness") && summary.contains("instruction") {
        Some("assets.summary.deepseekHarnessInstructions")
    } else if summary.contains("Cursor") && summary.contains("instruction") {
        Some("assets.summary.cursorInstructions")
    } else if summary.contains("Skill") {
        Some("assets.summary.skillDirectory")
    } else if summary.contains("MCP") {
        Some("assets.summary.mcpConfig")
    } else {
        None
    }
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
                .any(|warning| warning.contains("Configuration file is invalid"))
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

    #[test]
    fn scans_cursor_rules_commands_hooks_and_mcp() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".cursor/rules")).unwrap();
        fs::create_dir_all(dir.path().join(".cursor/commands")).unwrap();
        fs::write(
            dir.path().join(".cursor/rules/project.mdc"),
            "---\nalwaysApply: true\n---\nRule",
        )
        .unwrap();
        fs::write(dir.path().join(".cursor/commands/review.md"), "Review").unwrap();
        fs::write(dir.path().join(".cursor/hooks.json"), "{}").unwrap();
        fs::write(dir.path().join(".cursor/mcp.json"), "{}").unwrap();

        let scan = scan_workspace(dir.path()).unwrap();
        let cursor = scan
            .agents
            .iter()
            .find(|agent| agent.agent == AgentKind::Cursor)
            .unwrap();
        assert!(cursor.detected);
        assert_eq!(cursor.asset_count, 4);
    }
}
