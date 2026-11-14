package com.soqaro.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;
import androidx.core.content.pm.PackageInfoCompat;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Clears stale WebView HTTP/code caches whenever the APK is freshly installed,
 * updated, or reinstalled over existing app data, while preserving cookies,
 * localStorage, IndexedDB, and saved local audio files.
 */
final class WebViewCacheCleaner {
    private static final String TAG = "WebViewCacheCleaner";
    private static final String PREFS_NAME = "soqaro_webview_cache";
    private static final String KEY_INSTALL_STAMP = "install_stamp";
    private static final String[] WEBVIEW_ROOT_DIRS = { "app_webview", "webview" };
    private static final String[] CHROMIUM_CACHE_SUBDIRS = {
        "Cache",
        "Code Cache",
        "GPUCache",
        "DawnGraphiteCache",
        "DawnWebGPUCache",
        "Shared Dictionary",
        "Service Worker/CacheStorage",
        "Service Worker/ScriptCache"
    };

    private WebViewCacheCleaner() {}

    static boolean clearIfInstallChanged(Context context) {
        try {
            String currentStamp = buildInstallStamp(context);
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String previousStamp = prefs.getString(KEY_INSTALL_STAMP, null);
            if (currentStamp.equals(previousStamp)) {
                return false;
            }

            clearCacheDirectories(
                context.getCacheDir(),
                context.getCodeCacheDir(),
                getAppDataDir(context)
            );
            prefs.edit().putString(KEY_INSTALL_STAMP, currentStamp).commit();
            return true;
        } catch (Throwable error) {
            Log.w(TAG, "Failed to clear stale WebView cache on install check", error);
            return false;
        }
    }

    static void clearCacheDirectories(File cacheDir, File codeCacheDir, File dataDir) {
        clearDirectoryContents(cacheDir);
        clearDirectoryContents(codeCacheDir);
        if (dataDir == null || !dataDir.isDirectory()) {
            return;
        }

        for (String rootName : WEBVIEW_ROOT_DIRS) {
            File webViewRoot = new File(dataDir, rootName);
            if (!webViewRoot.isDirectory()) {
                continue;
            }
            for (File profileDir : collectProfileDirs(webViewRoot)) {
                for (String subDir : CHROMIUM_CACHE_SUBDIRS) {
                    deleteRecursively(new File(profileDir, subDir));
                }
            }
        }
    }

    private static List<File> collectProfileDirs(File webViewRoot) {
        List<File> profiles = new ArrayList<>();
        profiles.add(webViewRoot);

        File defaultProfile = new File(webViewRoot, "Default");
        if (defaultProfile.isDirectory()) {
            profiles.add(defaultProfile);
        }

        File[] children = webViewRoot.listFiles();
        if (children != null) {
            for (File child : children) {
                if (child.isDirectory() && child.getName().startsWith("Profile ")) {
                    profiles.add(child);
                }
            }
        }
        return profiles;
    }

    private static String buildInstallStamp(Context context) throws PackageManager.NameNotFoundException {
        PackageManager pm = context.getPackageManager();
        PackageInfo info = getPackageInfoCompat(pm, context.getPackageName());
        long versionCode = PackageInfoCompat.getLongVersionCode(info);
        String versionName = info.versionName != null ? info.versionName : "";

        long apkLength = 0L;
        long apkModified = 0L;
        if (info.applicationInfo != null && info.applicationInfo.sourceDir != null) {
            File apkFile = new File(info.applicationInfo.sourceDir);
            if (apkFile.exists()) {
                apkLength = apkFile.length();
                apkModified = apkFile.lastModified();
            }
        }

        return versionCode
            + ":"
            + versionName
            + ":"
            + info.firstInstallTime
            + ":"
            + info.lastUpdateTime
            + ":"
            + apkLength
            + ":"
            + apkModified;
    }

    @SuppressWarnings("deprecation")
    private static PackageInfo getPackageInfoCompat(PackageManager pm, String packageName)
        throws PackageManager.NameNotFoundException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return pm.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(0));
        }
        return pm.getPackageInfo(packageName, 0);
    }

    private static File getAppDataDir(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            return context.getDataDir();
        }
        File filesDir = context.getFilesDir();
        return filesDir != null ? filesDir.getParentFile() : null;
    }

    private static void clearDirectoryContents(File dir) {
        if (dir == null || !dir.isDirectory()) {
            return;
        }
        File[] children = dir.listFiles();
        if (children == null) {
            return;
        }
        for (File child : children) {
            deleteRecursively(child);
        }
    }

    private static void deleteRecursively(File target) {
        if (target == null || !target.exists()) {
            return;
        }
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        target.delete();
    }
}
