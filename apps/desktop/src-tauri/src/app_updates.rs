use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

use serde::Serialize;
use tauri::{AppHandle, ipc::Channel};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{CommandResult, LocalizedMessage};

const RELEASE_BASE_URL: &str = "https://github.com/starroyhq/agentkib/releases/tag";

#[derive(Default)]
pub(crate) struct AppUpdateRuntime {
    pending: Mutex<Option<Update>>,
    checking: AtomicBool,
    installing: AtomicBool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AppUpdateInstallMode {
    InApp,
    Manual,
}

#[derive(Debug, Serialize)]
pub(crate) struct AppUpdateInfo {
    current_version: String,
    version: String,
    published_at: Option<String>,
    notes: Option<String>,
    release_url: String,
    install_mode: AppUpdateInstallMode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "kebab-case")]
pub(crate) enum AppUpdateProgress {
    Started {
        content_length: Option<u64>,
    },
    Progress {
        downloaded: u64,
        content_length: Option<u64>,
    },
    Finished,
}

struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn acquire(flag: &AtomicBool) -> CommandResult<BusyGuard<'_>> {
    flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map(|_| BusyGuard(flag))
        .map_err(|_| LocalizedMessage::new("errors.updateBusy"))
}

fn install_mode_for_platform(platform: &str, appimage: bool) -> AppUpdateInstallMode {
    if platform == "linux" && !appimage {
        AppUpdateInstallMode::Manual
    } else {
        AppUpdateInstallMode::InApp
    }
}

fn current_install_mode() -> AppUpdateInstallMode {
    install_mode_for_platform(std::env::consts::OS, std::env::var_os("APPIMAGE").is_some())
}

fn update_error(key: &str, error: impl std::fmt::Display) -> LocalizedMessage {
    LocalizedMessage::with_detail(key, error.to_string())
}

#[tauri::command]
pub(crate) async fn check_app_update(
    app: AppHandle,
    state: tauri::State<'_, AppUpdateRuntime>,
) -> CommandResult<Option<AppUpdateInfo>> {
    if state.installing.load(Ordering::SeqCst) {
        return Err(LocalizedMessage::new("errors.updateBusy"));
    }
    let _busy = acquire(&state.checking)?;

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            *state.pending.lock().expect("app update state poisoned") = None;
            return Err(update_error("errors.updateCheckFailed", error));
        }
    };
    let result = updater.check().await;

    let update = match result {
        Ok(update) => update,
        Err(error) => {
            *state.pending.lock().expect("app update state poisoned") = None;
            return Err(update_error("errors.updateCheckFailed", error));
        }
    };

    let Some(update) = update else {
        *state.pending.lock().expect("app update state poisoned") = None;
        return Ok(None);
    };

    let info = AppUpdateInfo {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        published_at: update
            .raw_json
            .get("pub_date")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        notes: update.body.clone(),
        release_url: format!("{RELEASE_BASE_URL}/v{}", update.version),
        install_mode: current_install_mode(),
    };
    *state.pending.lock().expect("app update state poisoned") = Some(update);
    Ok(Some(info))
}

#[tauri::command]
pub(crate) async fn install_app_update(
    app: AppHandle,
    state: tauri::State<'_, AppUpdateRuntime>,
    version: String,
    on_event: Channel<AppUpdateProgress>,
) -> CommandResult<()> {
    if state.checking.load(Ordering::SeqCst) {
        return Err(LocalizedMessage::new("errors.updateBusy"));
    }
    let _busy = acquire(&state.installing)?;

    if current_install_mode() == AppUpdateInstallMode::Manual {
        return Err(LocalizedMessage::new("errors.updateManualInstallRequired"));
    }

    let update = state
        .pending
        .lock()
        .expect("app update state poisoned")
        .take()
        .ok_or_else(|| LocalizedMessage::new("errors.updateNotFound"))?;
    if update.version != version {
        return Err(LocalizedMessage::new("errors.updateChanged"));
    }

    let started_events = on_event.clone();
    let progress_events = on_event.clone();
    let finished_events = on_event.clone();
    let mut started = false;
    let mut downloaded = 0_u64;
    update
        .download_and_install(
            move |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = started_events.send(AppUpdateProgress::Started { content_length });
                }
                downloaded = downloaded.saturating_add(chunk_length as u64);
                let _ = progress_events.send(AppUpdateProgress::Progress {
                    downloaded,
                    content_length,
                });
            },
            move || {
                let _ = finished_events.send(AppUpdateProgress::Finished);
            },
        )
        .await
        .map_err(|error| update_error("errors.updateInstallFailed", error))?;

    #[cfg(not(target_os = "windows"))]
    {
        app.restart()
    }
    #[cfg(target_os = "windows")]
    {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_packages_use_manual_updates_on_linux() {
        assert_eq!(
            install_mode_for_platform("linux", false),
            AppUpdateInstallMode::Manual
        );
        assert_eq!(
            install_mode_for_platform("linux", true),
            AppUpdateInstallMode::InApp
        );
    }

    #[test]
    fn desktop_bundles_update_in_app_on_macos_and_windows() {
        assert_eq!(
            install_mode_for_platform("macos", false),
            AppUpdateInstallMode::InApp
        );
        assert_eq!(
            install_mode_for_platform("windows", false),
            AppUpdateInstallMode::InApp
        );
    }

    #[test]
    fn busy_guard_releases_the_operation_lock() {
        let busy = AtomicBool::new(false);
        let guard = acquire(&busy).unwrap();
        assert!(busy.load(Ordering::SeqCst));
        assert!(acquire(&busy).is_err());
        drop(guard);
        assert!(!busy.load(Ordering::SeqCst));
    }
}
