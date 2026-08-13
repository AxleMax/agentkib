use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use agentkib_core::{
    AdapterState, AgentKind, ChangeScope, ChangeSet, ConnectionDefinition, ConnectionTransport,
    FileChange, Manifest, RiskLevel, hash_content, manifest_path,
};
use anyhow::{Context, Result};
use chrono::Utc;
use serde_json::{Map as JsonMap, Value as JsonValue};
use uuid::Uuid;
use walkdir::WalkDir;

const START: &str = "<!-- agentkib:managed:start -->";
const END: &str = "<!-- agentkib:managed:end -->";
const TOML_START: &str = "# agentkib:managed:start";
const TOML_END: &str = "# agentkib:managed:end";

#[derive(Debug, Clone, Default)]
pub struct HomeTargets {
    pub openclaw_config: Option<PathBuf>,
    pub hermes_config: Option<PathBuf>,
}

pub fn default_manifest(project: &Path) -> Result<Manifest> {
    let name = project
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("workspace")
        .to_string();
    let agents = fs::read_to_string(project.join("AGENTS.md")).ok();
    let claude = fs::read_to_string(project.join("CLAUDE.md")).ok();
    let shared = agents
        .clone()
        .or_else(|| {
            claude
                .as_ref()
                .filter(|content| {
                    !content.lines().any(|line| line.trim() == "@AGENTS.md")
                })
                .cloned()
        })
        .unwrap_or_else(|| "# Project instructions\n\n- Preserve existing project conventions.\n- Run relevant tests after changes.\n".into());
    let mut platform_overrides = BTreeMap::new();
    if let Ok(content) = fs::read_to_string(project.join("AGENTS.override.md"))
        && let Some(override_text) = platform_delta(&shared, &content)
    {
        platform_overrides.insert(AgentKind::Codex, override_text);
    }
    if agents.is_some()
        && let Some(content) = claude
        && let Some(override_text) = claude_platform_override(&content)
    {
        platform_overrides.insert(AgentKind::ClaudeCode, override_text);
    }
    if let Some(content) = [".hermes.md", "HERMES.md"]
        .into_iter()
        .find_map(|name| fs::read_to_string(project.join(name)).ok())
        && let Some(override_text) = platform_delta(&shared, &content)
    {
        platform_overrides.insert(AgentKind::Hermes, override_text);
    }
    let adapters = AgentKind::ALL
        .into_iter()
        .map(|agent| {
            (
                agent,
                AdapterState {
                    enabled: true,
                    generated_hashes: BTreeMap::new(),
                },
            )
        })
        .collect();
    let skills = discover_shared_skills(project)?;
    let scoped = discover_scoped_instructions(project)?;
    Ok(Manifest {
        schema_version: 1,
        workspace: agentkib_core::WorkspaceIdentity {
            id: Uuid::new_v4().to_string(),
            name,
        },
        instructions: agentkib_core::InstructionSet {
            shared,
            scoped,
            platform_overrides,
        },
        skills,
        connections: Vec::new(),
        memories: Default::default(),
        adapters,
    })
}

fn discover_scoped_instructions(project: &Path) -> Result<Vec<agentkib_core::ScopedInstruction>> {
    let mut scoped = Vec::new();
    for entry in WalkDir::new(project)
        .min_depth(2)
        .max_depth(8)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            !entry.file_type().is_dir()
                || !matches!(
                    entry.file_name().to_str(),
                    Some(".git" | ".agentkib" | "node_modules" | "target" | "dist")
                )
        })
    {
        let entry = entry?;
        if !entry.file_type().is_file() || entry.file_name() != "AGENTS.md" {
            continue;
        }
        let parent = entry.path().parent().context("目录级规则缺少父目录")?;
        let relative = parent.strip_prefix(project)?;
        scoped.push(agentkib_core::ScopedInstruction {
            path: relative.display().to_string(),
            content: fs::read_to_string(entry.path())?,
        });
    }
    scoped.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(scoped)
}

