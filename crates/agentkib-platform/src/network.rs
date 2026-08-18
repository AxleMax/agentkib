//! Platform network settings used by child processes.

/// Returns the current user's enabled Windows Internet proxy as an HTTP proxy URL.
///
/// Windows stores either one proxy for every protocol (`host:port`) or a
/// semicolon-separated map (`http=host:port;https=host:port`). HTTPS is
/// preferred because quota collection calls HTTPS endpoints.
#[cfg(target_os = "windows")]
pub fn system_proxy_url() -> Option<String> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let internet_settings = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let enabled = internet_settings.get_value::<u32, _>("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    let value = internet_settings
        .get_value::<String, _>("ProxyServer")
        .ok()?;
    parse_windows_proxy_server(&value)
}

#[cfg(not(target_os = "windows"))]
pub fn system_proxy_url() -> Option<String> {
    None
}

#[cfg(any(target_os = "windows", test))]
fn parse_windows_proxy_server(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }

    let candidate = if value.contains('=') {
        let entries = value
            .split(';')
            .filter_map(|entry| entry.split_once('='))
            .map(|(protocol, address)| (protocol.trim(), address.trim()))
            .filter(|(_, address)| !address.is_empty())
            .collect::<Vec<_>>();
        entries
            .iter()
            .find(|(protocol, _)| protocol.eq_ignore_ascii_case("https"))
            .or_else(|| {
                entries
                    .iter()
                    .find(|(protocol, _)| protocol.eq_ignore_ascii_case("http"))
            })
            .map(|(_, address)| *address)?
    } else {
        value
    };

    if candidate.contains("://") {
        Some(candidate.to_string())
    } else {
        Some(format!("http://{candidate}"))
    }
}

#[cfg(test)]
mod tests {
    use super::parse_windows_proxy_server;

    #[test]
    fn parses_single_windows_proxy() {
        assert_eq!(
            parse_windows_proxy_server("127.0.0.1:33210").as_deref(),
            Some("http://127.0.0.1:33210")
        );
    }

    #[test]
    fn prefers_https_proxy_from_protocol_map() {
        assert_eq!(
            parse_windows_proxy_server("http=plain.example:80; https=secure.example:443")
                .as_deref(),
            Some("http://secure.example:443")
        );
    }

    #[test]
    fn preserves_an_explicit_proxy_scheme() {
        assert_eq!(
            parse_windows_proxy_server("https=http://proxy.example:8443").as_deref(),
            Some("http://proxy.example:8443")
        );
    }

    #[test]
    fn rejects_empty_or_unsupported_proxy_maps() {
        assert_eq!(parse_windows_proxy_server("  "), None);
        assert_eq!(parse_windows_proxy_server("socks=127.0.0.1:1080"), None);
    }
}
