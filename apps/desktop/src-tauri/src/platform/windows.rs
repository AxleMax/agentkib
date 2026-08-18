use std::process::Command;

use tauri::AppHandle;

use super::OpenSystemSettingsError;

pub(crate) const SHOW_TRAY_MENU_ON_LEFT_CLICK: bool = true;

pub(crate) fn open_files_and_folders_settings() -> Result<(), OpenSystemSettingsError> {
    Command::new("cmd.exe")
        .args([
            "/D",
            "/C",
            "start",
            "",
            "ms-settings:privacy-broadfilesystemaccess",
        ])
        .spawn()
        .map_err(|error| OpenSystemSettingsError::Launch(error.to_string()))?;
    Ok(())
}

pub(crate) fn tray_host_available() -> bool {
    true
}

pub(crate) fn resolve_tray_setup(result: tauri::Result<()>) -> tauri::Result<bool> {
    result?;
    Ok(true)
}

pub(crate) fn after_hide_to_tray(_app: &AppHandle, _tray_available: bool) {}

pub(crate) fn before_show_main_window(_app: &AppHandle) {}