fn platform_delta(shared: &str, platform_content: &str) -> Option<String> {
    let content = platform_content.trim();
    let shared = shared.trim();
    if content.is_empty() || content == shared {
        return None;
    }
    let delta = content
        .strip_prefix(shared)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(content);
    Some(delta.to_string())
}

fn claude_platform_override(content: &str) -> Option<String> {
    let imports_agents = content.lines().any(|line| line.trim() == "@AGENTS.md");
    if !imports_agents {
        return Some(content.trim().to_string()).filter(|value| !value.is_empty());
    }
    let remaining = content
        .lines()
        .filter(|line| {
            let line = line.trim();
            line != "@AGENTS.md" && line != "Claude Code 使用 AGENTS.md 作为共享项目规则。"
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(remaining.trim().to_string()).filter(|value| !value.is_empty())
}

fn discover_shared_skills(project: &Path) -> Result<Vec<agentkib_core::SkillDefinition>> {
    let directory = project.join(".agents/skills");
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut skills = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let skill_file = entry.path().join("SKILL.md");
        if skill_file.is_file()
            && let Some(name) = entry.file_name().to_str()
        {
            skills.push(agentkib_core::SkillDefinition {
                name: name.to_string(),
                path: format!(".agents/skills/{name}"),
                targets: Vec::new(),
            });
        }
    }
    skills.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(skills)
}

pub fn plan_workspace_changes(
    project: &Path,
    manifest: &Manifest,
    home: &HomeTargets,
) -> Result<ChangeSet> {
    agentkib_core::validate_manifest(manifest)?;
    let root = agentkib_core::canonical_project(project)?;
    let mut changes = Vec::new();

    let common_enabled = [AgentKind::Codex, AgentKind::OpenClaw, AgentKind::Hermes]
        .into_iter()
        .any(|agent| adapter_enabled(manifest, agent));
    if common_enabled {
        push_change(
            &mut changes,
            root.join("AGENTS.md"),
            managed_markdown(
                &fs::read_to_string(root.join("AGENTS.md")).unwrap_or_default(),
                &manifest.instructions.shared,
            ),
            ChangeScope::Project,
            RiskLevel::Medium,
            "markdown",
        )?;
    }
    if adapter_enabled(manifest, AgentKind::ClaudeCode) {
        let claude_override = manifest
            .instructions
            .platform_overrides
            .get(&AgentKind::ClaudeCode)
            .map(String::as_str)
            .unwrap_or_default();
        let claude_content = if claude_override.trim().is_empty() {
            "@AGENTS.md\n\nClaude Code 使用 AGENTS.md 作为共享项目规则。".to_string()
        } else {
            format!("@AGENTS.md\n\n{claude_override}")
        };
        push_change(
            &mut changes,
            root.join("CLAUDE.md"),
            managed_markdown(
                &fs::read_to_string(root.join("CLAUDE.md")).unwrap_or_default(),
                &claude_content,
            ),
            ChangeScope::Project,
            RiskLevel::Medium,
            "markdown",
        )?;
        push_change(
            &mut changes,
            root.join(".mcp.json"),
            merge_claude_mcp(&root.join(".mcp.json"), &manifest.connections)?,
            ChangeScope::Project,
            RiskLevel::Medium,
            "json",
        )?;
    }
    if adapter_enabled(manifest, AgentKind::Codex) {
        let codex_override = manifest
            .instructions
            .platform_overrides
            .get(&AgentKind::Codex)
            .map(String::as_str)
            .unwrap_or_default();
        let override_path = root.join("AGENTS.override.md");
        if !codex_override.trim().is_empty() || override_path.is_file() {
            let content = if codex_override.trim().is_empty() {
                manifest.instructions.shared.clone()
            } else {
                format!(
                    "{}\n\n{}",
                    manifest.instructions.shared.trim(),
                    codex_override.trim()
                )
            };
            push_change(
                &mut changes,
                override_path.clone(),
                managed_markdown(
                    &fs::read_to_string(&override_path).unwrap_or_default(),
                    &content,
                ),
                ChangeScope::Project,
                RiskLevel::Medium,
                "markdown",
            )?;
        }
        push_change(
            &mut changes,
            root.join(".codex/config.toml"),
            merge_codex_config(&root.join(".codex/config.toml"), &manifest.connections)?,
            ChangeScope::Project,
            RiskLevel::Medium,
            "toml",
        )?;
    }
    if adapter_enabled(manifest, AgentKind::OpenClaw) {
        let platform_override = manifest
            .instructions
            .platform_overrides
            .get(&AgentKind::OpenClaw)
            .map(String::as_str)
            .unwrap_or_default();
        let target = root.join("TOOLS.md");
        if !platform_override.trim().is_empty()
            || target.is_file()
                && fs::read_to_string(&target)
                    .unwrap_or_default()
                    .contains(START)
        {
            push_change(
                &mut changes,
                target.clone(),
                managed_markdown(
                    &fs::read_to_string(&target).unwrap_or_default(),
                    platform_override,
                ),
                ChangeScope::Project,
                RiskLevel::Medium,
                "markdown",
            )?;
        }
    }
    if adapter_enabled(manifest, AgentKind::Hermes) {
        let platform_override = manifest
            .instructions
            .platform_overrides
            .get(&AgentKind::Hermes)
            .map(String::as_str)
            .unwrap_or_default();
        let target = root.join(".hermes.md");
        if !platform_override.trim().is_empty()
            || target.is_file()
                && fs::read_to_string(&target)
                    .unwrap_or_default()
                    .contains(START)
        {
            let content = if platform_override.trim().is_empty() {
                manifest.instructions.shared.clone()
            } else {
                format!(
                    "{}\n\n{}",
                    manifest.instructions.shared.trim(),
                    platform_override.trim()
                )
            };
            push_change(
                &mut changes,
                target.clone(),
                managed_markdown(&fs::read_to_string(&target).unwrap_or_default(), &content),
                ChangeScope::Project,
                RiskLevel::Medium,
                "markdown",
            )?;
        }
    }

    for scoped in &manifest.instructions.scoped {
        let directory = root.join(&scoped.path);
        if common_enabled {
            let agents = directory.join("AGENTS.md");
            push_change(
                &mut changes,
                agents.clone(),
                managed_markdown(
                    &fs::read_to_string(&agents).unwrap_or_default(),
                    &scoped.content,
                ),
                ChangeScope::Project,
                RiskLevel::Medium,
                "markdown",
            )?;
        }
        if adapter_enabled(manifest, AgentKind::ClaudeCode) {
            let claude = directory.join("CLAUDE.md");
            push_change(
                &mut changes,
                claude.clone(),
                managed_markdown(
                    &fs::read_to_string(&claude).unwrap_or_default(),
                    "@AGENTS.md",
                ),
                ChangeScope::Project,
                RiskLevel::Medium,
                "markdown",
            )?;
        }
    }

    for skill in &manifest.skills {
        for (relative_path, content) in skill_source_files(&root, skill)? {
            if common_enabled
                && (skill.targets.is_empty()
                    || skill.targets.iter().any(|agent| {
                        matches!(
                            agent,
                            AgentKind::Codex | AgentKind::OpenClaw | AgentKind::Hermes
                        )
                    }))
            {
                push_change(
                    &mut changes,
                    root.join(".agents/skills")
                        .join(&skill.name)
                        .join(&relative_path),
                    content.clone(),
                    ChangeScope::Project,
                    RiskLevel::Low,
                    validator_for_skill_file(&relative_path),
                )?;
            }
            if adapter_enabled(manifest, AgentKind::ClaudeCode)
                && (skill.targets.is_empty() || skill.targets.contains(&AgentKind::ClaudeCode))
            {
                push_change(
                    &mut changes,
                    root.join(".claude/skills")
                        .join(&skill.name)
                        .join(&relative_path),
                    content,
                    ChangeScope::Project,
                    RiskLevel::Low,
                    validator_for_skill_file(&relative_path),
                )?;
            }
        }
    }

    if adapter_enabled(manifest, AgentKind::OpenClaw)
        && let Some(path) = &home.openclaw_config
    {
        push_change(
            &mut changes,
            path.clone(),
            merge_openclaw(path, &manifest.connections)?,
            ChangeScope::AgentHome,
            RiskLevel::High,
            "json",
        )?;
    }
    if adapter_enabled(manifest, AgentKind::Hermes)
        && let Some(path) = &home.hermes_config
    {
        push_change(
            &mut changes,
            path.clone(),
            merge_hermes(path, &root, manifest)?,
            ChangeScope::AgentHome,
            RiskLevel::High,
            "yaml",
        )?;
    }
    changes.retain(|change| change.before != change.after);
    let mut persisted_manifest = manifest.clone();
    update_generated_hashes(&root, &mut persisted_manifest, &changes);
    let manifest_target = manifest_path(&root);
    let manifest_after = serde_yaml::to_string(&persisted_manifest)?;
    let manifest_before = fs::read_to_string(&manifest_target).unwrap_or_default();
    if manifest_before != manifest_after {
        let original_hash = manifest_target
            .exists()
            .then(|| hash_content(manifest_before.as_bytes()));
        changes.insert(
            0,
            FileChange {
                target: manifest_target,
                scope: ChangeScope::Project,
                original_hash,
                before: manifest_before,
                after: manifest_after,
                risk: RiskLevel::Low,
                validator: "yaml".into(),
            },
        );
    }
    let requires_home_approval = changes
        .iter()
        .any(|change| matches!(change.scope, ChangeScope::AgentHome));
    Ok(ChangeSet {
        id: Uuid::new_v4().to_string(),
        project_root: root,
        created_at: Utc::now(),
        changes,
        requires_home_approval,
    })
}

pub fn plan_changeset(
    project: &Path,
    manifest: &Manifest,
    home: &HomeTargets,
) -> Result<ChangeSet> {
    plan_workspace_changes(project, manifest, home)
}

fn adapter_enabled(manifest: &Manifest, agent: AgentKind) -> bool {
    manifest
        .adapters
        .get(&agent)
        .is_none_or(|state| state.enabled)
}

fn skill_source_files(
    root: &Path,
    skill: &agentkib_core::SkillDefinition,
) -> Result<Vec<(PathBuf, String)>> {
    let source = root.join(&skill.path);
    let canonical = source
        .canonicalize()
        .with_context(|| format!("Skill 路径不存在：{}", source.display()))?;
    if !canonical.starts_with(root) {
        anyhow::bail!("Skill 路径必须位于项目内：{}", source.display());
    }
    if canonical.is_file() {
        let file_name = canonical
            .file_name()
            .context("Skill 文件缺少文件名")?
            .into();
        return Ok(vec![(file_name, read_skill_text(&canonical)?)]);
    }

    let mut files = Vec::new();
    for entry in WalkDir::new(&canonical).follow_links(false) {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path().canonicalize()?;
        if !path.starts_with(root) {
            anyhow::bail!("Skill 文件必须位于项目内：{}", entry.path().display());
        }
        let relative = path.strip_prefix(&canonical)?.to_path_buf();
        files.push((relative, read_skill_text(&path)?));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(files)
}

fn read_skill_text(path: &Path) -> Result<String> {
    fs::read_to_string(path).with_context(|| {
        format!(
            "Skill 首版仅支持 UTF-8 文本资产，无法读取：{}",
            path.display()
        )
    })
}

fn validator_for_skill_file(path: &Path) -> &'static str {
    match path.extension().and_then(|value| value.to_str()) {
        Some("json") => "json",
        Some("toml") => "toml",
        Some("yaml" | "yml") => "yaml",
        Some("md") => "markdown",
        _ => "text",
    }
}

fn update_generated_hashes(root: &Path, manifest: &mut Manifest, changes: &[FileChange]) {
    for state in manifest.adapters.values_mut() {
        state.generated_hashes.clear();
    }
    for change in changes {
        let key = change
            .target
            .strip_prefix(root)
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| change.target.display().to_string());
        let hash = hash_content(change.after.as_bytes());
        let name = change
            .target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let path = change.target.to_string_lossy();
        let agents: &[AgentKind] = if path.contains(".openclaw") {
            &[AgentKind::OpenClaw]
        } else if path.contains(".hermes") {
            &[AgentKind::Hermes]
        } else if path.contains(".codex") {
            &[AgentKind::Codex]
        } else if path.contains(".claude") || name == "CLAUDE.md" || name == ".mcp.json" {
            &[AgentKind::ClaudeCode]
        } else {
            &[AgentKind::Codex, AgentKind::OpenClaw, AgentKind::Hermes]
        };
        for agent in agents {
            if let Some(state) = manifest.adapters.get_mut(agent) {
                state.generated_hashes.insert(key.clone(), hash.clone());
            }
        }
    }
}

