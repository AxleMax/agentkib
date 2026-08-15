use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use agentkib_core::{
    McpInstallation, McpPackageKind, McpPackageReference, McpRegistryEntry, McpServerConfig,
    McpServerTransport,
};
use agentkib_platform::fs::move_path;
use agentkib_platform::path::{equivalent, starts_with as path_starts_with};
use agentkib_platform::process::ProcessTree;
use anyhow::{Context, Result, bail};
use chrono::Utc;
use serde_json::Value;
use sha2::{Digest, Sha256};

const REGISTRY_BASE: &str = "https://registry.modelcontextprotocol.io/v0.1";
const RUNTIME_CHECK_TIMEOUT: Duration = Duration::from_secs(10);
const PACKAGE_INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

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
    if !equivalent(parent, &root) || !path_starts_with(path, &root) {
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
    let mut npm = crate::process::command_for_std("npm")?;
    let result = command_status(
        npm.args(["install", "--prefix"])
            .arg(&temp)
            .args(["--no-save", "--ignore-scripts"])
            .arg(&package),
        PACKAGE_INSTALL_TIMEOUT,
    )
    .context("npm installation could not complete")?;
    if !result.success() {
        let _ = fs::remove_dir_all(&temp);
        bail!("npm installation failed with status {result}");
    }
    let temporary_command = npm_binary(&temp, &entry.identifier)?;
    let command = target.join(
        temporary_command
            .strip_prefix(&temp)
            .context("npm executable is outside its installation directory")?,
    );
    finish_install(&temp, &target)?;
    installed_package(entry, target, command, entry.package_arguments.clone())
}

fn install_pypi(entry: &McpRegistryEntry) -> Result<(McpInstallation, McpServerConfig)> {
    ensure_command("uv")?;
    let target = package_target(entry)?;
    let temp = target.with_extension("installing");
    prepare_clean_install_directory(&temp)?;
    let venv = temp.join("venv");
    let mut uv = crate::process::command_for_std("uv")?;
    let created = command_status(uv.arg("venv").arg(&venv), PACKAGE_INSTALL_TIMEOUT)
        .context("uv virtual environment creation could not complete")?;
    if !created.success() {
        let _ = fs::remove_dir_all(&temp);
        bail!("uv venv failed with status {created}");
    }
    let package = format!("{}=={}", entry.identifier, entry.version);
    let mut uv = crate::process::command_for_std("uv")?;
    let installed = command_status(
        uv.args(["pip", "install", "--python"])
            .arg(venv_python(&venv))
            .arg(&package),
        PACKAGE_INSTALL_TIMEOUT,
    )
    .context("uv package installation could not complete")?;
    if !installed.success() {
        let _ = fs::remove_dir_all(&temp);
        bail!("uv pip install failed with status {installed}");
    }
    let executable = find_venv_executable(&venv, &entry.identifier)?;
    finish_install(&temp, &target)?;
    installed_package(
        entry,
        target.clone(),
        venv_scripts_dir(&target.join("venv")).join(executable),
        entry.package_arguments.clone(),
    )
}

fn find_venv_executable(venv: &Path, identifier: &str) -> Result<String> {
    let bin = venv_scripts_dir(venv);
    let normalized = identifier.replace('_', "-").to_ascii_lowercase();
    let mut candidates: Vec<String> = fs::read_dir(&bin)?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !is_venv_support_executable(name))
        .collect();
    candidates.sort();
    candidates
        .iter()
        .find(|name| normalized_executable_name(name) == normalized)
        .or_else(|| candidates.first())
        .cloned()
        .context("PyPI package did not install an executable entry point")
}

fn venv_scripts_dir(venv: &Path) -> PathBuf {
    venv_scripts_dir_for(venv, cfg!(target_os = "windows"))
}

fn venv_scripts_dir_for(venv: &Path, windows: bool) -> PathBuf {
    if windows {
        venv.join("Scripts")
    } else {
        venv.join("bin")
    }
}

fn venv_python(venv: &Path) -> PathBuf {
    venv_python_for(venv, cfg!(target_os = "windows"))
}

fn venv_python_for(venv: &Path, windows: bool) -> PathBuf {
    if windows {
        venv.join("Scripts/python.exe")
    } else {
        venv.join("bin/python")
    }
}

fn normalized_executable_name(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    let stem = [".exe", ".cmd", ".bat"]
        .iter()
        .find_map(|extension| lower.strip_suffix(extension))
        .unwrap_or(&lower);
    stem.replace('_', "-")
}

