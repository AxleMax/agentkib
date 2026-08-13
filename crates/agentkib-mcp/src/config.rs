use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use agentkib_core::{AgentKind, McpConfigDocument, McpServerConfig};
use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};

pub const GLOBAL_CONFIG_NAME: &str = "mcp.json";
pub const LOCAL_CONFIG_NAME: &str = "mcp.local.json";

pub fn global_config_dir() -> Result<PathBuf> {
    Ok(dirs::home_dir()
        .context("Unable to resolve the user home directory")?
        .join(".agentkib"))
}

pub fn config_paths(project: Option<&Path>) -> Result<Vec<PathBuf>> {
    let global = global_config_dir()?;
    let mut paths = vec![
        global.join(GLOBAL_CONFIG_NAME),
        global.join(LOCAL_CONFIG_NAME),
    ];
    if let Some(project) = project {
        let directory = project.join(".agentkib");
        paths.push(directory.join(GLOBAL_CONFIG_NAME));
        paths.push(directory.join(LOCAL_CONFIG_NAME));
    }
    Ok(paths)
}

pub fn load_effective_config(project: Option<&Path>) -> Result<McpConfigDocument> {
    let paths = config_paths(project)?;
    let mut document = load_config_paths(&paths)?;
    let local_path = if project.is_some() {
        paths[3].clone()
    } else {
        paths[1].clone()
    };
    for server in &mut document.servers {
        server.local_config_path = Some(local_path.clone());
    }
    Ok(document)
}

fn load_config_paths(paths: &[PathBuf]) -> Result<McpConfigDocument> {
    let mut servers = BTreeMap::<String, McpServerConfig>::new();
    for path in paths {
        let document = read_document(path)?;
        for server in document.servers {
            if let Some(existing) = servers.get_mut(&server.id) {
                merge_server(existing, server);
            } else {
                servers.insert(server.id.clone(), server);
            }
        }
    }
    Ok(McpConfigDocument {
        schema_version: 1,
        servers: servers.into_values().collect(),
    })
}

pub fn load_visible_servers(
    project: Option<&Path>,
    agent: AgentKind,
) -> Result<Vec<McpServerConfig>> {
    Ok(load_effective_config(project)?
        .servers
        .into_iter()
        .filter(|server| {
            server.enabled && (server.targets.is_empty() || server.targets.contains(&agent))
        })
        .collect())
}

pub fn read_document(path: &Path) -> Result<McpConfigDocument> {
    if !path.is_file() {
        return Ok(McpConfigDocument::default());
    }
    let content = fs::read_to_string(path)
        .with_context(|| format!("Unable to read MCP config {}", path.display()))?;
    let value: McpConfigDocument = serde_json::from_str(&content)
        .with_context(|| format!("Invalid MCP JSON config {}", path.display()))?;
    validate_document_with_secrets(
        &value,
        path.file_name().and_then(|value| value.to_str()) == Some(LOCAL_CONFIG_NAME),
    )?;
    Ok(value)
}

pub fn save_document(path: &Path, document: &McpConfigDocument, private: bool) -> Result<()> {
    validate_document_with_secrets(document, private)?;
    let parent = path.parent().context("MCP config path has no parent")?;
    fs::create_dir_all(parent)?;
    let temp = path.with_extension("tmp");
    fs::write(
        &temp,
        format!("{}\n", serde_json::to_string_pretty(document)?),
    )?;
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&temp, path)?;
    if private {
        ensure_project_local_ignored(path)?;
    }
    Ok(())
}

pub fn save_server(path: &Path, server: McpServerConfig, private: bool) -> Result<()> {
    let mut document = read_document(path)?;
    if let Some(existing) = document
        .servers
        .iter_mut()
        .find(|value| value.id == server.id)
    {
        *existing = server;
    } else {
        document.servers.push(server);
        document
            .servers
            .sort_by(|left, right| left.name.cmp(&right.name));
    }
    save_document(path, &document, private)
}

pub fn remove_server(path: &Path, server_id: &str, private: bool) -> Result<()> {
    let mut document = read_document(path)?;
    document.servers.retain(|server| server.id != server_id);
    save_document(path, &document, private)
}

