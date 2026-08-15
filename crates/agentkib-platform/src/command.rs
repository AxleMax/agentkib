use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};
use std::{fs, io};

/// Resolve a command using the current process environment and platform rules.
pub fn resolve(command: &str) -> Option<PathBuf> {
    let directories = search_directories();
    resolve_in(command, directories.iter().map(PathBuf::as_path))
}

/// Return whether a path is a regular executable file on the current platform.
pub fn is_executable(path: &Path) -> bool {
    is_executable_file(path, cfg!(windows))
}

/// Resolve a command in an explicit set of directories.
pub fn resolve_in<'a>(
    command: &str,
    directories: impl IntoIterator<Item = &'a Path>,
) -> Option<PathBuf> {
    let extensions = executable_extensions();
    resolve_in_with_extensions(command, directories, &extensions)
}

/// Resolve using explicit executable extensions. This is public so callers can
/// model a target Windows environment without changing the process environment.
pub fn resolve_in_with_extensions<'a>(
    command: &str,
    directories: impl IntoIterator<Item = &'a Path>,
    extensions: &[String],
) -> Option<PathBuf> {
    let command_path = Path::new(command);
    let has_parent = command_path
        .parent()
        .is_some_and(|parent| !parent.as_os_str().is_empty());
    if command_path.is_absolute() || has_parent {
        return executable_candidates(command_path, extensions)
            .into_iter()
            .filter_map(absolutize)
            .find(|path| is_executable_file(path, !extensions.is_empty()));
    }
    directories.into_iter().find_map(|directory| {
        let directory = absolutize(directory.to_path_buf())?;
        executable_candidates(&directory.join(command), extensions)
            .into_iter()
            .find(|path| is_executable_file(path, !extensions.is_empty()))
    })
}

fn absolutize(path: PathBuf) -> Option<PathBuf> {
    if path.is_absolute() {
        Some(path)
    } else {
        env::current_dir().ok().map(|current| current.join(path))
    }
}

pub fn search_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(value) = env::var_os("PATH") {
        directories.extend(env::split_paths(&value));
    }

    #[cfg(windows)]
    {
        push_env_join(&mut directories, "APPDATA", "npm");
        push_env_join(&mut directories, "LOCALAPPDATA", "pnpm");
        push_env(&mut directories, "PNPM_HOME");
        push_env_join(&mut directories, "LOCALAPPDATA", "Programs");
        push_env_join(&mut directories, "LOCALAPPDATA", "Microsoft/WindowsApps");
        push_env_join(
            &mut directories,
            "LOCALAPPDATA",
            "Programs/cursor/resources/app/bin",
        );
        push_env_join(
            &mut directories,
            "LOCALAPPDATA",
            "Programs/Cursor/resources/app/bin",
        );
    }

    #[cfg(target_os = "macos")]
    {
        directories.extend([
            PathBuf::from("/usr/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
        ]);
        if let Some(home) = home_dir() {
            directories.extend([
                home.join(".local/bin"),
                home.join(".cargo/bin"),
                home.join(".bun/bin"),
                home.join(".npm-global/bin"),
                home.join("Library/pnpm"),
            ]);
        }
    }

    #[cfg(target_os = "linux")]
    {
        directories.extend([PathBuf::from("/usr/bin"), PathBuf::from("/usr/local/bin")]);
        if let Some(dirs) = crate::xdg::XdgDirs::from_environment() {
            directories.extend([
                dirs.home.join(".local/bin"),
                dirs.home.join(".cargo/bin"),
                dirs.home.join(".bun/bin"),
                dirs.home.join(".npm-global/bin"),
                dirs.data_home.join("pnpm"),
                dirs.home.join(".asdf/shims"),
                dirs.data_home.join("mise/shims"),
            ]);
            extend_version_manager_bins(&mut directories, &dirs.home.join(".nvm/versions/node"));
        }
        push_env(&mut directories, "PNPM_HOME");
        push_env(&mut directories, "NVM_BIN");
        push_env_join(&mut directories, "ASDF_DATA_DIR", "shims");
        push_env_join(&mut directories, "MISE_DATA_DIR", "shims");
        push_env_join(&mut directories, "npm_config_prefix", "bin");
        directories.push(PathBuf::from("/snap/bin"));
    }

    let mut seen = HashSet::new();
    directories.retain(|path| seen.insert(crate::path::identity(path)));
    directories
}

