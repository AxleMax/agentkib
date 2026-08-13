use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use agentkib_core::{
    McpInstallation, McpPackageKind, McpPackageReference, McpRegistryEntry, McpServerConfig,
    McpServerTransport,
};
use anyhow::{Context, Result, bail};
use chrono::Utc;
use serde_json::Value;
use sha2::{Digest, Sha256};

const REGISTRY_BASE: &str = "https://registry.modelcontextprotocol.io/v0.1";

pub async fn search_registry(query: &str) -> Result<Vec<McpRegistryEntry>> {
    let response = reqwest::Client::new()
        .get(format!("{REGISTRY_BASE}/servers"))
        .query(&[("search", query), ("version", "latest"), ("limit", "100")])
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let mut entries = Vec::new();
    for wrapper in response
        .get("servers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(server) = wrapper.get("server") else {
            continue;
        };
        if let Some(entry) = parse_registry_server(server) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

fn parse_registry_server(server: &Value) -> Option<McpRegistryEntry> {
    let name = server.get("name")?.as_str()?.to_string();
    let description = server
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let version = server.get("version")?.as_str()?.to_string();
    if let Some(remote) = server
        .get("remotes")
        .and_then(Value::as_array)
        .and_then(|values| {
            values.iter().find(|remote| {
                remote.pointer("/transport/type").and_then(Value::as_str) == Some("streamable-http")
                    || remote.get("type").and_then(Value::as_str) == Some("streamable-http")
            })
        })
    {
        let url = remote
            .get("url")
            .or_else(|| remote.pointer("/transport/url"))?
            .as_str()?
            .to_string();
        return Some(McpRegistryEntry {
            name,
            description,
            version,
            package_kind: McpPackageKind::Remote,
            identifier: url.clone(),
            runtime_hint: None,
            url: Some(url),
            required_env: Vec::new(),
            runtime_arguments: Vec::new(),
            package_arguments: Vec::new(),
        });
    }
    let package = server.get("packages")?.as_array()?.iter().find(|package| {
        matches!(
            package.get("registryType").and_then(Value::as_str),
            Some("npm" | "pypi")
        )
    })?;
    let package_kind = match package.get("registryType")?.as_str()? {
        "npm" => McpPackageKind::Npm,
        "pypi" => McpPackageKind::Pypi,
        _ => return None,
    };
    let identifier = package.get("identifier")?.as_str()?.to_string();
    let required_env = package
        .get("environmentVariables")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|value| value.get("isRequired").and_then(Value::as_bool) == Some(true))
        .filter_map(|value| {
            value
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    Some(McpRegistryEntry {
        name,
        description,
        version: package
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or(&version)
            .to_string(),
        package_kind,
        identifier,
        runtime_hint: package
            .get("runtimeHint")
            .and_then(Value::as_str)
            .map(str::to_string),
        url: None,
        required_env,
        runtime_arguments: argument_values(package.get("runtimeArguments")),
        package_arguments: argument_values(package.get("packageArguments")),
    })
}

fn argument_values(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|argument| {
            argument
                .get("value")
                .or_else(|| argument.get("default"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

pub fn install_registry_entry(
    entry: &McpRegistryEntry,
) -> Result<(McpInstallation, McpServerConfig)> {
    match entry.package_kind {
        McpPackageKind::Remote => install_remote(entry),
        McpPackageKind::Npm => install_npm(entry),
        McpPackageKind::Pypi => install_pypi(entry),
        McpPackageKind::Local => bail!("Local commands are registered without an installer"),
    }
}

pub fn uninstall_package(installation: &McpInstallation) -> Result<()> {
    let Some(path) = installation.install_path.as_ref() else {
        return Ok(());
    };
    let root = super::runtime::installation_root()?;
    let parent = path
        .parent()
        .context("MCP installation path has no parent")?;
    if parent != root || !path.starts_with(&root) {
        bail!("Refusing to remove an MCP installation outside AgentKib data");
    }
    if path.is_dir() {
        fs::remove_dir_all(path)?;
    }
    Ok(())
}

fn install_remote(entry: &McpRegistryEntry) -> Result<(McpInstallation, McpServerConfig)> {
    let url = entry.url.clone().context("Registry remote has no URL")?;
    let now = Utc::now();
    let id = installation_id(entry);
    Ok((
        McpInstallation {
            id: id.clone(),
            name: entry.name.clone(),
            package_kind: McpPackageKind::Remote,
            identifier: url.clone(),
            version: Some(entry.version.clone()),
            install_path: None,
            status: "installed".into(),
            installed_at: now,
            updated_at: now,
        },
        server_config(entry, id, McpServerTransport::StreamableHttp { url }),
    ))
}

fn install_npm(entry: &McpRegistryEntry) -> Result<(McpInstallation, McpServerConfig)> {
    ensure_command("npm")?;
    let target = package_target(entry)?;
    let temp = target.with_extension("installing");
    prepare_clean_install_directory(&temp)?;
    let package = format!("{}@{}", entry.identifier, entry.version);
    let result = Command::new("npm")
        .args(["install", "--prefix"])
        .arg(&temp)
        .args(["--no-save", "--ignore-scripts"])
        .arg(&package)
        .status()
        .context("Unable to start npm")?;
    if !result.success() {
        let _ = fs::remove_dir_all(&temp);
        bail!("npm installation failed with status {result}");
    }
    let command = npm_binary(&temp, &entry.identifier)?;
    finish_install(&temp, &target)?;
    installed_package(entry, target, command, entry.package_arguments.clone())
}

fn install_pypi(entry: &McpRegistryEntry) -> Result<(McpInstallation, McpServerConfig)> {
    ensure_command("uv")?;
    let target = package_target(entry)?;
    let temp = target.with_extension("installing");
    prepare_clean_install_directory(&temp)?;
    let venv = temp.join("venv");
    let created = Command::new("uv").arg("venv").arg(&venv).status()?;
    if !created.success() {
        let _ = fs::remove_dir_all(&temp);
        bail!("uv venv failed with status {created}");
    }
    let package = format!("{}=={}", entry.identifier, entry.version);
    let installed = Command::new("uv")
        .args(["pip", "install", "--python"])
        .arg(venv.join("bin/python"))
        .arg(&package)
        .status()?;
    if !installed.success() {
        let _ = fs::remove_dir_all(&temp);
        bail!("uv pip install failed with status {installed}");
    }
    let executable = find_venv_executable(&venv, &entry.identifier)?;
    finish_install(&temp, &target)?;
    installed_package(
        entry,
        target.clone(),
        target.join("venv/bin").join(executable),
        entry.package_arguments.clone(),
    )
}

fn find_venv_executable(venv: &Path, identifier: &str) -> Result<String> {
    let bin = venv.join("bin");
    let normalized = identifier.replace('_', "-").to_ascii_lowercase();
    let mut candidates: Vec<String> = fs::read_dir(&bin)?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| {
            !matches!(
                name.as_str(),
                "activate"
                    | "activate.csh"
                    | "activate.fish"
                    | "activate.nu"
                    | "activate.ps1"
                    | "activate_this.py"
                    | "deactivate.bat"
                    | "pip"
                    | "pip3"
                    | "python"
                    | "python3"
                    | "pydoc"
            )
        })
        .collect();
    candidates.sort();
    candidates
        .iter()
        .find(|name| name.replace('_', "-").to_ascii_lowercase() == normalized)
        .or_else(|| candidates.first())
        .cloned()
        .context("PyPI package did not install an executable entry point")
}

fn installed_package(
    entry: &McpRegistryEntry,
    target: PathBuf,
    command: PathBuf,
    args: Vec<String>,
) -> Result<(McpInstallation, McpServerConfig)> {
    let now = Utc::now();
    let id = installation_id(entry);
    Ok((
        McpInstallation {
            id: id.clone(),
            name: entry.name.clone(),
            package_kind: entry.package_kind,
            identifier: entry.identifier.clone(),
            version: Some(entry.version.clone()),
            install_path: Some(target),
            status: "installed".into(),
            installed_at: now,
            updated_at: now,
        },
        server_config(
            entry,
            id,
            McpServerTransport::Stdio {
                command: command.display().to_string(),
                args,
                cwd: None,
            },
        ),
    ))
}

fn server_config(
    entry: &McpRegistryEntry,
    id: String,
    transport: McpServerTransport,
) -> McpServerConfig {
    McpServerConfig {
        id,
        name: entry.name.clone(),
        enabled: true,
        transport,
        env: Default::default(),
        headers: Default::default(),
        oauth_credentials: None,
        local_config_path: None,
        targets: Vec::new(),
        allow_tools: Vec::new(),
        lan_allow_tools: Vec::new(),
        supports_parallel_tool_calls: false,
        package: Some(McpPackageReference {
            kind: entry.package_kind,
            identifier: entry.identifier.clone(),
            version: Some(entry.version.clone()),
        }),
    }
}

fn installation_id(entry: &McpRegistryEntry) -> String {
    let digest = Sha256::digest(format!("{}@{}", entry.name, entry.version));
    format!("mcp-{}", hex::encode(&digest[..8]))
}

fn package_target(entry: &McpRegistryEntry) -> Result<PathBuf> {
    Ok(super::runtime::installation_root()?.join(installation_id(entry)))
}

fn prepare_clean_install_directory(path: &Path) -> Result<()> {
    if path.exists() {
        fs::remove_dir_all(path)?;
    }
    fs::create_dir_all(path)?;
    Ok(())
}

fn finish_install(temp: &Path, target: &Path) -> Result<()> {
    let backup = target.with_extension("replaced");
    if backup.exists() {
        fs::remove_dir_all(&backup)?;
    }
    if target.exists() {
        fs::rename(target, &backup)?;
    }
    if let Err(error) = fs::rename(temp, target) {
        if backup.exists() {
            let _ = fs::rename(&backup, target);
        }
        return Err(error.into());
    }
    if backup.exists() {
        fs::remove_dir_all(backup)?;
    }
    Ok(())
}

fn ensure_command(command: &str) -> Result<()> {
    let status = Command::new(command).arg("--version").status();
    if !status.is_ok_and(|status| status.success()) {
        bail!("Required runtime `{command}` is not installed or not executable");
    }
    Ok(())
}

fn npm_binary(root: &Path, identifier: &str) -> Result<PathBuf> {
    let package = root
        .join("node_modules")
        .join(identifier)
        .join("package.json");
    let value: Value = serde_json::from_str(&fs::read_to_string(&package)?)?;
    let executable = match value.get("bin") {
        Some(Value::String(_)) => identifier.rsplit('/').next().unwrap_or(identifier),
        Some(Value::Object(values)) => values
            .keys()
            .next()
            .map(String::as_str)
            .context("npm package has no binary")?,
        _ => bail!("npm package does not declare an executable"),
    };
    Ok(root.join("node_modules/.bin").join(executable))
}