pub fn config_hash(server: &McpServerConfig) -> Result<String> {
    let bytes = serde_json::to_vec(server)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub fn masked_server(mut server: McpServerConfig) -> McpServerConfig {
    for value in server.env.values_mut().chain(server.headers.values_mut()) {
        if !value.is_empty() {
            *value = "••••••••".into();
        }
    }
    server.oauth_credentials = server
        .oauth_credentials
        .as_ref()
        .map(|_| serde_json::json!({ "status": "configured" }));
    server.local_config_path = None;
    server
}

pub fn validate_document(document: &McpConfigDocument) -> Result<()> {
    validate_document_with_secrets(document, false)
}

fn validate_document_with_secrets(document: &McpConfigDocument, allow_secrets: bool) -> Result<()> {
    if document.schema_version != 1 {
        bail!("Only MCP config schema_version 1 is supported");
    }
    let mut ids = BTreeSet::new();
    for server in &document.servers {
        if server.id.trim().is_empty() || server.name.trim().is_empty() {
            bail!("MCP server id and name cannot be empty");
        }
        if !ids.insert(&server.id) {
            bail!("Duplicate MCP server id: {}", server.id);
        }
        if !allow_secrets
            && (!server.env.is_empty()
                || !server.headers.is_empty()
                || server.oauth_credentials.is_some())
        {
            bail!("env and headers must be stored in mcp.local.json");
        }
        match &server.transport {
            agentkib_core::McpServerTransport::Stdio { command, .. }
                if command.trim().is_empty() =>
            {
                bail!("MCP stdio command cannot be empty")
            }
            agentkib_core::McpServerTransport::StreamableHttp { url }
            | agentkib_core::McpServerTransport::Sse { url }
                if !(url.starts_with("http://") || url.starts_with("https://")) =>
            {
                bail!("MCP HTTP URL is invalid")
            }
            _ => {}
        }
    }
    Ok(())
}

fn merge_server(base: &mut McpServerConfig, overlay: McpServerConfig) {
    base.name = overlay.name;
    base.enabled = overlay.enabled;
    base.transport = overlay.transport;
    base.supports_parallel_tool_calls = overlay.supports_parallel_tool_calls;
    if !overlay.targets.is_empty() {
        base.targets = overlay.targets;
    }
    if !overlay.allow_tools.is_empty() {
        base.allow_tools = overlay.allow_tools;
    }
    if !overlay.lan_allow_tools.is_empty() {
        base.lan_allow_tools = overlay.lan_allow_tools;
    }
    if overlay.package.is_some() {
        base.package = overlay.package;
    }
    base.env.extend(overlay.env);
    base.headers.extend(overlay.headers);
    if overlay.oauth_credentials.is_some() {
        base.oauth_credentials = overlay.oauth_credentials;
    }
}

fn ensure_project_local_ignored(path: &Path) -> Result<()> {
    if path.file_name().and_then(|value| value.to_str()) != Some(LOCAL_CONFIG_NAME) {
        return Ok(());
    }
    let Some(directory) = path.parent() else {
        return Ok(());
    };
    if directory.file_name().and_then(|value| value.to_str()) != Some(".agentkib") {
        return Ok(());
    }
    let ignore = directory.join(".gitignore");
    let existing = fs::read_to_string(&ignore).unwrap_or_default();
    if existing
        .lines()
        .any(|line| line.trim() == LOCAL_CONFIG_NAME)
    {
        return Ok(());
    }
    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(LOCAL_CONFIG_NAME);
    next.push('\n');
    fs::write(ignore, next)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentkib_core::McpServerTransport;
    use tempfile::tempdir;

    fn server(command: &str) -> McpServerConfig {
        McpServerConfig {
            id: "filesystem".into(),
            name: "Filesystem".into(),
            enabled: true,
            transport: McpServerTransport::Stdio {
                command: command.into(),
                args: vec![],
                cwd: None,
            },
            env: BTreeMap::new(),
            headers: BTreeMap::new(),
            oauth_credentials: None,
            local_config_path: None,
            targets: vec![],
            allow_tools: vec![],
            lan_allow_tools: vec![],
            supports_parallel_tool_calls: false,
            package: None,
        }
    }

    #[test]
    fn private_project_config_is_mode_600_and_gitignored() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".agentkib/mcp.local.json");
        save_document(
            &path,
            &McpConfigDocument {
                schema_version: 1,
                servers: vec![server("node")],
            },
            true,
        )
        .unwrap();
        assert!(
            fs::read_to_string(dir.path().join(".agentkib/.gitignore"))
                .unwrap()
                .contains("mcp.local.json")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn later_config_layers_override_and_extend_earlier_layers() {
        let dir = tempdir().unwrap();
        let paths = [
            dir.path().join("global/mcp.json"),
            dir.path().join("global/mcp.local.json"),
            dir.path().join("project/mcp.json"),
            dir.path().join("project/mcp.local.json"),
        ];
        let mut global = server("node");
        global.targets = vec![AgentKind::Codex];
        save_document(
            &paths[0],
            &McpConfigDocument {
                schema_version: 1,
                servers: vec![global],
            },
            false,
        )
        .unwrap();
        let mut global_local = server("node");
        global_local.env.insert("TOKEN".into(), "secret".into());
        save_document(
            &paths[1],
            &McpConfigDocument {
                schema_version: 1,
                servers: vec![global_local],
            },
            true,
        )
        .unwrap();
        let mut project = server("project-node");
        project.allow_tools = vec!["read".into()];
        save_document(
            &paths[2],
            &McpConfigDocument {
                schema_version: 1,
                servers: vec![project],
            },
            false,
        )
        .unwrap();
        let effective = load_config_paths(&paths).unwrap();
        assert_eq!(effective.servers.len(), 1);
        assert_eq!(effective.servers[0].name, "Filesystem");
        assert!(matches!(
            &effective.servers[0].transport,
            McpServerTransport::Stdio { command, .. } if command == "project-node"
        ));
        assert_eq!(effective.servers[0].env["TOKEN"], "secret");
        assert_eq!(effective.servers[0].allow_tools, ["read"]);
    }

    #[test]
    fn oauth_credentials_are_private_and_masked_from_callers() {
        let dir = tempdir().unwrap();
        let private = dir.path().join(".agentkib/mcp.local.json");
        let mut value = server("node");
        value.oauth_credentials = Some(serde_json::json!({
            "client_id": "client",
            "token_response": { "access_token": "do-not-return" }
        }));
        save_document(
            &private,
            &McpConfigDocument {
                schema_version: 1,
                servers: vec![value.clone()],
            },
            true,
        )
        .unwrap();
        assert!(
            save_document(
                &dir.path().join(".agentkib/mcp.json"),
                &McpConfigDocument {
                    schema_version: 1,
                    servers: vec![value],
                },
                false,
            )
            .is_err()
        );
        let masked = masked_server(read_document(&private).unwrap().servers.remove(0));
        let serialized = serde_json::to_string(&masked).unwrap();
        assert!(!serialized.contains("do-not-return"));
        assert!(serialized.contains("configured"));
    }
}