/// Known Cursor desktop executable locations. Command-line installation is
/// checked independently by [`resolve`].
pub fn cursor_app_candidates() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        if let Some(root) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            candidates.extend([
                root.join("Programs/cursor/Cursor.exe"),
                root.join("Programs/Cursor/Cursor.exe"),
                root.join("Microsoft/WindowsApps/Cursor.exe"),
            ]);
        }
        if let Some(root) = env::var_os("ProgramFiles").map(PathBuf::from) {
            candidates.push(root.join("Cursor/Cursor.exe"));
        }
        candidates
    }
    #[cfg(target_os = "macos")]
    {
        Vec::new()
    }
    #[cfg(target_os = "linux")]
    {
        let search = search_directories();
        let mut candidates = vec![
            PathBuf::from("/usr/bin/cursor"),
            PathBuf::from("/usr/share/cursor/cursor"),
            PathBuf::from("/opt/Cursor/cursor"),
            PathBuf::from("/opt/cursor/cursor"),
        ];
        candidates.extend(desktop_application_executables(
            &["cursor", "cursor-url-handler"],
            &search,
        ));
        if let Some(home) = crate::xdg::home_dir() {
            extend_matching_files(&mut candidates, &home.join("Applications"), |name| {
                name.to_ascii_lowercase().contains("cursor") && name.ends_with(".AppImage")
            });
        }
        let mut seen = HashSet::new();
        candidates.retain(|path| seen.insert(crate::path::identity(path)));
        candidates
    }
}

pub fn cursor_app_is_available() -> bool {
    cursor_app_candidates()
        .iter()
        .any(|path| is_executable_file(path, false))
}

/// Resolve the executable referenced by a freedesktop Desktop Entry without
/// invoking a shell. Field codes and arguments are ignored deliberately.
pub fn desktop_entry_executable(
    path: &Path,
    search_directories: &[PathBuf],
) -> io::Result<Option<PathBuf>> {
    let content = fs::read_to_string(path)?;
    let mut in_desktop_entry = false;
    let mut exec = None;
    let mut try_exec = None;
    let mut has_try_exec = false;
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_desktop_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_desktop_entry || line.starts_with('#') {
            continue;
        }
        if let Some(value) = line.strip_prefix("TryExec=") {
            has_try_exec = true;
            try_exec = first_exec_token(value);
        } else if let Some(value) = line.strip_prefix("Exec=") {
            exec = first_exec_token(value);
        }
    }
    let executable = if has_try_exec { try_exec } else { exec };
    Ok(executable.and_then(|command| {
        if is_desktop_launcher_wrapper(&command) {
            return None;
        }
        resolve_in(&command, search_directories.iter().map(PathBuf::as_path))
    }))
}

pub fn desktop_application_executables(
    application_ids: &[&str],
    search_directories: &[PathBuf],
) -> Vec<PathBuf> {
    let ids: Vec<_> = application_ids
        .iter()
        .map(|value| value.trim_end_matches(".desktop").to_ascii_lowercase())
        .collect();
    let mut desktop_files = Vec::new();
    for directory in crate::xdg::application_dirs() {
        collect_desktop_files(&directory, 2, &mut desktop_files);
    }
    let mut output = Vec::new();
    for desktop_file in desktop_files {
        let file_stem = desktop_file
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !ids
            .iter()
            .any(|id| file_stem == *id || file_stem.starts_with(&format!("{id}-")))
        {
            continue;
        }
        if let Ok(Some(path)) = desktop_entry_executable(&desktop_file, search_directories) {
            output.push(path);
        }
    }
    let mut seen = HashSet::new();
    output.retain(|path| seen.insert(crate::path::identity(path)));
    output
}

fn first_exec_token(value: &str) -> Option<String> {
    let tokens = split_desktop_exec(value)?;
    let mut index = 0;
    if tokens.first().is_some_and(|value| value == "env") {
        index += 1;
        while tokens.get(index).is_some_and(|value| {
            value.starts_with('-')
                || value
                    .split_once('=')
                    .is_some_and(|(name, _)| !name.is_empty() && !name.contains('/'))
        }) {
            index += 1;
        }
    }
    tokens
        .get(index)
        .filter(|value| !value.contains('%'))
        .cloned()
}

fn is_desktop_launcher_wrapper(command: &str) -> bool {
    Path::new(command)
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| {
            matches!(
                name,
                "sh" | "bash" | "dash" | "zsh" | "fish" | "flatpak" | "snap"
            )
        })
}

fn split_desktop_exec(value: &str) -> Option<Vec<String>> {
    let mut output = Vec::new();
    let mut token = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            token.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '"' {
            quoted = !quoted;
        } else if character.is_whitespace() && !quoted {
            if !token.is_empty() {
                output.push(std::mem::take(&mut token));
            }
        } else {
            token.push(character);
        }
    }
    if escaped || quoted {
        return None;
    }
    if !token.is_empty() {
        output.push(token);
    }
    Some(output)
}

fn collect_desktop_files(directory: &Path, depth: usize, output: &mut Vec<PathBuf>) {
    if depth == 0 || crate::path::is_reparse_or_symlink(directory).unwrap_or(true) {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_desktop_files(&path, depth - 1, output);
        } else if file_type.is_file() && path.extension().is_some_and(|value| value == "desktop") {
            output.push(path);
        }
    }
}

