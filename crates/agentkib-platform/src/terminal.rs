use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::process::Command;

use tempfile::Builder;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InteractiveCommand {
    pub executable: PathBuf,
    pub arguments: Vec<OsString>,
    pub working_directory: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InteractiveLaunchReceipt {
    pub terminal: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SystemTerminal {
    #[cfg(target_os = "macos")]
    MacOs { open: PathBuf },
    #[cfg(windows)]
    Windows { cmd: PathBuf },
    #[cfg(target_os = "linux")]
    LinuxXdg { executable: PathBuf },
    #[cfg(target_os = "linux")]
    LinuxAlternative { executable: PathBuf },
}

impl SystemTerminal {
    fn label(&self) -> &'static str {
        match self {
            #[cfg(target_os = "macos")]
            Self::MacOs { .. } => "Terminal.app",
            #[cfg(windows)]
            Self::Windows { .. } => "Windows Terminal",
            #[cfg(target_os = "linux")]
            Self::LinuxXdg { .. } => "xdg-terminal-exec",
            #[cfg(target_os = "linux")]
            Self::LinuxAlternative { .. } => "x-terminal-emulator",
        }
    }
}

/// Verify that the current platform has a supported system terminal without
/// opening a window. Callers can use this before committing other state.
pub fn preflight_system_terminal() -> io::Result<()> {
    resolve_system_terminal().map(|_| ())
}

/// Open a detached interactive CLI in the system terminal. The generated
/// launcher contains only the executable, arguments, and working directory.
pub fn launch_interactive_command(
    command: &InteractiveCommand,
) -> io::Result<InteractiveLaunchReceipt> {
    validate_interactive_command(command)?;
    let terminal = resolve_system_terminal()?;
    let script = write_launcher_script(command)?;
    let result = match &terminal {
        #[cfg(target_os = "macos")]
        SystemTerminal::MacOs { open } => Command::new(open)
            .args(["-a", "Terminal.app"])
            .arg(&script)
            .spawn(),
        #[cfg(windows)]
        SystemTerminal::Windows { cmd } => {
            Command::new(cmd).args(["/d", "/k"]).arg(&script).spawn()
        }
        #[cfg(target_os = "linux")]
        SystemTerminal::LinuxXdg { executable } => Command::new(executable).arg(&script).spawn(),
        #[cfg(target_os = "linux")]
        SystemTerminal::LinuxAlternative { executable } => {
            Command::new(executable).arg("-e").arg(&script).spawn()
        }
    };
    match result {
        Ok(_) => Ok(InteractiveLaunchReceipt {
            terminal: terminal.label().into(),
        }),
        Err(error) => {
            let _ = fs::remove_file(&script);
            Err(error)
        }
    }
}

fn validate_interactive_command(command: &InteractiveCommand) -> io::Result<()> {
    if !command.executable.is_absolute()
        || !command.executable.is_file()
        || !command.working_directory.is_absolute()
        || !command.working_directory.is_dir()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "interactive command paths must be absolute and exist",
        ));
    }
    for value in std::iter::once(command.executable.as_os_str())
        .chain(command.arguments.iter().map(OsString::as_os_str))
        .chain(std::iter::once(command.working_directory.as_os_str()))
    {
        let text = value.to_string_lossy();
        if text.contains(['\0', '\r', '\n']) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "interactive command contains an unsafe control character",
            ));
        }
    }
    Ok(())
}

fn resolve_system_terminal() -> io::Result<SystemTerminal> {
    #[cfg(target_os = "macos")]
    {
        let open = PathBuf::from("/usr/bin/open");
        if !open.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "open is unavailable",
            ));
        }
        let available = Command::new(&open)
            .args(["-Ra", "Terminal.app"])
            .status()
            .is_ok_and(|status| status.success());
        if !available {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Terminal.app is unavailable",
            ));
        }
        return Ok(SystemTerminal::MacOs { open });
    }
    #[cfg(windows)]
    {
        let cmd = crate::command::resolve("cmd.exe")
            .or_else(|| std::env::var_os("ComSpec").map(PathBuf::from))
            .filter(|path| path.is_absolute() && path.is_file())
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "cmd.exe is unavailable"))?;
        return Ok(SystemTerminal::Windows { cmd });
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(executable) = crate::command::resolve("xdg-terminal-exec") {
            return Ok(SystemTerminal::LinuxXdg { executable });
        }
        if let Some(executable) = crate::command::resolve("x-terminal-emulator") {
            return Ok(SystemTerminal::LinuxAlternative { executable });
        }
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "no supported terminal launcher is available",
        ));
    }
    #[allow(unreachable_code)]
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "interactive terminal launch is unsupported on this platform",
    ))
}

