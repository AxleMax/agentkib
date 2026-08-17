use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceApplicationCategory {
    Editor,
    Terminal,
    FileManager,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceApplication {
    pub id: String,
    pub name: String,
    pub category: WorkspaceApplicationCategory,
}

#[derive(Debug, Clone)]
struct DetectedApplication {
    public: WorkspaceApplication,
    launcher: Launcher,
}

#[cfg(target_os = "macos")]
type MacApplicationSpec = (
    &'static str,
    &'static str,
    WorkspaceApplicationCategory,
    &'static [&'static str],
    &'static [&'static str],
);

#[derive(Debug, Clone)]
enum Launcher {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    Executable(PathBuf, Vec<String>),
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    Terminal(PathBuf, Vec<String>),
    #[cfg(target_os = "macos")]
    MacApplication(PathBuf),
    #[cfg(target_os = "linux")]
    XdgOpen(PathBuf),
}

pub fn detect_workspace_applications() -> Vec<WorkspaceApplication> {
    detected_applications()
        .into_iter()
        .map(|application| application.public)
        .collect()
}

pub fn open_workspace(application_id: &str, workspace: &Path) -> io::Result<()> {
    let workspace = crate::path::canonicalize(workspace)?;
    if !workspace.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "workspace is not a directory",
        ));
    }
    let application = detected_applications()
        .into_iter()
        .find(|application| application.public.id == application_id)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "workspace application is not installed",
            )
        })?;
    launch(&application.launcher, &workspace)
}

fn detected_applications() -> Vec<DetectedApplication> {
    let mut applications = platform_applications();
    let mut seen = HashSet::new();
    applications.retain(|application| seen.insert(application.public.id.clone()));
    applications
}

fn application(
    id: &str,
    name: &str,
    category: WorkspaceApplicationCategory,
    launcher: Launcher,
) -> DetectedApplication {
    DetectedApplication {
        public: WorkspaceApplication {
            id: id.into(),
            name: name.into(),
            category,
        },
        launcher,
    }
}

#[cfg(target_os = "macos")]
fn platform_applications() -> Vec<DetectedApplication> {
    let mut output = Vec::new();
    for (id, name, category, app_names, bundle_ids) in mac_specs() {
        if let Some(path) = find_mac_application(app_names, bundle_ids) {
            output.push(application(
                id,
                name,
                *category,
                Launcher::MacApplication(path),
            ));
        }
    }
    output
}

#[cfg(target_os = "macos")]
fn mac_specs() -> &'static [MacApplicationSpec] {
    use WorkspaceApplicationCategory::{Editor, FileManager, Terminal};
    &[
        (
            "finder",
            "Finder",
            FileManager,
            &["Finder.app"],
            &["com.apple.finder"],
        ),
        (
            "terminal",
            "Terminal",
            Terminal,
            &["Terminal.app"],
            &["com.apple.Terminal"],
        ),
        (
            "iterm2",
            "iTerm2",
            Terminal,
            &["iTerm.app"],
            &["com.googlecode.iterm2"],
        ),
        (
            "vscode",
            "Visual Studio Code",
            Editor,
            &["Visual Studio Code.app"],
            &["com.microsoft.VSCode"],
        ),
        (
            "cursor",
            "Cursor",
            Editor,
            &["Cursor.app"],
            &["com.todesktop.230313mzl4w4u92"],
        ),
        (
            "xcode",
            "Xcode",
            Editor,
            &["Xcode.app"],
            &["com.apple.dt.Xcode"],
        ),
        (
            "android-studio",
            "Android Studio",
            Editor,
            &["Android Studio.app"],
            &["com.google.android.studio"],
        ),
        (
            "intellij-idea",
            "IntelliJ IDEA",
            Editor,
            &["IntelliJ IDEA.app", "IntelliJ IDEA CE.app"],
            &["com.jetbrains.intellij", "com.jetbrains.intellij.ce"],
        ),
        (
            "pycharm",
            "PyCharm",
            Editor,
            &["PyCharm.app", "PyCharm CE.app"],
            &["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"],
        ),
        (
            "webstorm",
            "WebStorm",
            Editor,
            &["WebStorm.app"],
            &["com.jetbrains.WebStorm"],
        ),
        (
            "goland",
            "GoLand",
            Editor,
            &["GoLand.app"],
            &["com.jetbrains.goland"],
        ),
        (
            "rider",
            "Rider",
            Editor,
            &["Rider.app"],
            &["com.jetbrains.rider"],
        ),
    ]
}

