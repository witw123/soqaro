use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const STAMP_FILE_NAME: &str = ".webview-cache-stamp";

const CHROMIUM_CACHE_SUBDIRS: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "Shared Dictionary",
    "Service Worker/CacheStorage",
    "Service Worker/ScriptCache",
];

/// Clears stale WebView HTTP/code caches when the app is freshly installed,
/// updated, or reinstalled, while preserving cookies, localStorage, and IndexedDB.
pub fn clear_stale_webview_cache(identifier: &str, app_version: &str) {
    let stamp = build_install_stamp(app_version);
    let Some(app_data_dir) = resolve_app_local_data_dir(identifier) else {
        return;
    };
    let app_cache_dir = resolve_app_cache_dir(identifier);
    let _ = clear_stale_webview_cache_in(&app_data_dir, app_cache_dir.as_deref(), &stamp);
}

fn build_install_stamp(app_version: &str) -> String {
    let exe_meta = std::env::current_exe()
        .ok()
        .and_then(|path| fs::metadata(path).ok())
        .map(|meta| {
            let size = meta.len();
            let modified_nanos = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|dur| dur.as_nanos())
                .unwrap_or(0);
            format!("{size}:{modified_nanos}")
        })
        .unwrap_or_else(|| "unknown".to_string());

    format!("{app_version}:{exe_meta}")
}

fn resolve_app_local_data_dir(identifier: &str) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA").map(|dir| PathBuf::from(dir).join(identifier))
    }

    #[cfg(target_os = "linux")]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .map(|dir| dir.join(identifier))
    }

    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library/Application Support").join(identifier))
    }
}

fn resolve_app_cache_dir(identifier: &str) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let _ = identifier;
        None
    }

    #[cfg(target_os = "linux")]
    {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
            .map(|dir| dir.join(identifier))
    }

    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Caches").join(identifier))
    }
}

fn clear_stale_webview_cache_in(
    app_data_dir: &Path,
    app_cache_dir: Option<&Path>,
    current_stamp: &str,
) -> bool {
    let stamp_path = app_data_dir.join(STAMP_FILE_NAME);
    if let Ok(existing) = fs::read_to_string(&stamp_path) {
        if existing.trim() == current_stamp {
            return false;
        }
    }

    clear_ebwebview_cache_dirs(&app_data_dir.join("EBWebView"));
    clear_dir_if_exists(&app_data_dir.join("CacheStorage"));
    clear_dir_if_exists(&app_data_dir.join("ServiceWorkers"));

    if let Some(cache_dir) = app_cache_dir {
        clear_directory_contents(cache_dir);
    }

    if fs::create_dir_all(app_data_dir).is_ok() {
        let _ = fs::write(&stamp_path, current_stamp);
    }
    true
}

fn clear_ebwebview_cache_dirs(ebwebview_dir: &Path) {
    if !ebwebview_dir.is_dir() {
        return;
    }

    let mut targets = vec![ebwebview_dir.to_path_buf(), ebwebview_dir.join("Default")];
    if let Ok(entries) = fs::read_dir(ebwebview_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with("Profile ") && entry.path().is_dir() {
                targets.push(entry.path());
            }
        }
    }

    for profile_dir in targets {
        if !profile_dir.is_dir() {
            continue;
        }
        for rel in CHROMIUM_CACHE_SUBDIRS {
            clear_dir_if_exists(&profile_dir.join(rel));
        }
    }
}

fn clear_dir_if_exists(dir: &Path) {
    if dir.exists() {
        let _ = fs::remove_dir_all(dir);
    }
}

fn clear_directory_contents(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let _ = fs::remove_dir_all(path);
        } else {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(prefix: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "soqaro-{prefix}-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn seed_webview_profile(data_dir: &Path, cache_dir: &Path) {
        let profile = data_dir.join("EBWebView/Default");
        for rel in [
            "Cache",
            "Code Cache",
            "GPUCache",
            "Service Worker/CacheStorage",
            "Network",
            "Local Storage",
            "IndexedDB",
        ] {
            let dir = profile.join(rel);
            fs::create_dir_all(&dir).expect("create profile subdir");
            fs::write(dir.join("sample.dat"), b"data").expect("write sample");
        }
        fs::create_dir_all(cache_dir).expect("create cache dir");
        fs::write(cache_dir.join("http.bin"), b"cached").expect("write cache");
    }

    #[test]
    fn clears_cache_on_first_run_and_reinstall_while_preserving_user_storage() {
        let root = TempDirGuard::new("cache-cleanup");
        let data_dir = root.path.join("data");
        let cache_dir = root.path.join("cache");
        seed_webview_profile(&data_dir, &cache_dir);

        let cleared_first =
            clear_stale_webview_cache_in(&data_dir, Some(&cache_dir), "1.0.1:100:1");
        assert!(cleared_first);

        let profile = data_dir.join("EBWebView/Default");
        assert!(!profile.join("Cache").exists());
        assert!(!profile.join("Code Cache").exists());
        assert!(!profile.join("GPUCache").exists());
        assert!(!profile.join("Service Worker/CacheStorage").exists());
        assert!(!cache_dir.join("http.bin").exists());

        // Cookies, Local Storage, and IndexedDB must stay intact
        assert!(profile.join("Network/sample.dat").exists());
        assert!(profile.join("Local Storage/sample.dat").exists());
        assert!(profile.join("IndexedDB/sample.dat").exists());

        // Seed fresh cache again and verify matching stamp skips cleanup
        seed_webview_profile(&data_dir, &cache_dir);
        let cleared_same =
            clear_stale_webview_cache_in(&data_dir, Some(&cache_dir), "1.0.1:100:1");
        assert!(!cleared_same);
        assert!(profile.join("Cache/sample.dat").exists());
        assert!(cache_dir.join("http.bin").exists());

        // Reinstall/upgrade changes stamp -> clears cache again
        let cleared_reinstall =
            clear_stale_webview_cache_in(&data_dir, Some(&cache_dir), "1.0.1:100:2");
        assert!(cleared_reinstall);
        assert!(!profile.join("Cache").exists());
        assert!(!cache_dir.join("http.bin").exists());
        assert!(profile.join("Network/sample.dat").exists());
        assert!(profile.join("Local Storage/sample.dat").exists());
        assert!(profile.join("IndexedDB/sample.dat").exists());
    }
}