fn push_change(
    changes: &mut Vec<FileChange>,
    target: PathBuf,
    after: String,
    scope: ChangeScope,
    risk: RiskLevel,
    validator: &str,
) -> Result<()> {
    let before = if target.exists() {
        fs::read_to_string(&target)
            .with_context(|| format!("无法读取现有配置：{}", target.display()))?
    } else {
        String::new()
    };
    let original_hash = target.exists().then(|| hash_content(before.as_bytes()));
    changes.push(FileChange {
        target,
        scope,
        original_hash,
        before,
        after,
        risk,
        validator: validator.into(),
    });
    Ok(())
}

fn managed_markdown(existing: &str, generated: &str) -> String {
    if !existing.contains(START) && existing.trim() == generated.trim() {
        return format!("{START}\n{}\n{END}\n", generated.trim());
    }
    replace_managed(
        existing,
        START,
        END,
        &format!("{START}\n{}\n{END}", generated.trim()),
    )
}

fn replace_managed(existing: &str, start: &str, end: &str, block: &str) -> String {
    if let (Some(a), Some(b)) = (existing.find(start), existing.find(end)) {
        let after_end = b + end.len();
        return format!("{}{}{}", &existing[..a], block, &existing[after_end..]);
    }
    if existing.trim().is_empty() {
        format!("{block}\n")
    } else {
        format!("{}\n\n{block}\n", existing.trim_end())
    }
}