#[cfg(target_os = "macos")]
fn find_mac_application(names: &[&str], bundle_ids: &[&str]) -> Option<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
        PathBuf::from("/System/Library/CoreServices"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    roots
        .into_iter()
        .flat_map(|root| names.iter().map(move |name| root.join(name)))
        .find(|path| {
            path.is_dir()
                && path.join("Contents/Info.plist").is_file()
                && path
                    .join("Contents/MacOS")
                    .read_dir()
                    .ok()
                    .is_some_and(|mut entries| {
                        entries.any(|entry| entry.ok().is_some_and(|entry| entry.path().is_file()))
                    })
                && mac_bundle_identifier(path)
                    .is_some_and(|identifier| bundle_ids.contains(&identifier.as_str()))
        })
}

#[cfg(target_os = "macos")]
fn mac_bundle_identifier(application: &Path) -> Option<String> {
    let output = Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print :CFBundleIdentifier"])
        .arg(application.join("Contents/Info.plist"))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(target_os = "windows")]
fn platform_applications() -> Vec<DetectedApplication> {
    use WorkspaceApplicationCategory::{Editor, FileManager, Terminal};
    let mut output = Vec::new();
    if let Some(path) = crate::command::resolve("explorer.exe") {
        output.push(application(
            "explorer",
            "File Explorer",
            FileManager,
            Launcher::Executable(path, Vec::new()),
        ));
    }
    let specs = [
        ("vscode", "Visual Studio Code", Editor, &["code.exe"][..]),
        ("cursor", "Cursor", Editor, &["cursor.exe"][..]),
        (
            "android-studio",
            "Android Studio",
            Editor,
            &["studio64.exe", "studio.exe"][..],
        ),
        (
            "intellij-idea",
            "IntelliJ IDEA",
            Editor,
            &["idea64.exe"][..],
        ),
        ("pycharm", "PyCharm", Editor, &["pycharm64.exe"][..]),
        ("webstorm", "WebStorm", Editor, &["webstorm64.exe"][..]),
        ("goland", "GoLand", Editor, &["goland64.exe"][..]),
        ("rider", "Rider", Editor, &["rider64.exe"][..]),
    ];
    if let Some(path) = crate::command::resolve("wt.exe") {
        output.push(application(
            "windows-terminal",
            "Windows Terminal",
            Terminal,
            Launcher::Terminal(path, vec!["-d".into()]),
        ));
    }
    let directories = windows_application_directories();
    for (id, name, category, names) in specs {
        if let Some(path) = names.iter().find_map(|name| {
            windows_app_path(name).or_else(|| {
                crate::command::resolve_in(name, directories.iter().map(PathBuf::as_path))
            })
        }) {
            output.push(application(
                id,
                name,
                category,
                Launcher::Executable(path, Vec::new()),
            ));
        }
    }
    output
}

#[cfg(target_os = "windows")]
fn windows_app_path(executable_name: &str) -> Option<PathBuf> {
    const ROOTS: [&str; 3] = [
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths",
        r"HKLM\Software\Microsoft\Windows\CurrentVersion\App Paths",
        r"HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths",
    ];
    ROOTS.into_iter().find_map(|root| {
        let key = format!(r"{root}\{executable_name}");
        let output = Command::new("reg.exe")
            .args(["query", &key, "/ve"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        parse_windows_app_path(&String::from_utf8_lossy(&output.stdout))
    })
}

#[cfg(target_os = "windows")]
fn parse_windows_app_path(output: &str) -> Option<PathBuf> {
    output.lines().find_map(|line| {
        let (_, value) = line
            .split_once("REG_EXPAND_SZ")
            .or_else(|| line.split_once("REG_SZ"))?;
        let expanded = expand_windows_environment(value.trim());
        let path = PathBuf::from(expanded.trim_matches('"'));
        crate::command::is_executable(&path).then_some(path)
    })
}

#[cfg(target_os = "windows")]
fn expand_windows_environment(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut remaining = value;
    while let Some(start) = remaining.find('%') {
        output.push_str(&remaining[..start]);
        let tail = &remaining[start + 1..];
        let Some(end) = tail.find('%') else {
            output.push_str(&remaining[start..]);
            return output;
        };
        let name = &tail[..end];
        match std::env::var(name) {
            Ok(replacement) => output.push_str(&replacement),
            Err(_) => output.push_str(&remaining[start..start + end + 2]),
        }
        remaining = &tail[end + 1..];
    }
    output.push_str(remaining);
    output
}

#[cfg(target_os = "windows")]
fn windows_application_directories() -> Vec<PathBuf> {
    let mut output = crate::command::search_directories();
    for variable in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        let Some(root) = std::env::var_os(variable).map(PathBuf::from) else {
            continue;
        };
        output.extend([
            root.join("Programs/Microsoft VS Code/bin"),
            root.join("Programs/Microsoft VS Code"),
            root.join("Programs/Cursor/resources/app/bin"),
            root.join("Programs/Cursor"),
            root.join("JetBrains/Toolbox/scripts"),
        ]);
        if let Ok(entries) = root.join("JetBrains/Toolbox/apps").read_dir() {
            for entry in entries.flatten() {
                collect_bin_directories(&entry.path(), 5, &mut output);
            }
        }
    }
    output
}

#[cfg(target_os = "windows")]
fn collect_bin_directories(path: &Path, depth: usize, output: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    if path
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("bin"))
    {
        output.push(path.to_path_buf());
    }
    if let Ok(entries) = path.read_dir() {
        for entry in entries.flatten().filter(|entry| entry.path().is_dir()) {
            collect_bin_directories(&entry.path(), depth - 1, output);
        }
    }
}

