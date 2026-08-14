use std::path::{Path, PathBuf};

use agentkib_core::{
    AgentKind, AssetKind, MemoryProposal, MemoryStatus, MemoryType, load_manifest, resolve_context,
    scan_workspace,
};
use agentkib_platform::path::{canonicalize, equivalent};
use agentkib_store::Store;
use anyhow::{Context, Result, bail};
use rmcp::model::{CallToolResult, ContentBlock, Tool};
use serde_json::{Value, json};

pub const BUILTIN_TOOL_NAMES: [&str; 6] = [
    "workspace_get_context",
    "asset_list",
    "asset_get",
    "skill_list",
    "memory_search",
    "memory_propose",
];

pub fn definitions() -> Vec<Tool> {
    vec![
        tool(
            "workspace_get_context",
            "Resolve the effective Agent context for this workspace",
            json!({"type":"object","properties":{"cwd":{"type":"string"}}}),
        ),
        tool(
            "asset_list",
            "List governed Agent assets in this workspace",
            json!({"type":"object","properties":{}}),
        ),
        tool(
            "asset_get",
            "Read one text asset from the governed workspace asset inventory",
            json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
        ),
        tool(
            "skill_list",
            "List shared Skills visible in this workspace",
            json!({"type":"object","properties":{}}),
        ),
        tool(
            "memory_search",
            "Search user-approved shared memories",
            json!({"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":50}},"required":["query"]}),
        ),
        tool(
            "memory_propose",
            "Propose a memory for user review; this never approves it",
            json!({"type":"object","properties":{"type":{"type":"string","enum":["user_preference","project_fact","decision","constraint","failed_attempt","open_loop","task_state","agent_observation"]},"content":{"type":"string"},"source_thread":{"type":"string"},"source_reference":{"type":"string"}},"required":["type","content"]}),
        ),
    ]
}

pub fn call(project: &Path, agent: AgentKind, name: &str, args: &Value) -> Result<CallToolResult> {
    let store = Store::open_default()?;
    let manifest = load_manifest(project)?;
    let payload = match name {
        "workspace_get_context" => {
            let cwd = args
                .get("cwd")
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .unwrap_or_else(|| project.to_path_buf());
            let memories = store
                .list_memories(&manifest.workspace.id, Some(MemoryStatus::Approved))?
                .into_iter()
                .map(|value| value.content)
                .collect();
            let mut context = resolve_context(project, &cwd, agent, Some(&manifest), memories)?;
            context.visible_connections =
                crate::config::load_visible_servers(Some(project), agent)?
                    .into_iter()
                    .map(|server| server.name)
                    .collect();
            serde_json::to_value(context)?
        }
        "asset_list" => serde_json::to_value(scan_workspace(project)?.assets)?,
        "asset_get" => {
            let requested = project.join(
                args.get("path")
                    .and_then(Value::as_str)
                    .context("Missing asset path")?,
            );
            let requested = canonicalize(&requested)?;
            let scan = scan_workspace(project)?;
            if !scan.assets.iter().any(|asset| {
                equivalent(&asset.path, &requested) && !matches!(asset.kind, AssetKind::Memory)
            }) {
                bail!("The requested path is not in the readable asset inventory");
            }
            let content = std::fs::read_to_string(&requested)?;
            if content.len() > 256 * 1024 {
                bail!("Asset exceeds the 256 KiB limit");
            }
            json!({"path":requested,"content":content})
        }
        "skill_list" => serde_json::to_value(manifest.skills)?,
        "memory_search" => {
            let query = args.get("query").and_then(Value::as_str).unwrap_or("");
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(10)
                .clamp(1, 50) as usize;
            serde_json::to_value(store.search_approved(&manifest.workspace.id, query, limit)?)?
        }
        "memory_propose" => {
            let record = store.propose_memory(&MemoryProposal {
                project_id: manifest.workspace.id,
                memory_type: parse_memory_type(
                    args.get("type")
                        .and_then(Value::as_str)
                        .context("Missing memory type")?,
                )?,
                content: args
                    .get("content")
                    .and_then(Value::as_str)
                    .context("Missing memory content")?
                    .into(),
                source_agent: Some(agent.as_str().into()),
                source_thread: args
                    .get("source_thread")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                source_reference: args
                    .get("source_reference")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })?;
            serde_json::to_value(record)?
        }
        _ => bail!("Unknown built-in tool: {name}"),
    };
    Ok(CallToolResult::structured(payload))
}

fn tool(name: &str, description: &str, input_schema: Value) -> Tool {
    serde_json::from_value(json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
        "annotations": {"readOnlyHint": name != "memory_propose"}
    }))
    .expect("built-in MCP tool definitions are valid")
}

fn parse_memory_type(value: &str) -> Result<MemoryType> {
    match value {
        "user_preference" => Ok(MemoryType::UserPreference),
        "project_fact" => Ok(MemoryType::ProjectFact),
        "decision" => Ok(MemoryType::Decision),
        "constraint" => Ok(MemoryType::Constraint),
        "failed_attempt" => Ok(MemoryType::FailedAttempt),
        "open_loop" => Ok(MemoryType::OpenLoop),
        "task_state" => Ok(MemoryType::TaskState),
        "agent_observation" => Ok(MemoryType::AgentObservation),
        _ => bail!("Unknown memory type: {value}"),
    }
}

pub fn error_result(error: impl std::fmt::Display) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(error.to_string())])
}
