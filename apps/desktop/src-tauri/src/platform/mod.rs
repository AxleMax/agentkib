//! Desktop-shell platform hooks.
//!
//! Cross-crate filesystem, command, path, and process primitives belong in
//! `agentkib-platform`. This module is intentionally limited to Tauri window
//! and tray behavior that differs between desktop operating systems.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub(crate) use linux::*;
#[cfg(target_os = "macos")]
pub(crate) use macos::*;
#[cfg(target_os = "windows")]
pub(crate) use windows::*;

#[derive(Debug)]
pub(crate) enum OpenSystemSettingsError {
    #[cfg(target_os = "linux")]
    Unsupported,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    Launch(String),
}