fn targeted(connection: &ConnectionDefinition, agent: AgentKind) -> bool {
    connection.targets.is_empty() || connection.targets.contains(&agent)
}

fn merge_codex_config(path: &Path, connections: &[ConnectionDefinition]) -> Result<String> {
    let existing = fs::read_to_string(path).unwrap_or_default();
    if !existing.contains(TOML_START) {
        for connection in connections
            .iter()
            .filter(|value| targeted(value, AgentKind::Codex))
        {
            let table = format!("[mcp_servers.{}]", safe_key(&connection.name));
            if existing.lines().any(|line| line.trim() == table) {
                anyhow::bail!(
                    "Codex 配置已存在未受 AgentKib 管理的同名 MCP：{}。为避免覆盖平台专属字段，请先重命名其中一方或手动迁移到 AgentKib。",
                    connection.name
                );
            }
        }
    }
    let mut block = String::new();
    block.push_str(TOML_START);
    block.push('\n');
    for connection in connections
        .iter()
        .filter(|value| targeted(value, AgentKind::Codex))
    {
        block.push_str(&format!("[mcp_servers.{}]\n", safe_key(&connection.name)));
        match &connection.transport {
            ConnectionTransport::Stdio { command, args } => {
                block.push_str(&format!("command = {}\n", toml_string(command)));
                block.push_str(&format!(
                    "args = {}\n",
                    serde_json::to_string(args).unwrap_or_else(|_| "[]".into())
                ));
            }
            ConnectionTransport::Http { url } => {
                block.push_str(&format!("url = {}\n", toml_string(url)))
            }
        }
        if !connection.allow_tools.is_empty() {
            block.push_str(&format!(
                "enabled_tools = {}\n",
                serde_json::to_string(&connection.allow_tools).unwrap_or_else(|_| "[]".into())
            ));
        }
        block.push('\n');
    }
    block.push_str(TOML_END);
    Ok(replace_managed(&existing, TOML_START, TOML_END, &block))
}

fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}
fn safe_key(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn merge_claude_mcp(path: &Path, connections: &[ConnectionDefinition]) -> Result<String> {
    let mut root = read_json_object(path)?;
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| JsonValue::Object(JsonMap::new()))
        .as_object_mut()
        .context(".mcp.json 的 mcpServers 必须是对象")?;
    for connection in connections
        .iter()
        .filter(|value| targeted(value, AgentKind::ClaudeCode))
    {
        merge_json_server(servers, connection);
    }
    Ok(format!("{}\n", serde_json::to_string_pretty(&root)?))
}

fn merge_openclaw(path: &Path, connections: &[ConnectionDefinition]) -> Result<String> {
    let mut root = read_json_object(path)?;
    let mcp = root
        .entry("mcp")
        .or_insert_with(|| JsonValue::Object(JsonMap::new()))
        .as_object_mut()
        .context("OpenClaw mcp 必须是对象")?;
    let servers = mcp
        .entry("servers")
        .or_insert_with(|| JsonValue::Object(JsonMap::new()))
        .as_object_mut()
        .context("OpenClaw mcp.servers 必须是对象")?;
    for connection in connections
        .iter()
        .filter(|value| targeted(value, AgentKind::OpenClaw))
    {
        merge_json_server(servers, connection);
    }
    Ok(format!("{}\n", serde_json::to_string_pretty(&root)?))
}

