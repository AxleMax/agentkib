use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

pub(crate) fn command_for_std(command: &str) -> std::io::Result<std::process::Command> {
    let resolved = resolve_command_from(command, None).ok_or_else(|| command_not_found(command))?;
    let mut process = if cfg!(target_os = "windows") && is_batch_file(&resolved) {
        let mut process = std::process::Command::new(windows_command_processor());
        process.args(["/D", "/C"]).arg(resolved);
        process
    } else {
        std::process::Command::new(resolved)
    };
    agentkib_platform::process::configure_process_group(&mut process);
    Ok(process)
}

pub(crate) fn command_for_tokio(
    command: &str,
    working_directory: Option<&Path>,
) -> std::io::Result<tokio::process::Command> {
    let resolved = resolve_command_from(command, working_directory)
        .ok_or_else(|| command_not_found(command))?;
    let mut process = if cfg!(target_os = "windows") && is_batch_file(&resolved) {
        let mut process = tokio::process::Command::new(windows_command_processor());
        process.args(["/D", "/C"]).arg(resolved);
        process
    } else {
        tokio::process::Command::new(resolved)
    };
    agentkib_platform::process::configure_process_group(process.as_std_mut());
    Ok(process)
}

fn resolve_command_from(command: &str, preferred_directory: Option<&Path>) -> Option<PathBuf> {
    let preferred_directory = preferred_directory.and_then(absolute_directory);
    let command_path = Path::new(command);
    if command_path.is_relative()
        && command_path
            .parent()
            .is_some_and(|parent| !parent.as_os_str().is_empty())
        && let Some(directory) = preferred_directory.as_deref()
    {
        return agentkib_platform::command::resolve_in(
            &directory.join(command).to_string_lossy(),
            std::iter::empty::<&Path>(),
        );
    }
    let mut directories = agentkib_platform::command::search_directories();
    if let Ok(current) = std::env::current_dir() {
        directories.retain(|value| value != &current);
        directories.insert(0, current);
    }
    if let Some(directory) = preferred_directory {
        directories.retain(|value| value != &directory);
        directories.insert(0, directory);
    }
    agentkib_platform::command::resolve_in(command, directories.iter().map(PathBuf::as_path))
}

fn absolute_directory(directory: &Path) -> Option<PathBuf> {
    if directory.is_absolute() {
        Some(directory.to_path_buf())
    } else {
        std::env::current_dir()
            .ok()
            .map(|current| current.join(directory))
    }
}

fn command_not_found(command: &str) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!("Unable to resolve executable `{command}`"),
    )
}

fn windows_command_processor() -> OsString {
    std::env::var_os("COMSPEC").unwrap_or_else(|| OsString::from("cmd.exe"))
}

fn is_batch_file(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_batch_extension_is_recognized_case_insensitively() {
        assert!(is_batch_file(Path::new("C:/tools/server.CmD")));
        assert!(is_batch_file(Path::new("C:/tools/server.bat")));
        assert!(!is_batch_file(Path::new("C:/tools/server.exe")));
    }

    #[cfg(unix)]
    #[test]
    fn relative_working_directory_resolves_relative_command_once() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;

        let current = std::env::current_dir().unwrap();
        let root = tempfile::tempdir_in(&current).unwrap();
        let relative = root.path().strip_prefix(&current).unwrap();
        let executable = root.path().join("server");
        fs::write(&executable, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            resolve_command_from("./server", Some(relative)),
            Some(executable)
        );
    }
}
