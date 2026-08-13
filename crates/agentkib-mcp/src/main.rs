use std::env;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};

use agentkib_core::{
    AgentKind, AssetKind, MemoryProposal, MemoryStatus, MemoryType, load_manifest, resolve_context,
    scan_workspace,
};
use agentkib_store::Store;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

fn main() {
    if let Err(error) = run() {
        eprintln!("agentkib-mcp: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let (project, db_path) = parse_args()?;
    let project = agentkib_core::canonical_project(&project)?;
    let store = match db_path {
        Some(path) => Store::open(&path)?,
        None => Store::open_default()?,
    };
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = serde_json::from_str(&line)?;
        if request.get("id").is_none() {
            continue;
        }
        let response = handle(&project, &store, &request).unwrap_or_else(|error| json!({"jsonrpc":"2.0","id":request.get("id").cloned().unwrap_or(Value::Null),"error":{"code":-32000,"message":error.to_string()}}));
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}

fn handle(project: &Path, store: &Store, request: &Value) -> Result<Value> {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .context("缺少 method")?;
    let result = match method {
        "initialize" => {
            json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"agentkib-mcp","version":env!("CARGO_PKG_VERSION")}})
        }
        "ping" => json!({}),
        "tools/list" => json!({"tools": tool_definitions()}),
        "tools/call" => {
            let params = request.get("params").context("缺少 params")?;
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .context("缺少工具名称")?;
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let payload = call_tool(project, store, name, &arguments)?;
            json!({"content":[{"type":"text","text":serde_json::to_string_pretty(&payload)?}],"isError":false})
        }
        _ => bail!("不支持的方法：{method}"),
    };
    Ok(json!({"jsonrpc":"2.0","id":id,"result":result}))
}

fn tool_definitions() -> Vec<Value> {
    vec![
        tool(
            "workspace_get_context",
            "获取指定 Agent 在项目目录中的有效上下文",
            json!({"type":"object","properties":{"agent":{"type":"string","enum":["codex","claude-code","openclaw","hermes"]},"cwd":{"type":"string"}},"required":["agent"]}),
        ),
        tool(
            "asset_list",
            "列出项目中的 Agent 资产",
            json!({"type":"object","properties":{}}),
        ),
        tool(
            "asset_get",
            "读取扫描清单中的单个文本资产",
            json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}),
        ),
        tool(
            "skill_list",
            "列出公共 Skills",
            json!({"type":"object","properties":{}}),
        ),
        tool(
            "memory_search",
            "搜索经用户批准的共享记忆",
            json!({"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":50}},"required":["query"]}),
        ),
        tool(
            "memory_propose",
            "向记忆收件箱提交一条待审批记忆",
            json!({"type":"object","properties":{"type":{"type":"string","enum":["user_preference","project_fact","decision","constraint","failed_attempt","open_loop","task_state","agent_observation"]},"content":{"type":"string"},"source_thread":{"type":"string"},"source_reference":{"type":"string"}},"required":["type","content"]}),
        ),
    ]
}

fn tool(name: &str, description: &str, schema: Value) -> Value {
    json!({"name":name,"description":description,"inputSchema":schema})
}