fn write_launcher_script(command: &InteractiveCommand) -> io::Result<PathBuf> {
    #[cfg(windows)]
    let suffix = ".cmd";
    #[cfg(not(windows))]
    let suffix = ".command";

    let temporary = Builder::new()
        .prefix("agentkib-handoff-")
        .suffix(suffix)
        .tempfile()?;
    let (mut file, path) = temporary
        .keep()
        .map_err(|error| io::Error::new(error.error.kind(), error.error.to_string()))?;

    #[cfg(windows)]
    let content = build_windows_script(command);
    #[cfg(not(windows))]
    let content = build_posix_script(command);
    use std::io::Write;
    file.write_all(content.as_bytes())?;
    file.sync_all()?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(path)
}

fn build_posix_script(command: &InteractiveCommand) -> String {
    let mut invocation = posix_quote(command.executable.as_os_str());
    for argument in &command.arguments {
        invocation.push(' ');
        invocation.push_str(&posix_quote(argument));
    }
    format!(
        "#!/bin/sh\nlauncher=$0\nrm -f -- \"$launcher\"\ncd -- {} || exit 1\nexec {}\n",
        posix_quote(command.working_directory.as_os_str()),
        invocation,
    )
}

#[cfg(any(windows, test))]
fn build_windows_script(command: &InteractiveCommand) -> String {
    let needs_call = command
        .executable
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "cmd" | "bat"));
    let mut invocation = if needs_call {
        "call ".into()
    } else {
        String::new()
    };
    invocation.push_str(&windows_batch_quote(command.executable.as_os_str()));
    for argument in &command.arguments {
        invocation.push(' ');
        invocation.push_str(&windows_batch_quote(argument));
    }
    format!(
        "@echo off\r\ncd /d {} || exit /b 1\r\n{}\r\ndel \"%~f0\" >nul 2>&1\r\n",
        windows_batch_quote(command.working_directory.as_os_str()),
        invocation,
    )
}

fn posix_quote(value: &OsStr) -> String {
    format!("'{}'", value.to_string_lossy().replace('\'', "'\"'\"'"))
}

#[cfg(any(windows, test))]
fn windows_batch_quote(value: &OsStr) -> String {
    let escaped = value
        .to_string_lossy()
        .replace('%', "%%")
        .replace('"', "\"\"");
    format!("\"{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command() -> InteractiveCommand {
        InteractiveCommand {
            executable: PathBuf::from("/Applications/Agent CLI/bin/agent"),
            arguments: vec![
                OsString::from("--append-system-prompt"),
                OsString::from("Read .agentkib/handoffs/o'hare.md; do not respond."),
            ],
            working_directory: PathBuf::from("/Users/example/My Project"),
        }
    }

    #[test]
    fn posix_launcher_quotes_paths_and_removes_itself_before_exec() {
        let script = build_posix_script(&command());
        assert!(script.contains("rm -f -- \"$launcher\""));
        assert!(script.contains("cd -- '/Users/example/My Project'"));
        assert!(script.contains("'/Applications/Agent CLI/bin/agent'"));
        assert!(script.contains("o'\"'\"'hare.md"));
    }

    #[test]
    fn windows_launcher_quotes_arguments_and_removes_itself_after_exit() {
        let mut command = command();
        command.executable = PathBuf::from(r"C:\Users\Example\bin\agent.cmd");
        command.working_directory = PathBuf::from(r"C:\Users\Example & Co\Project");
        command.arguments.push(OsString::from("100% ready"));
        let script = build_windows_script(&command);
        assert!(script.contains(r#"cd /d "C:\Users\Example & Co\Project""#));
        assert!(script.contains(r#"call "C:\Users\Example\bin\agent.cmd""#));
        assert!(script.contains(r#""100%% ready""#));
        assert!(script.ends_with("del \"%~f0\" >nul 2>&1\r\n"));
    }

    #[test]
    fn launchers_never_include_unrelated_handoff_content() {
        let posix = build_posix_script(&command());
        let windows = build_windows_script(&command());
        assert!(!posix.contains("secret transcript body"));
        assert!(!windows.contains("secret transcript body"));
    }
}
