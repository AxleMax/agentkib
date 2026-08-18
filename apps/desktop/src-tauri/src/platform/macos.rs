use std::process::Command;

use tauri::{ActivationPolicy, AppHandle};

use super::OpenSystemSettingsError;

pub(crate) const SHOW_TRAY_MENU_ON_LEFT_CLICK: bool = false;

pub(crate) fn open_files_and_folders_settings() -> Result<(), OpenSystemSettingsError> {
    const FILES_AND_FOLDERS_SETTINGS_URL: &str =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";
    Command::new("/usr/bin/open")
        .arg(FILES_AND_FOLDERS_SETTINGS_URL)
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

pub(crate) fn after_hide_to_tray(app: &AppHandle, tray_available: bool) {
    if tray_available {
        let _ = app.set_activation_policy(ActivationPolicy::Accessory);
    }
}

pub(crate) fn before_show_main_window(app: &AppHandle) {
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
}
