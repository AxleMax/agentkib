use std::collections::HashMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum LocalePreference {
    #[default]
    #[serde(rename = "system")]
    System,
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "zh-TW")]
    ZhTw,
    #[serde(rename = "ja-JP")]
    JaJp,
    #[serde(rename = "en-US")]
    EnUs,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SupportedLocale {
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "zh-TW")]
    ZhTw,
    #[serde(rename = "ja-JP")]
    JaJp,
    #[default]
    #[serde(rename = "en-US")]
    EnUs,
}

impl LocalePreference {
    pub fn effective(self) -> SupportedLocale {
        match self {
            Self::System => normalize_locale(tauri_plugin_os::locale().as_deref()),
            Self::ZhCn => SupportedLocale::ZhCn,
            Self::ZhTw => SupportedLocale::ZhTw,
            Self::JaJp => SupportedLocale::JaJp,
            Self::EnUs => SupportedLocale::EnUs,
        }
    }
}

pub fn normalize_locale(locale: Option<&str>) -> SupportedLocale {
    let normalized = locale.unwrap_or_default().replace('_', "-").to_lowercase();
    if normalized == "zh-hant"
        || normalized.starts_with("zh-hant-")
        || ["zh-tw", "zh-hk", "zh-mo"]
            .iter()
            .any(|prefix| normalized == *prefix || normalized.starts_with(&format!("{prefix}-")))
    {
        SupportedLocale::ZhTw
    } else if normalized == "zh"
        || normalized == "zh-hans"
        || normalized.starts_with("zh-hans-")
        || ["zh-cn", "zh-sg"]
            .iter()
            .any(|prefix| normalized == *prefix || normalized.starts_with(&format!("{prefix}-")))
    {
        SupportedLocale::ZhCn
    } else if normalized == "ja" || normalized.starts_with("ja-") {
        SupportedLocale::JaJp
    } else {
        SupportedLocale::EnUs
    }
}

pub fn translate(locale: SupportedLocale, key: &str, params: &[(&str, String)]) -> String {
    let dictionaries = dictionaries();
    let selected = dictionaries
        .get(&locale)
        .expect("supported locale dictionary");
    let english = dictionaries
        .get(&SupportedLocale::EnUs)
        .expect("English dictionary");
    let mut value = selected
        .get(key)
        .or_else(|| english.get(key))
        .cloned()
        .unwrap_or_else(|| key.to_string());
    for (name, replacement) in params {
        value = value.replace(&format!("{{{{{name}}}}}"), replacement);
    }
    value
}

fn dictionaries() -> &'static HashMap<SupportedLocale, HashMap<String, String>> {
    static DICTIONARIES: OnceLock<HashMap<SupportedLocale, HashMap<String, String>>> =
        OnceLock::new();
    DICTIONARIES.get_or_init(|| {
        [
            (
                SupportedLocale::EnUs,
                include_str!("../../src/locales/en-US.json"),
            ),
            (
                SupportedLocale::ZhCn,
                include_str!("../../src/locales/zh-CN.json"),
            ),
            (
                SupportedLocale::ZhTw,
                include_str!("../../src/locales/zh-TW.json"),
            ),
            (
                SupportedLocale::JaJp,
                include_str!("../../src/locales/ja-JP.json"),
            ),
        ]
        .into_iter()
        .map(|(locale, json)| {
            let values = serde_json::from_str(json).expect("valid shared locale JSON");
            (locale, values)
        })
        .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_supported_system_locales() {
        assert_eq!(normalize_locale(Some("zh_Hans_CN")), SupportedLocale::ZhCn);
        assert_eq!(normalize_locale(Some("zh-HK")), SupportedLocale::ZhTw);
        assert_eq!(normalize_locale(Some("ja")), SupportedLocale::JaJp);
        assert_eq!(normalize_locale(Some("en-GB")), SupportedLocale::EnUs);
        assert_eq!(normalize_locale(Some("fr-FR")), SupportedLocale::EnUs);
        assert_eq!(normalize_locale(None), SupportedLocale::EnUs);
    }

    #[test]
    fn falls_back_to_english_and_interpolates() {
        assert_eq!(
            translate(
                SupportedLocale::JaJp,
                "tray.status",
                &[("workspaces", "3".into()), ("attention", "1".into())]
            ),
            "3 ワークスペース · 1 件の要確認"
        );
        assert_eq!(
            translate(SupportedLocale::ZhCn, "missing.key", &[]),
            "missing.key"
        );
    }
}