fn call_tool(project: &Path, store: &Store, name: &str, args: &Value) -> Result<Value> {
    let manifest = load_manifest(project)?;
    match name {
        "workspace_get_context" => {
            let agent = parse_agent(
                args.get("agent")
                    .and_then(Value::as_str)
                    .context("缺少 agent")?,
            )?;
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
            Ok(serde_json::to_value(resolve_context(
                project,
                &cwd,
                agent,
                Some(&manifest),
                memories,
            )?)?)
        }
        "asset_list" => Ok(serde_json::to_value(scan_workspace(project)?.assets)?),
        "asset_get" => {
            let requested = project.join(
                args.get("path")
                    .and_then(Value::as_str)
                    .context("缺少 path")?,
            );
            let requested = requested.canonicalize()?;
            let scan = scan_workspace(project)?;
            if !scan
                .assets
                .iter()
                .any(|asset| asset.path == requested && !matches!(asset.kind, AssetKind::Memory))
            {
                bail!("该路径不在可读取资产清单中");
            }
            let content = std::fs::read_to_string(&requested)?;
            if content.len() > 256 * 1024 {
                bail!("资产超过 256 KiB 限制");
            }
            Ok(json!({"path":requested,"content":content}))
        }
        "skill_list" => Ok(serde_json::to_value(manifest.skills)?),
        "memory_search" => {
            let query = args.get("query").and_then(Value::as_str).unwrap_or("");
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(10)
                .clamp(1, 50) as usize;
            Ok(serde_json::to_value(store.search_approved(
                &manifest.workspace.id,
                query,
                limit,
            )?)?)
        }
        "memory_propose" => {
            let memory_type = parse_memory_type(
                args.get("type")
                    .and_then(Value::as_str)
                    .context("缺少 type")?,
            )?;
            let record = store.propose_memory(&MemoryProposal {
                project_id: manifest.workspace.id,
                memory_type,
                content: args
                    .get("content")
                    .and_then(Value::as_str)
                    .context("缺少 content")?
                    .into(),
                source_agent: Some("mcp-client".into()),
                source_thread: args
                    .get("source_thread")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                source_reference: args
                    .get("source_reference")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })?;
            Ok(serde_json::to_value(record)?)
        }
        _ => bail!("未知工具：{name}"),
    }
}

fn parse_args() -> Result<(PathBuf, Option<PathBuf>)> {
    let args: Vec<String> = env::args().skip(1).collect();
    let project_index = args
        .iter()
        .position(|value| value == "--project")
        .context("必须提供 --project <path>")?;
    let project = PathBuf::from(args.get(project_index + 1).context("--project 缺少路径")?);
    let db = args
        .iter()
        .position(|value| value == "--db")
        .and_then(|index| args.get(index + 1))
        .map(PathBuf::from);
    Ok((project, db))
}

fn parse_agent(value: &str) -> Result<AgentKind> {
    match value {
        "codex" => Ok(AgentKind::Codex),
        "claude-code" => Ok(AgentKind::ClaudeCode),
        "openclaw" => Ok(AgentKind::OpenClaw),
        "hermes" => Ok(AgentKind::Hermes),
        _ => bail!("未知 Agent：{value}"),
    }
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
        _ => bail!("未知记忆类型：{value}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fixture() -> (tempfile::TempDir, Store) {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".agentkib")).unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "shared rules").unwrap();
        std::fs::write(
            dir.path().join(".agentkib/manifest.yaml"),
            "schema_version: 1\nworkspace:\n  id: fixture\n  name: fixture\n",
        )
        .unwrap();
        let store = Store::open(&dir.path().join("memory.db")).unwrap();
        (dir, store)
    }

    #[test]
    fn initializes_and_lists_exact_mvp_tools() {
        let (dir, store) = fixture();
        let initialize = handle(
            dir.path(),
            &store,
            &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
        )
        .unwrap();
        assert_eq!(initialize["result"]["serverInfo"]["name"], "agentkib-mcp");
        let listed = handle(
            dir.path(),
            &store,
            &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        )
        .unwrap();
        assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 6);
    }

    #[test]
    fn context_query_and_memory_proposal_work_without_desktop_state() {
        let (dir, store) = fixture();
        let context = handle(dir.path(), &store, &json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"workspace_get_context","arguments":{"agent":"codex"}}})).unwrap();
        assert!(
            context["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("shared rules")
        );
        handle(dir.path(), &store, &json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_propose","arguments":{"type":"decision","content":"Use SQLite"}}})).unwrap();
        assert_eq!(
            store
                .list("fixture", Some(MemoryStatus::Pending))
                .unwrap()
                .len(),
            1
        );
        assert!(store.search("fixture", "SQLite", 10).unwrap().is_empty());
    }
}
