use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;
use tauri::Url;

use crate::url_guard::{resolve_and_verify_public_addrs, validate_public_https_url};

const MAX_DOWNLOAD_BYTES: usize = 200 * 1024 * 1024;
const MAX_REDIRECT_HOPS: usize = 5;
const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDownloadResponse {
    pub data_base64: String,
    pub content_type: String,
    pub content_length: usize,
}

fn is_allowed_request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "referer" | "user-agent" | "range"
    )
}

fn filter_allowed_headers(headers: Option<&HashMap<String, String>>) -> Vec<(reqwest::header::HeaderName, reqwest::header::HeaderValue)> {
    let Some(map) = headers else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for (k, v) in map {
        if !is_allowed_request_header(k) {
            continue;
        }
        if let (Ok(hn), Ok(hv)) = (
            k.parse::<reqwest::header::HeaderName>(),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            result.push((hn, hv));
        }
    }
    result
}

fn build_pinned_client(url: &Url) -> Result<reqwest::Client, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Download URL missing host".to_string())?;
    let addrs = resolve_and_verify_public_addrs(url)?;
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .user_agent(DEFAULT_USER_AGENT)
        .resolve_to_addrs(host, &addrs)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))
}

pub async fn download_direct_native(
    url: String,
    headers: Option<HashMap<String, String>>,
    _concurrent_parts: Option<usize>,
) -> Result<NativeDownloadResponse, String> {
    let mut current_url = validate_public_https_url(&url)?;
    let safe_headers = filter_allowed_headers(headers.as_ref());

    let mut res = None;
    for hop in 0..=MAX_REDIRECT_HOPS {
        let client = build_pinned_client(&current_url)?;
        let mut req = client.get(current_url.as_str());
        for (hn, hv) in &safe_headers {
            req = req.header(hn.clone(), hv.clone());
        }

        let response = req
            .send()
            .await
            .map_err(|e| format!("Direct download request failed: {e}"))?;

        if response.status().is_redirection() {
            if hop == MAX_REDIRECT_HOPS {
                return Err("Too many redirects during direct download".to_string());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "Redirect missing Location header".to_string())?;
            let resolved = current_url
                .join(location)
                .map_err(|_| "Invalid redirect Location URL".to_string())?;
            current_url = validate_public_https_url(resolved.as_str())?;
            continue;
        }

        res = Some(response);
        break;
    }

    let mut res = res.ok_or_else(|| "Direct download received no response".to_string())?;
    if !res.status().is_success() {
        return Err(format!("Download failed with status: {}", res.status()));
    }

    if let Some(len) = res.content_length() {
        if len > MAX_DOWNLOAD_BYTES as u64 {
            return Err("Download exceeds maximum allowed size".to_string());
        }
    }

    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let mut bytes = Vec::new();
    while let Some(chunk) = res
        .chunk()
        .await
        .map_err(|e| format!("Failed to read response body: {e}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_DOWNLOAD_BYTES {
            return Err("Download exceeds maximum allowed size".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }

    let data_base64 = STANDARD.encode(&bytes);
    Ok(NativeDownloadResponse {
        data_base64,
        content_type,
        content_length: bytes.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_allowlist_filters_disallowed_headers() {
        let mut map = HashMap::new();
        map.insert("Referer".to_string(), "https://www.bilibili.com/".to_string());
        map.insert("User-Agent".to_string(), "TestAgent/1.0".to_string());
        map.insert("Range".to_string(), "bytes=0-1023".to_string());
        map.insert("Cookie".to_string(), "session=secret".to_string());
        map.insert("Authorization".to_string(), "Bearer secret".to_string());
        map.insert("Host".to_string(), "internal.service".to_string());

        let filtered = filter_allowed_headers(Some(&map));
        let keys: Vec<String> = filtered.iter().map(|(k, _)| k.as_str().to_string()).collect();
        assert_eq!(filtered.len(), 3);
        assert!(keys.contains(&"referer".to_string()));
        assert!(keys.contains(&"user-agent".to_string()));
        assert!(keys.contains(&"range".to_string()));
    }

    #[test]
    fn blocks_private_and_non_https_downloads_before_connect() {
        tauri::async_runtime::block_on(async {
            assert!(download_direct_native("http://example.com/a.mp3".to_string(), None, None).await.is_err());
            assert!(download_direct_native("https://127.0.0.1/a.mp3".to_string(), None, None).await.is_err());
            assert!(download_direct_native("https://169.254.169.254/latest".to_string(), None, None).await.is_err());
            assert!(download_direct_native("file:///etc/passwd".to_string(), None, None).await.is_err());
        });
    }
}
