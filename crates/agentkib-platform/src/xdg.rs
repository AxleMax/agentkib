//! Linux/XDG base-directory helpers.
//!
//! Desktop applications do not reliably inherit an interactive shell, so
//! callers should use these paths instead of assuming shell startup files ran.

use std::env;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XdgDirs {
    pub home: PathBuf,
    pub config_home: PathBuf,
    pub data_home: PathBuf,
    pub state_home: PathBuf,
    pub cache_home: PathBuf,
    pub data_dirs: Vec<PathBuf>,
}

impl XdgDirs {
    pub fn from_environment() -> Option<Self> {
        let home = env::var_os("HOME").map(PathBuf::from)?;
        Some(Self::from_values(
            home,
            env::var_os("XDG_CONFIG_HOME"),
            env::var_os("XDG_DATA_HOME"),
            env::var_os("XDG_STATE_HOME"),
            env::var_os("XDG_CACHE_HOME"),
            env::var_os("XDG_DATA_DIRS"),
        ))
    }

    fn from_values(
        home: PathBuf,
        config_home: Option<impl Into<PathBuf>>,
        data_home: Option<impl Into<PathBuf>>,
        state_home: Option<impl Into<PathBuf>>,
        cache_home: Option<impl Into<PathBuf>>,
        data_dirs: Option<impl AsRef<std::ffi::OsStr>>,
    ) -> Self {
        let config_home = absolute_or(config_home, || home.join(".config"));
        let data_home = absolute_or(data_home, || home.join(".local/share"));
        let state_home = absolute_or(state_home, || home.join(".local/state"));
        let cache_home = absolute_or(cache_home, || home.join(".cache"));
        let mut system_data_dirs = data_dirs
            .map(|value| env::split_paths(value.as_ref()).collect::<Vec<_>>())
            .filter(|paths| !paths.is_empty())
            .unwrap_or_else(|| {
                vec![
                    PathBuf::from("/usr/local/share"),
                    PathBuf::from("/usr/share"),
                ]
            });
        system_data_dirs.retain(|path| path.is_absolute());
        let mut resolved_data_dirs = vec![data_home.clone()];
        resolved_data_dirs.extend(system_data_dirs);
        deduplicate(&mut resolved_data_dirs);
        Self {
            home,
            config_home,
            data_home,
            state_home,
            cache_home,
            data_dirs: resolved_data_dirs,
        }
    }

    pub fn application_dirs(&self) -> Vec<PathBuf> {
        self.data_dirs
            .iter()
            .map(|path| path.join("applications"))
            .collect()
    }
}

pub fn home_dir() -> Option<PathBuf> {
    XdgDirs::from_environment().map(|dirs| dirs.home)
}

pub fn config_home() -> Option<PathBuf> {
    XdgDirs::from_environment().map(|dirs| dirs.config_home)
}

pub fn data_home() -> Option<PathBuf> {
    XdgDirs::from_environment().map(|dirs| dirs.data_home)
}

pub fn state_home() -> Option<PathBuf> {
    XdgDirs::from_environment().map(|dirs| dirs.state_home)
}

pub fn cache_home() -> Option<PathBuf> {
    XdgDirs::from_environment().map(|dirs| dirs.cache_home)
}

pub fn data_dirs() -> Vec<PathBuf> {
    XdgDirs::from_environment().map_or_else(Vec::new, |dirs| dirs.data_dirs)
}

pub fn application_dirs() -> Vec<PathBuf> {
    XdgDirs::from_environment().map_or_else(Vec::new, |dirs| dirs.application_dirs())
}

fn absolute_or(value: Option<impl Into<PathBuf>>, fallback: impl FnOnce() -> PathBuf) -> PathBuf {
    value
        .map(Into::into)
        .filter(|path: &PathBuf| path.is_absolute())
        .unwrap_or_else(fallback)
}

fn deduplicate(paths: &mut Vec<PathBuf>) {
    let mut seen = std::collections::HashSet::new();
    paths.retain(|path| seen.insert(crate::path::identity(path)));
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn applies_xdg_defaults() {
        let dirs = XdgDirs::from_values(
            PathBuf::from("/home/tester"),
            None::<PathBuf>,
            None::<PathBuf>,
            None::<PathBuf>,
            None::<PathBuf>,
            None::<OsString>,
        );
        assert_eq!(dirs.config_home, PathBuf::from("/home/tester/.config"));
        assert_eq!(dirs.data_home, PathBuf::from("/home/tester/.local/share"));
        assert_eq!(dirs.state_home, PathBuf::from("/home/tester/.local/state"));
        assert_eq!(dirs.cache_home, PathBuf::from("/home/tester/.cache"));
        assert_eq!(
            dirs.data_dirs,
            vec![
                PathBuf::from("/home/tester/.local/share"),
                PathBuf::from("/usr/local/share"),
                PathBuf::from("/usr/share")
            ]
        );
    }

    #[test]
    fn ignores_relative_xdg_overrides_and_data_dirs() {
        let dirs = XdgDirs::from_values(
            PathBuf::from("/home/tester"),
            Some(PathBuf::from("relative/config")),
            Some(PathBuf::from("/data/home")),
            Some(PathBuf::from("relative/state")),
            Some(PathBuf::from("/cache/home")),
            Some(OsString::from("relative:/opt/share:/usr/share")),
        );
        assert_eq!(dirs.config_home, PathBuf::from("/home/tester/.config"));
        assert_eq!(dirs.data_home, PathBuf::from("/data/home"));
        assert_eq!(dirs.state_home, PathBuf::from("/home/tester/.local/state"));
        assert_eq!(dirs.cache_home, PathBuf::from("/cache/home"));
        assert_eq!(
            dirs.data_dirs,
            vec![
                PathBuf::from("/data/home"),
                PathBuf::from("/opt/share"),
                PathBuf::from("/usr/share")
            ]
        );
    }

    #[test]
    fn application_directories_follow_data_search_order() {
        let dirs = XdgDirs::from_values(
            PathBuf::from("/home/tester"),
            None::<PathBuf>,
            Some(PathBuf::from("/data/home")),
            None::<PathBuf>,
            None::<PathBuf>,
            Some(OsString::from("/opt/share")),
        );
        assert_eq!(
            dirs.application_dirs(),
            vec![
                PathBuf::from("/data/home/applications"),
                PathBuf::from("/opt/share/applications")
            ]
        );
    }
}
