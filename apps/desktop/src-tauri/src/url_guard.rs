use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use tauri::Url;

/// Check whether a webview window URL is a trusted Soqaro origin.
pub fn is_trusted_window_url(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };

    if url.scheme() == "https" && host.eq_ignore_ascii_case("soqaro.witw.top") {
        return matches!(url.port(), None | Some(443));
    }

    #[cfg(debug_assertions)]
    {
        if matches!(url.scheme(), "http" | "https")
            && (host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1")
        {
            return true;
        }
    }

    false
}

/// Reject IPC invocations from windows navigated away from trusted Soqaro origins.
pub fn validate_trusted_caller(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window
        .url()
        .map_err(|_| "Failed to inspect caller window URL".to_string())?;
    if !is_trusted_window_url(&url) {
        return Err("Blocked IPC call from untrusted window origin".to_string());
    }
    Ok(())
}

/// Validate external links before passing them to the OS shell.
pub fn validate_external_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().any(|ch| ch.is_control()) {
        return Err("Invalid external URL".to_string());
    }
    let parsed = Url::parse(trimmed).map_err(|_| "Invalid external URL".to_string())?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err("Only http/https external URLs are allowed".to_string());
    }
    #[cfg(not(debug_assertions))]
    if parsed.scheme() != "https" {
        return Err("Only https external URLs are allowed".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("External URL must include a host".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("External URL must not contain credentials".to_string());
    }
    Ok(parsed)
}

/// Return true if an IP address is loopback, private, link-local, multicast, or otherwise non-public.
pub fn is_disallowed_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_disallowed_ipv4(v4),
        IpAddr::V6(v6) => is_disallowed_ipv6(v6),
    }
}

fn is_disallowed_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    let is_cgnat = octets[0] == 100 && (octets[1] & 0b1100_0000) == 64;
    let is_this_network = octets[0] == 0;
    let is_benchmark = octets[0] == 198 && (octets[1] == 18 || octets[1] == 19);
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || is_cgnat
        || is_this_network
        || is_benchmark
}

fn is_disallowed_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_disallowed_ipv4(mapped);
    }
    let segments = ip.segments();
    let is_unique_local = (segments[0] & 0xfe00) == 0xfc00;
    let is_unicast_link_local = (segments[0] & 0xffc0) == 0xfe80;
    let is_documentation = segments[0] == 0x2001 && segments[1] == 0x0db8;
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || is_unique_local
        || is_unicast_link_local
        || is_documentation
}

/// Validate a direct native download URL and return its parsed `Url`.
pub fn validate_public_https_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().any(|ch| ch.is_control()) {
        return Err("Invalid download URL".to_string());
    }
    let parsed = Url::parse(trimmed).map_err(|_| "Invalid download URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Direct download only permits https:// URLs".to_string());
    }
    let Some(host) = parsed.host_str() else {
        return Err("Download URL must include a host".to_string());
    };
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") || host.ends_with(".local") {
        return Err("Refusing private or local hostname".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Download URL must not contain credentials".to_string());
    }
    if let Ok(ip) = host.trim_matches(|c| c == '[' || c == ']').parse::<IpAddr>() {
        if is_disallowed_ip(ip) {
            return Err("Refusing non-public IP address".to_string());
        }
    }
    Ok(parsed)
}

/// Resolve host to socket addresses and verify every resolved IP is globally routable.
pub fn resolve_and_verify_public_addrs(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Download URL missing host".to_string())?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("Failed to resolve download host: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err("Download host resolved to no addresses".to_string());
    }
    for addr in &addrs {
        if is_disallowed_ip(addr.ip()) {
            return Err("Refusing download target resolved to non-public IP".to_string());
        }
    }
    Ok(addrs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusted_window_urls() {
        assert!(is_trusted_window_url(
            &Url::parse("https://soqaro.witw.top/app").unwrap()
        ));
        assert!(!is_trusted_window_url(
            &Url::parse("https://soqaro.witw.top:8443/app").unwrap()
        ));
        assert!(!is_trusted_window_url(
            &Url::parse("https://evil.example/app").unwrap()
        ));
        assert!(!is_trusted_window_url(
            &Url::parse("http://soqaro.witw.top/app").unwrap()
        ));
    }

    #[test]
    fn external_url_validation_blocks_dangerous_schemes() {
        assert!(validate_external_url("https://github.com/witw123/soqaro/releases").is_ok());
        assert!(validate_external_url("file:///C:/Windows/System32/calc.exe").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("ms-msdt:id").is_err());
        assert!(validate_external_url("https://user:pass@example.com/").is_err());
    }

    #[test]
    fn public_download_url_blocks_private_and_non_https() {
        assert!(validate_public_https_url("http://example.com/a.m4a").is_err());
        assert!(validate_public_https_url("https://localhost/a.m4a").is_err());
        assert!(validate_public_https_url("https://127.0.0.1/a.m4a").is_err());
        assert!(validate_public_https_url("https://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_public_https_url("https://10.0.0.1/a.m4a").is_err());
        assert!(validate_public_https_url("https://[::1]/a.m4a").is_err());
        assert!(validate_public_https_url("https://[::ffff:127.0.0.1]/a.m4a").is_err());
        assert!(validate_public_https_url("https://cdn.example.com/audio.m4a").is_ok());
    }

    #[test]
    fn disallowed_ip_covers_special_ranges() {
        assert!(is_disallowed_ip("100.64.0.1".parse().unwrap()));
        assert!(is_disallowed_ip("172.16.0.1".parse().unwrap()));
        assert!(is_disallowed_ip("192.168.1.1".parse().unwrap()));
        assert!(is_disallowed_ip("fc00::1".parse().unwrap()));
        assert!(is_disallowed_ip("fe80::1".parse().unwrap()));
        assert!(!is_disallowed_ip("1.1.1.1".parse().unwrap()));
        assert!(!is_disallowed_ip("2606:4700:4700::1111".parse().unwrap()));
    }
}
