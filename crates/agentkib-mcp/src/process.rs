use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

pub(crate) fn command_for_std(command: &str) -> std::process::Command {
    let resolved = resolve_command_from(command, None).unwrap_or_else(|| PathBuf::from(command));
    if cfg!(target_os = "windows") && is_batch_file(&resolved) {
        let mut process = std::process::Command::new(windows_command_processor());
        process.args(["/D", "/C"]).arg(resolved);
        process
    } else {
        std::process::Command::new(resolved)
    }
}

pub(crate) fn command_for_tokio(
    command: &str,
    working_directory: Option<&Path>,
) -> tokio::process::Command {
    let resolved =
        resolve_command_from(command, working_directory).unwrap_or_else(|| PathBuf::from(command));
    if cfg!(target_os = "windows") && is_batch_file(&resolved) {
        let mut process = tokio::process::Command::new(windows_command_processor());
        process.args(["/D", "/C"]).arg(resolved);
        process
    } else {
        tokio::process::Command::new(resolved)
    }
}

fn resolve_command_from(command: &str, preferred_directory: Option<&Path>) -> Option<PathBuf> {
    let mut directories = agentkib_platform::command::search_directories();
    if let Ok(current) = std::env::current_dir() {
        directories.retain(|value| value != &current);
        directories.insert(0, current);
    }
    if let Some(directory) = preferred_directory {
        directories.retain(|value| value != directory);
        directories.insert(0, directory.to_path_buf());
    }
    agentkib_platform::command::resolve_in(command, directories.iter().map(PathBuf::as_path))
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
}