fn merge_json_server(servers: &mut JsonMap<String, JsonValue>, connection: &ConnectionDefinition) {
    let generated = connection_json(connection);
    let existing = servers
        .entry(connection.name.clone())
        .or_insert_with(|| JsonValue::Object(JsonMap::new()));
    if let (Some(existing), Some(generated)) = (existing.as_object_mut(), generated.as_object()) {
        for (key, value) in generated {
            existing.insert(key.clone(), value.clone());
        }
    } else {
        *existing = generated;
    }
}

fn connection_json(connection: &ConnectionDefinition) -> JsonValue {
    let mut value = JsonMap::new();
    match &connection.transport {
        ConnectionTransport::Stdio { command, args } => {
            value.insert("command".into(), command.clone().into());
            value.insert("args".into(), serde_json::json!(args));
        }
        ConnectionTransport::Http { url } => {
            value.insert("url".into(), url.clone().into());
        }
    }
    if !connection.env.is_empty() {
        value.insert("env".into(), serde_json::json!(connection.env));
    }
    if !connection.allow_tools.is_empty() {
        value.insert(
            "tools".into(),
            serde_json::json!({ "include": connection.allow_tools }),
        );
    }
    JsonValue::Object(value)
}

fn read_json_object(path: &Path) -> Result<JsonMap<String, JsonValue>> {
    let content = fs::read_to_string(path).unwrap_or_else(|_| "{}".into());
    let value: JsonValue =
        serde_json::from_str(&content).with_context(|| format!("JSON 无效：{}", path.display()))?;
    value.as_object().cloned().context("JSON 根节点必须是对象")
}