#[cfg(target_os = "linux")]
fn extend_version_manager_bins(paths: &mut Vec<PathBuf>, root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut bins: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir() && !kind.is_symlink())
                .map(|_| path.join("bin"))
        })
        .collect();
    bins.sort();
    paths.extend(bins);
}

#[cfg(target_os = "linux")]
fn extend_matching_files(
    paths: &mut Vec<PathBuf>,
    directory: &Path,
    predicate: impl Fn(&str) -> bool,
) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    paths.extend(entries.flatten().filter_map(|entry| {
        let file_type = entry.file_type().ok()?;
        let name = entry.file_name();
        let name = name.to_str()?;
        (file_type.is_file() && !file_type.is_symlink() && predicate(name)).then(|| entry.path())
    }));
}

fn executable_extensions() -> Vec<String> {
    #[cfg(windows)]
    {
        let value = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        let mut extensions: Vec<_> = value
            .split(';')
            .filter_map(|extension| {
                let extension = extension.trim();
                if extension.is_empty() {
                    None
                } else if extension.starts_with('.') {
                    Some(extension.to_string())
                } else {
                    Some(format!(".{extension}"))
                }
            })
            .collect();
        for required in [".COM", ".EXE", ".BAT", ".CMD"] {
            if !extensions
                .iter()
                .any(|extension| extension.eq_ignore_ascii_case(required))
            {
                extensions.push(required.to_owned());
            }
        }
        extensions
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

fn executable_candidates(command: &Path, extensions: &[String]) -> Vec<PathBuf> {
    if extensions.is_empty() || command.extension().is_some() {
        return vec![command.to_path_buf()];
    }
    extensions
        .iter()
        .map(|extension| {
            let mut value = command.as_os_str().to_os_string();
            value.push(extension);
            PathBuf::from(value)
        })
        .collect()
}

fn is_executable_file(path: &Path, windows_semantics: bool) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    if windows_semantics {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(any(windows, target_os = "linux"))]
fn push_env(paths: &mut Vec<PathBuf>, name: &str) {
    if let Some(value) = env::var_os(name) {
        paths.push(value.into());
    }
}

#[cfg(any(windows, target_os = "linux"))]
fn push_env_join(paths: &mut Vec<PathBuf>, name: &str, suffix: &str) {
    if let Some(value) = env::var_os(name) {
        paths.push(PathBuf::from(value).join(suffix));
    }
}

#[cfg(target_os = "macos")]
fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn resolves_windows_script_extensions() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("codex.CMD"), "@echo off").unwrap();
        let result = resolve_in_with_extensions(
            "codex",
            [directory.path()],
            &[".EXE".into(), ".CMD".into(), ".BAT".into()],
        );
        assert_eq!(result, Some(directory.path().join("codex.CMD")));
    }

    #[cfg(unix)]
    #[test]
    fn resolves_relative_search_directory_to_an_absolute_path() {
        use std::os::unix::fs::PermissionsExt;

        let current = std::env::current_dir().unwrap();
        let root = tempfile::tempdir_in(&current).unwrap();
        let relative = root.path().strip_prefix(&current).unwrap();
        let executable = root.path().join("codex");
        fs::write(&executable, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(resolve_in("codex", [relative]), Some(executable));
    }

    #[cfg(unix)]
    #[test]
    fn ignores_non_executable_unix_files() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("codex"), "text").unwrap();
        assert_eq!(resolve_in("codex", [directory.path()]), None);
    }

    #[cfg(unix)]
    #[test]
    fn parses_desktop_exec_without_invoking_a_shell() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let executable = directory.path().join("Cursor App");
        fs::write(&executable, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let desktop = directory.path().join("cursor.desktop");
        fs::write(
            &desktop,
            format!(
                "[Desktop Entry]\nName=Cursor\nExec=env ELECTRON_OZONE_PLATFORM_HINT=auto \"{}\" %U\n",
                executable.display()
            ),
        )
        .unwrap();

        assert_eq!(
            desktop_entry_executable(&desktop, &[]).unwrap(),
            Some(executable)
        );
    }

    #[test]
    fn rejects_malformed_desktop_exec_quoting() {
        assert_eq!(split_desktop_exec("\"/opt/Cursor/cursor %U"), None);
    }

    #[cfg(unix)]
    #[test]
    fn desktop_try_exec_must_resolve_when_present() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let executable = directory.path().join("cursor");
        fs::write(&executable, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let desktop = directory.path().join("cursor.desktop");
        fs::write(
            &desktop,
            "[Desktop Entry]\nTryExec=missing-cursor\nExec=cursor %U\n",
        )
        .unwrap();

        assert_eq!(
            desktop_entry_executable(&desktop, &[directory.path().to_path_buf()]).unwrap(),
            None
        );
    }
}
