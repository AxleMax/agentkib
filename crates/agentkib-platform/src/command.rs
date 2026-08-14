use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};

/// Resolve a command using the current process environment and platform rules.
pub fn resolve(command: &str) -> Option<PathBuf> {
    resolve_in(command, search_directories().iter().map(PathBuf::as_path))
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
            .find(|path| is_executable_file(path, !extensions.is_empty()));
    }
    directories.into_iter().find_map(|directory| {
        executable_candidates(&directory.join(command), extensions)
            .into_iter()
            .find(|path| is_executable_file(path, !extensions.is_empty()))
    })
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

    #[cfg(not(windows))]
    {
        directories.extend([
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
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

pub fn cursor_app_is_available() -> bool {
    cursor_app_candidates().iter().any(|path| path.is_file())
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

#[cfg(windows)]
fn push_env(paths: &mut Vec<PathBuf>, name: &str) {
    if let Some(value) = env::var_os(name) {
        paths.push(value.into());
    }
}

#[cfg(windows)]
fn push_env_join(paths: &mut Vec<PathBuf>, name: &str, suffix: &str) {
    if let Some(value) = env::var_os(name) {
        paths.push(PathBuf::from(value).join(suffix));
    }
}

#[cfg(not(windows))]
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
    fn ignores_non_executable_unix_files() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("codex"), "text").unwrap();
        assert_eq!(resolve_in("codex", [directory.path()]), None);
    }
}
