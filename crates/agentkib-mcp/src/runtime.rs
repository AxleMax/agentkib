use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use agentkib_core::{
    McpRuntimeState, McpRuntimeStatus, McpServerConfig, McpServerTransport, McpToolDescriptor,
};
use anyhow::{Context, Result, bail};
use chrono::Utc;
use http::{HeaderName, HeaderValue};
use rmcp::model::{CallToolRequestParams, CallToolResult, Tool};
use rmcp::service::{Peer, RoleClient, RunningService, ServiceExt};
use rmcp::transport::{
    ConfigureCommandExt, StreamableHttpClientTransport, TokioChildProcess,
    streamable_http_client::StreamableHttpClientTransportConfig,
};
use tokio::sync::{Mutex, RwLock};

use crate::config::config_hash;

type FailureWindow = HashMap<String, (u8, chrono::DateTime<Utc>)>;

#[derive(Clone)]
pub struct RuntimeManager {
    instances: Arc<RwLock<HashMap<String, Arc<RuntimeInstance>>>>,
    statuses: Arc<RwLock<HashMap<String, McpRuntimeStatus>>>,
    start_lock: Arc<Mutex<()>>,
    failures: Arc<Mutex<FailureWindow>>,
}

struct RuntimeInstance {
    peer: Peer<RoleClient>,
    call_lock: Mutex<()>,
    parallel: bool,
    service: Mutex<Option<RunningService<RoleClient, ()>>>,
}