fn merge_hermes(path: &Path, project: &Path, manifest: &Manifest) -> Result<String> {
    let content = fs::read_to_string(path).unwrap_or_else(|_| "{}".into());
    let mut root: serde_yaml::Mapping =
        serde_yaml::from_str(&content).with_context(|| format!("YAML 无效：{}", path.display()))?;
    let servers_key = serde_yaml::Value::String("mcp_servers".into());
    let servers = root
        .entry(servers_key)
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()))
        .as_mapping_mut()
        .context("Hermes mcp_servers 必须是对象")?;
    for connection in manifest
        .connections
        .iter()
        .filter(|value| targeted(value, AgentKind::Hermes))
    {
        servers.insert(
            serde_yaml::Value::String(connection.name.clone()),
            serde_yaml::to_value(connection_json(connection))?,
        );
    }
    let skills_key = serde_yaml::Value::String("external_skill_dirs".into());
    let skills = root
        .entry(skills_key)
        .or_insert_with(|| serde_yaml::Value::Sequence(Vec::new()))
        .as_sequence_mut()
        .context("Hermes external_skill_dirs 必须是数组")?;
    let shared = serde_yaml::Value::String(project.join(".agents/skills").display().to_string());
    if !skills.contains(&shared) {
        skills.push(shared);
    }
    Ok(serde_yaml::to_string(&root)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn preserves_unmanaged_markdown() {
        let existing = "# User content\n";
        let first = managed_markdown(existing, "Shared");
        let second = managed_markdown(&first, "Updated");
        assert!(second.contains("# User content"));
        assert!(second.contains("Updated"));
        assert!(!second.contains("Shared\n"));
    }

    #[test]
    fn first_import_wraps_matching_content_without_duplication() {
        let output = managed_markdown("# Shared\n", "# Shared");
        assert_eq!(output.matches("# Shared").count(), 1);
        assert!(output.contains(START));
    }

    #[test]
    fn first_import_separates_platform_overrides() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("AGENTS.md"), "Shared rules\n").unwrap();
        fs::write(
            dir.path().join("CLAUDE.md"),
            "@AGENTS.md\n\nUse Claude-specific tools.\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("AGENTS.override.md"),
            "Shared rules\n\nUse Codex sandbox.\n",
        )
        .unwrap();
        fs::write(dir.path().join("HERMES.md"), "Hermes project rule.\n").unwrap();

        let manifest = default_manifest(dir.path()).unwrap();
        assert_eq!(manifest.instructions.shared, "Shared rules\n");
        assert_eq!(
            manifest.instructions.platform_overrides[&AgentKind::ClaudeCode],
            "Use Claude-specific tools."
        );
        assert_eq!(
            manifest.instructions.platform_overrides[&AgentKind::Codex],
            "Use Codex sandbox."
        );
        assert_eq!(
            manifest.instructions.platform_overrides[&AgentKind::Hermes],
            "Hermes project rule."
        );
    }

    #[test]
    fn first_import_discovers_nested_agents_rules() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("AGENTS.md"), "Root rules\n").unwrap();
        fs::create_dir_all(dir.path().join("packages/api")).unwrap();
        fs::write(
            dir.path().join("packages/api/AGENTS.md"),
            "API package rules\n",
        )
        .unwrap();

        let manifest = default_manifest(dir.path()).unwrap();
        assert_eq!(manifest.instructions.scoped.len(), 1);
        assert_eq!(manifest.instructions.scoped[0].path, "packages/api");
        assert_eq!(
            manifest.instructions.scoped[0].content,
            "API package rules\n"
        );
    }

    #[test]
    fn plan_contains_all_project_adapters() {
        let dir = tempdir().unwrap();
        let manifest = default_manifest(dir.path()).unwrap();
        let plan = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();
        let names: Vec<_> = plan
            .changes
            .iter()
            .filter_map(|c| c.target.file_name()?.to_str())
            .collect();
        assert!(names.contains(&"AGENTS.md"));
        assert!(names.contains(&"CLAUDE.md"));
        assert!(names.contains(&"config.toml"));
        assert!(names.contains(&".mcp.json"));
    }

    #[test]
    fn hermes_merge_preserves_unknown_fields_and_existing_entries() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("config.yaml");
        fs::write(&config, "theme: dark\nmcp_servers:\n  custom:\n    command: custom\nexternal_skill_dirs:\n  - /existing/skills\n").unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest.connections.push(ConnectionDefinition {
            name: "agentkib".into(),
            transport: ConnectionTransport::Stdio {
                command: "/bin/agentkib-mcp".into(),
                args: vec![],
            },
            env: BTreeMap::new(),
            allow_tools: vec![],
            targets: vec![AgentKind::Hermes],
        });
        let merged = merge_hermes(&config, dir.path(), &manifest).unwrap();
        assert!(merged.contains("theme: dark"));
        assert!(merged.contains("custom:"));
        assert!(merged.contains("/existing/skills"));
        assert!(merged.contains("agentkib:"));
    }

    #[test]
    fn claude_merge_preserves_unknown_server_fields() {
        let dir = tempdir().unwrap();
        let config = dir.path().join(".mcp.json");
        fs::write(
            &config,
            r#"{"mcpServers":{"agentkib":{"command":"old","platformOnly":true}},"topLevel":7}"#,
        )
        .unwrap();
        let connection = ConnectionDefinition {
            name: "agentkib".into(),
            transport: ConnectionTransport::Stdio {
                command: "/new".into(),
                args: vec![],
            },
            env: BTreeMap::new(),
            allow_tools: vec![],
            targets: vec![AgentKind::ClaudeCode],
        };
        let merged = merge_claude_mcp(&config, &[connection]).unwrap();
        let value: JsonValue = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["topLevel"], 7);
        assert_eq!(value["mcpServers"]["agentkib"]["platformOnly"], true);
        assert_eq!(value["mcpServers"]["agentkib"]["command"], "/new");
    }

    #[test]
    fn openclaw_merge_preserves_unknown_fields() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("openclaw.json");
        fs::write(
            &config,
            r#"{"theme":"dark","mcp":{"servers":{"agentkib":{"command":"old","platformOnly":true}}}}"#,
        )
        .unwrap();
        let connection = ConnectionDefinition {
            name: "agentkib".into(),
            transport: ConnectionTransport::Stdio {
                command: "/new".into(),
                args: vec![],
            },
            env: BTreeMap::new(),
            allow_tools: vec![],
            targets: vec![AgentKind::OpenClaw],
        };
        let merged = merge_openclaw(&config, &[connection]).unwrap();
        let value: JsonValue = serde_json::from_str(&merged).unwrap();
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["mcp"]["servers"]["agentkib"]["platformOnly"], true);
        assert_eq!(value["mcp"]["servers"]["agentkib"]["command"], "/new");
    }

    #[test]
    fn codex_duplicate_unmanaged_mcp_is_reported_without_rewriting() {
        let dir = tempdir().unwrap();
        let config = dir.path().join("config.toml");
        fs::write(
            &config,
            "theme = \"dark\"\n\n[mcp_servers.agentkib]\ncommand = \"custom\"\nplatform_only = true\n",
        )
        .unwrap();
        let connection = ConnectionDefinition {
            name: "agentkib".into(),
            transport: ConnectionTransport::Stdio {
                command: "/new".into(),
                args: vec![],
            },
            env: BTreeMap::new(),
            allow_tools: vec![],
            targets: vec![AgentKind::Codex],
        };

        let error = merge_codex_config(&config, &[connection]).unwrap_err();
        assert!(error.to_string().contains("未受 AgentKib 管理的同名 MCP"));
        assert!(
            fs::read_to_string(config)
                .unwrap()
                .contains("platform_only = true")
        );
    }

    #[test]
    fn copies_complete_skill_directory_to_claude() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("shared/reviewer");
        fs::create_dir_all(source.join("references")).unwrap();
        fs::write(source.join("SKILL.md"), "# Reviewer").unwrap();
        fs::write(source.join("references/checklist.md"), "- Run tests").unwrap();
        let mut manifest = default_manifest(dir.path()).unwrap();
        manifest.skills.push(agentkib_core::SkillDefinition {
            name: "reviewer".into(),
            path: "shared/reviewer".into(),
            targets: vec![AgentKind::ClaudeCode],
        });

        let plan = plan_workspace_changes(dir.path(), &manifest, &HomeTargets::default()).unwrap();
        assert!(plan.changes.iter().any(|change| {
            change.target.ends_with(".claude/skills/reviewer/SKILL.md")
                && change.after == "# Reviewer"
        }));
        assert!(plan.changes.iter().any(|change| {
            change
                .target
                .ends_with(".claude/skills/reviewer/references/checklist.md")
                && change.after == "- Run tests"
        }));
    }
}
