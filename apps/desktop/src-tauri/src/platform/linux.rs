use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use agentkib_platform::process::{ProcessTree, configure_process_group};
use tauri::AppHandle;

use super::OpenSystemSettingsError;

pub(crate) const SHOW_TRAY_MENU_ON_LEFT_CLICK: bool = true;

pub(crate) fn open_files_and_folders_settings() -> Result<(), OpenSystemSettingsError> {
    Err(OpenSystemSettingsError::Unsupported)
}

pub(crate) fn tray_host_available() -> bool {
    let Some(executable) = agentkib_platform::command::resolve("gdbus") else {
        return false;
    };
    let mut command = Command::new(executable);
    command
        .args([
            "call",
            "--session",
            "--dest",
            "org.freedesktop.DBus",
            "--object-path",
            "/org/freedesktop/DBus",
            "--method",
            "org.freedesktop.DBus.NameHasOwner",
            "org.kde.StatusNotifierWatcher",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_process_group(&mut command);
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let Ok(process_tree) = ProcessTree::attach(&child) else {
        let _ = child.kill();
        let _ = child.wait();
        return false;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                return child
                    .wait_with_output()
                    .ok()
                    .is_some_and(|output| tray_watcher_response(&output.stdout));
            }
            Ok(Some(_)) | Err(_) => return false,
            Ok(None) if started.elapsed() < Duration::from_secs(2) => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = process_tree.terminate();
                let _ = child.wait();
                return false;
            }
        }
    }
}

pub(crate) fn resolve_tray_setup(result: tauri::Result<()>) -> tauri::Result<bool> {
    match result {
        Ok(()) => Ok(tray_host_available()),
        Err(error) => {
            eprintln!("AgentKib system tray is unavailable: {error}");
            Ok(false)
        }
    }
}

fn tray_watcher_response(output: &[u8]) -> bool {
    std::str::from_utf8(output).is_ok_and(|value| value.trim() == "(true,)")
}

pub(crate) fn after_hide_to_tray(_app: &AppHandle, _tray_available: bool) {}

pub(crate) fn before_show_main_window(_app: &AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_notifier_watcher_response() {
        assert!(tray_watcher_response(b"(true,)\n"));
        assert!(!tray_watcher_response(b"(false,)\n"));
        assert!(!tray_watcher_response(b"invalid"));
    }
}