impl RuntimeManager {
    pub fn new() -> Self {
        Self {
            instances: Arc::new(RwLock::new(HashMap::new())),
            statuses: Arc::new(RwLock::new(HashMap::new())),
            start_lock: Arc::new(Mutex::new(())),
            failures: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn statuses(&self) -> Vec<McpRuntimeStatus> {
        let mut values: Vec<_> = self.statuses.read().await.values().cloned().collect();
        values.sort_by(|left, right| left.server_name.cmp(&right.server_name));
        values
    }

    pub async fn probe(&self, server: &McpServerConfig) -> Result<Vec<McpToolDescriptor>> {
        let instance = self.instance(server).await?;
        let tools = instance.peer.list_all_tools().await?;
        let tools: Vec<_> = tools
            .into_iter()
            .filter(|tool| {
                server.allow_tools.is_empty()
                    || server
                        .allow_tools
                        .iter()
                        .any(|name| name == tool.name.as_ref())
            })
            .map(|tool| McpToolDescriptor {
                server_id: server.id.clone(),
                name: tool.name.to_string(),
                description: tool.description.map(|value| value.to_string()),
                input_schema: serde_json::Value::Object((*tool.input_schema).clone()),
                read_only: tool
                    .annotations
                    .as_ref()
                    .and_then(|value| value.read_only_hint)
                    .unwrap_or(false),
            })
            .collect();
        agentkib_store::Store::open_default()?.replace_mcp_tool_cache(&server.id, &tools)?;
        Ok(tools)
    }

    pub fn cached_tools(&self, server: &McpServerConfig) -> Result<Vec<Tool>> {
        agentkib_store::Store::open_default()?
            .cached_mcp_tools(&server.id)?
            .into_iter()
            .map(|tool| {
                serde_json::from_value(serde_json::json!({
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": tool.input_schema,
                    "annotations": {"readOnlyHint": tool.read_only}
                }))
                .map_err(Into::into)
            })
            .collect()
    }

    pub async fn call(
        &self,
        server: &McpServerConfig,
        tool_name: &str,
        arguments: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<CallToolResult> {
        let hash = config_hash(server)?;
        let instance = self.instance(server).await?;
        let call = || async {
            instance
                .peer
                .call_tool(
                    CallToolRequestParams::new(tool_name.to_string())
                        .with_arguments(arguments.unwrap_or_default()),
                )
                .await
                .map_err(anyhow::Error::from)
        };
        let result = if instance.parallel {
            call().await
        } else {
            let _guard = instance.call_lock.lock().await;
            call().await
        };
        if let Some(status) = self.statuses.write().await.get_mut(&hash) {
            status.last_used_at = Some(Utc::now());
            if let Err(error) = &result {
                status.state = McpRuntimeState::Error;
                status.error = Some(redact_error(error, server));
            }
        }
        if result.is_err()
            && let Some(instance) = self.instances.write().await.remove(&hash)
            && let Some(service) = instance.service.lock().await.take()
        {
            let _ = service.cancel().await;
        }
        if result.is_err() {
            record_failure(&self.failures, &hash).await;
        }
        result
    }

    pub async fn reap_idle(&self, idle_for: chrono::Duration) {
        let cutoff = Utc::now() - idle_for;
        let stale: Vec<_> = self
            .statuses
            .read()
            .await
            .iter()
            .filter(|(_, status)| status.last_used_at.is_some_and(|last| last < cutoff))
            .map(|(hash, _)| hash.clone())
            .collect();
        let mut instances = self.instances.write().await;
        for hash in stale {
            if let Some(instance) = instances.remove(&hash)
                && let Some(service) = instance.service.lock().await.take()
            {
                let _ = service.cancel().await;
            }
            if let Some(status) = self.statuses.write().await.get_mut(&hash) {
                status.state = McpRuntimeState::Stopped;
            }
        }
    }

    pub async fn stop(&self, server_id: Option<&str>) {
        let statuses = self.statuses.read().await.clone();
        let mut instances = self.instances.write().await;
        let keys: Vec<_> = instances
            .keys()
            .filter(|hash| {
                server_id.is_none_or(|id| {
                    statuses
                        .get(*hash)
                        .is_some_and(|status| status.server_id == id)
                })
            })
            .cloned()
            .collect();
        for key in keys {
            if let Some(instance) = instances.remove(&key)
                && let Some(service) = instance.service.lock().await.take()
            {
                let _ = service.cancel().await;
            }
            if let Some(status) = self.statuses.write().await.get_mut(&key) {
                status.state = McpRuntimeState::Stopped;
            }
            self.failures.lock().await.remove(&key);
        }
    }

    async fn instance(&self, server: &McpServerConfig) -> Result<Arc<RuntimeInstance>> {
        let hash = config_hash(server)?;
        if let Some(instance) = self.instances.read().await.get(&hash) {
            return Ok(instance.clone());
        }
        if restart_limit_reached(&self.failures, &hash).await {
            bail!("MCP server restart limit reached; restart it explicitly from AgentKib");
        }
        // The second check after acquiring the lock prevents concurrent Agents from
        // launching duplicate child processes for the same effective configuration.
        let _start_guard = self.start_lock.lock().await;
        if let Some(instance) = self.instances.read().await.get(&hash) {
            return Ok(instance.clone());
        }
        self.statuses.write().await.insert(
            hash.clone(),
            McpRuntimeStatus {
                server_id: server.id.clone(),
                server_name: server.name.clone(),
                config_hash: hash.clone(),
                state: McpRuntimeState::Starting,
                started_at: None,
                last_used_at: None,
                error: None,
            },
        );
        let instance = match start_instance(server).await {
            Ok(instance) => instance,
            Err(error) => {
                record_failure(&self.failures, &hash).await;
                if let Some(status) = self.statuses.write().await.get_mut(&hash) {
                    status.state = McpRuntimeState::Error;
                    status.error = Some(redact_error(&error, server));
                }
                return Err(error);
            }
        };
        let instance = Arc::new(instance);
        self.failures.lock().await.remove(&hash);
        self.instances
            .write()
            .await
            .insert(hash.clone(), instance.clone());
        if let Some(status) = self.statuses.write().await.get_mut(&hash) {
            status.state = McpRuntimeState::Running;
            status.started_at = Some(Utc::now());
            status.last_used_at = Some(Utc::now());
        }
        Ok(instance)
    }
}

async fn record_failure(failures: &Mutex<FailureWindow>, hash: &str) {
    let now = Utc::now();
    let mut failures = failures.lock().await;
    let entry = failures.entry(hash.to_string()).or_insert((0, now));
    if now - entry.1 > chrono::Duration::minutes(5) {
        *entry = (1, now);
    } else {
        entry.0 = entry.0.saturating_add(1);
    }
}

async fn restart_limit_reached(failures: &Mutex<FailureWindow>, hash: &str) -> bool {
    failures
        .lock()
        .await
        .get(hash)
        .is_some_and(|(count, since)| {
            *count >= 3 && Utc::now() - *since <= chrono::Duration::minutes(5)
        })
}

async fn start_instance(server: &McpServerConfig) -> Result<RuntimeInstance> {
    match &server.transport {
        McpServerTransport::Stdio { command, args, cwd } => {
            let mut process = tokio::process::Command::new(command);
            process.args(args);
            if let Some(cwd) = cwd {
                process.current_dir(cwd);
            }
            process.envs(&server.env);
            let transport = TokioChildProcess::new(process.configure(|command| {
                command.kill_on_drop(true);
            }))?;
            let running = ().serve(transport).await?;
            let peer = running.peer().clone();
            Ok(RuntimeInstance {
                peer,
                call_lock: Mutex::new(()),
                parallel: server.supports_parallel_tool_calls,
                service: Mutex::new(Some(running)),
            })
        }
        McpServerTransport::StreamableHttp { url } => {
            let config = http_config(url, &server.headers)?;
            if server.oauth_credentials.is_some() {
                let client = crate::oauth::authorized_http_client(server).await?;
                let running =
                    ().serve(StreamableHttpClientTransport::with_client(client, config))
                        .await?;
                let peer = running.peer().clone();
                return Ok(RuntimeInstance {
                    peer,
                    call_lock: Mutex::new(()),
                    parallel: server.supports_parallel_tool_calls,
                    service: Mutex::new(Some(running)),
                });
            }
            let running = ().serve(StreamableHttpClientTransport::from_config(config)).await?;
            let peer = running.peer().clone();
            Ok(RuntimeInstance {
                peer,
                call_lock: Mutex::new(()),
                parallel: server.supports_parallel_tool_calls,
                service: Mutex::new(Some(running)),
            })
        }
        McpServerTransport::Sse { .. } => {
            bail!("Legacy SSE is import-only; migrate the server to Streamable HTTP")
        }
    }
}

fn http_config(
    url: &str,
    headers: &std::collections::BTreeMap<String, String>,
) -> Result<StreamableHttpClientTransportConfig> {
    let mut custom_headers = HashMap::new();
    let mut bearer = None;
    for (name, value) in headers {
        if name.eq_ignore_ascii_case("authorization")
            && let Some(value) = value.strip_prefix("Bearer ")
        {
            bearer = Some(value.to_string());
            continue;
        }
        custom_headers.insert(
            HeaderName::try_from(name.as_str()).context("Invalid MCP HTTP header name")?,
            HeaderValue::try_from(value.as_str()).context("Invalid MCP HTTP header value")?,
        );
    }
    let mut config = StreamableHttpClientTransportConfig::with_uri(url.to_string())
        .custom_headers(custom_headers)
        .reinit_on_expired_session(true);
    if let Some(bearer) = bearer {
        config = config.auth_header(bearer);
    }
    Ok(config)
}

fn redact_error(error: &impl std::fmt::Display, server: &McpServerConfig) -> String {
    let mut value = error.to_string();
    for secret in server.env.values().chain(server.headers.values()) {
        if !secret.is_empty() {
            value = value.replace(secret, "[redacted]");
        }
    }
    if value.len() > 1_024 {
        format!("{}…", &value[..1_024])
    } else {
        value
    }
}

pub fn installation_root() -> Result<PathBuf> {
    Ok(agentkib_store::default_data_dir()?.join("mcp/packages"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_errors_do_not_expose_configured_secrets() {
        let mut server = McpServerConfig {
            id: "private".into(),
            name: "Private".into(),
            enabled: true,
            transport: McpServerTransport::StreamableHttp {
                url: "https://example.com/mcp".into(),
            },
            env: Default::default(),
            headers: Default::default(),
            oauth_credentials: None,
            local_config_path: None,
            targets: Vec::new(),
            allow_tools: Vec::new(),
            lan_allow_tools: Vec::new(),
            supports_parallel_tool_calls: false,
            package: None,
        };
        server.env.insert("TOKEN".into(), "super-secret".into());
        let error = anyhow::anyhow!("server rejected super-secret");
        let redacted = redact_error(&error, &server);
        assert!(!redacted.contains("super-secret"));
        assert!(redacted.contains("[redacted]"));
    }
}