#[cfg(target_os = "linux")]
fn platform_applications() -> Vec<DetectedApplication> {
    use WorkspaceApplicationCategory::{Editor, FileManager, Terminal};
    let specs = [
        (
            "vscode",
            "Visual Studio Code",
            Editor,
            &["code"][..],
            &["code", "visual-studio-code"][..],
        ),
        (
            "cursor",
            "Cursor",
            Editor,
            &["cursor"][..],
            &["cursor", "cursor-url-handler"][..],
        ),
        (
            "android-studio",
            "Android Studio",
            Editor,
            &["studio", "android-studio"][..],
            &["android-studio"][..],
        ),
        (
            "intellij-idea",
            "IntelliJ IDEA",
            Editor,
            &["idea", "intellij-idea"][..],
            &["jetbrains-idea", "intellij-idea", "idea"][..],
        ),
        (
            "pycharm",
            "PyCharm",
            Editor,
            &["pycharm", "pycharm-community"][..],
            &["jetbrains-pycharm", "pycharm", "pycharm-community"][..],
        ),
        (
            "webstorm",
            "WebStorm",
            Editor,
            &["webstorm"][..],
            &["jetbrains-webstorm", "webstorm"][..],
        ),
        (
            "goland",
            "GoLand",
            Editor,
            &["goland"][..],
            &["jetbrains-goland", "goland"][..],
        ),
        (
            "rider",
            "Rider",
            Editor,
            &["rider"][..],
            &["jetbrains-rider", "rider"][..],
        ),
    ];
    let mut output = Vec::new();
    if let Some(path) = crate::command::resolve("xdg-open") {
        output.push(application(
            "files",
            "Files",
            FileManager,
            Launcher::XdgOpen(path),
        ));
    }
    let search_directories = crate::command::search_directories();
    for (id, name, category, names, desktop_ids) in specs {
        if let Some(path) = names
            .iter()
            .find_map(|name| crate::command::resolve(name))
            .or_else(|| {
                crate::command::desktop_application_executables(desktop_ids, &search_directories)
                    .into_iter()
                    .next()
            })
        {
            output.push(application(
                id,
                name,
                category,
                Launcher::Executable(path, Vec::new()),
            ));
        }
    }
    if let Some(path) = [
        "xdg-terminal-exec",
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "kitty",
        "alacritty",
    ]
    .iter()
    .find_map(|name| crate::command::resolve(name))
    {
        output.push(application(
            "terminal",
            "Terminal",
            Terminal,
            Launcher::Terminal(path, Vec::new()),
        ));
    }
    output
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn platform_applications() -> Vec<DetectedApplication> {
    Vec::new()
}

fn launch(launcher: &Launcher, workspace: &Path) -> io::Result<()> {
    match launcher {
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        Launcher::Executable(executable, arguments) => {
            let mut command = Command::new(executable);
            command
                .args(arguments)
                .arg(workspace)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            configure_detached(&mut command);
            command.spawn()?;
            Ok(())
        }
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        Launcher::Terminal(executable, arguments) => {
            let mut command = Command::new(executable);
            command
                .args(arguments)
                .current_dir(workspace)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            command.arg(workspace);
            configure_detached(&mut command);
            command.spawn()?;
            Ok(())
        }
        #[cfg(target_os = "macos")]
        Launcher::MacApplication(application) => {
            let mut command = Command::new("/usr/bin/open");
            command
                .arg("-a")
                .arg(application)
                .arg(workspace)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            command.spawn()?;
            Ok(())
        }
        #[cfg(target_os = "linux")]
        Launcher::XdgOpen(executable) => {
            Command::new(executable)
                .arg(workspace)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?;
            Ok(())
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn configure_detached(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detected_ids_are_unique() {
        let applications = detect_workspace_applications();
        let ids: HashSet<_> = applications
            .iter()
            .map(|application| &application.id)
            .collect();
        assert_eq!(ids.len(), applications.len());
        assert!(
            applications.iter().any(
                |application| application.category == WorkspaceApplicationCategory::FileManager
            )
        );
    }
}