fn is_venv_support_executable(name: &str) -> bool {
    matches!(
        normalized_executable_name(name).as_str(),
        "activate"
            | "activate.csh"
            | "activate.fish"
            | "activate.nu"
            | "activate.ps1"
            | "activate-this.py"
            | "deactivate"
            | "pip"
            | "pip3"
            | "python"
            | "python3"
            | "pydoc"
    )
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
        move_path(target, &backup)?;
    }
    if let Err(error) = move_path(temp, target) {
        if backup.exists() {
            let _ = move_path(&backup, target);
        }
        return Err(error.into());
    }
    if backup.exists() {
        fs::remove_dir_all(backup)?;
    }
    Ok(())
}

fn ensure_command(command: &str) -> Result<()> {
    let mut process = crate::process::command_for_std(command)?;
    let status = command_status(process.arg("--version"), RUNTIME_CHECK_TIMEOUT)
        .with_context(|| format!("Unable to check required runtime `{command}`"))?;
    if !status.success() {
        bail!("Required runtime `{command}` is not installed or not executable");
    }
    Ok(())
}

fn command_status(
    command: &mut std::process::Command,
    timeout: Duration,
) -> std::io::Result<std::process::ExitStatus> {
    let mut child = command.spawn()?;
    let process_tree = ProcessTree::attach(&child).inspect_err(|_| {
        let _ = child.kill();
        let _ = child.wait();
    })?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if started.elapsed() >= timeout {
            let _ = process_tree.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("command timed out after {} seconds", timeout.as_secs()),
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn npm_binary(root: &Path, identifier: &str) -> Result<PathBuf> {
    npm_binary_for(root, identifier, cfg!(target_os = "windows"))
}

fn npm_binary_for(root: &Path, identifier: &str, windows: bool) -> Result<PathBuf> {
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
    let executable = if windows {
        format!("{executable}.cmd")
    } else {
        executable.to_string()
    };
    let executable = root.join("node_modules/.bin").join(executable);
    if !executable.is_file() {
        bail!(
            "npm package executable was not created: {}",
            executable.display()
        );
    }
    Ok(executable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn executable_name_matching_accepts_windows_venv_launchers() {
        assert_eq!(normalized_executable_name("mcp_server.EXE"), "mcp-server");
        assert!(is_venv_support_executable("python.exe"));
        assert!(is_venv_support_executable("deactivate.bat"));
        assert!(!is_venv_support_executable("mcp-server.exe"));
        let venv = Path::new("C:/mcp/venv");
        assert_eq!(
            venv_python_for(venv, true),
            PathBuf::from("C:/mcp/venv/Scripts/python.exe")
        );
        assert_eq!(
            venv_scripts_dir_for(venv, true),
            PathBuf::from("C:/mcp/venv/Scripts")
        );
    }

    #[test]
    fn npm_binary_requires_the_generated_platform_launcher() {
        let directory = tempdir().unwrap();
        let package = directory.path().join("node_modules/@scope/server");
        fs::create_dir_all(&package).unwrap();
        fs::create_dir_all(directory.path().join("node_modules/.bin")).unwrap();
        fs::write(
            package.join("package.json"),
            r#"{"bin":{"mcp-server":"dist/main.js"}}"#,
        )
        .unwrap();
        let launcher = directory.path().join("node_modules/.bin/mcp-server.cmd");
        fs::write(&launcher, "launcher").unwrap();

        assert_eq!(
            npm_binary_for(directory.path(), "@scope/server", true).unwrap(),
            launcher
        );
    }

    #[test]
    fn finishing_install_replaces_target_and_removes_backup() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("package");
        let temporary = directory.path().join("package.installing");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("version"), "old").unwrap();
        fs::create_dir_all(&temporary).unwrap();
        fs::write(temporary.join("version"), "new").unwrap();

        finish_install(&temporary, &target).unwrap();

        assert_eq!(fs::read_to_string(target.join("version")).unwrap(), "new");
        assert!(!target.with_extension("replaced").exists());
        assert!(!temporary.exists());
    }

    #[cfg(unix)]
    #[test]
    fn command_status_stops_a_timed_out_process() {
        let mut command = std::process::Command::new("sh");
        command.args(["-c", "sleep 5"]);
        let error = command_status(&mut command, Duration::from_millis(20)).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    }
}
