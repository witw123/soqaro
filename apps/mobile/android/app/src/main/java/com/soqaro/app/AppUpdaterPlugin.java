package com.soqaro.app;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * 应用内更新:从受信任 GitHub Release HTTPS 源下载 APK 到应用私有目录，
 * 校验 APK 签名证书与当前应用一致后拉起系统安装器。
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    private static final String FILE_PROVIDER_AUTHORITY = "com.soqaro.app.fileprovider";
    private static final String UPDATES_SUBDIR = "updates";

    private long downloadId = -1;
    private File pendingApkFile;
    private BroadcastReceiver completionReceiver;

    @PluginMethod
    public void downloadApk(PluginCall call) {
        String url = call.getString("url");
        String versionName = sanitizeVersionName(call.getString("versionName", "update"));
        if (!isTrustedApkDownloadUrl(url)) {
            call.reject("仅允许从受信任的 HTTPS 更新源下载安装包。");
            return;
        }

        Context context = getContext();
        // 幂等:已有进行中的下载直接复用。
        if (downloadId != -1 && isDownloadRunning()) {
            JSObject reuse = new JSObject();
            reuse.put("downloadId", downloadId);
            reuse.put("resumed", true);
            call.resolve(reuse);
            return;
        }

        unregisterCompletionReceiver();

        File updatesDir = getUpdatesDirectory(context);
        if (updatesDir == null) {
            call.reject("更新目录不可用。");
            return;
        }
        cleanupOldApks(updatesDir);

        String fileName = "Soqaro-" + versionName + ".apk";
        pendingApkFile = new File(updatesDir, fileName);

        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url.trim()));
        request.setTitle("Soqaro " + versionName);
        request.setDescription("正在下载更新包…");
        request.setMimeType("application/vnd.android.package-archive");
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.setDestinationInExternalFilesDir(context, null, UPDATES_SUBDIR + "/" + fileName);
        request.setAllowedOverMetered(true);
        request.setAllowedOverRoaming(false);

        DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            call.reject("下载服务不可用。");
            return;
        }
        downloadId = manager.enqueue(request);

        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(completionReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context receiverContext, Intent intent) {
                    long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                    if (id == downloadId) notifyComplete(id);
                }
            }, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            context.registerReceiver(completionReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context receiverContext, Intent intent) {
                    long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                    if (id == downloadId) notifyComplete(id);
                }
            }, filter);
        }

        JSObject result = new JSObject();
        result.put("downloadId", downloadId);
        result.put("resumed", false);
        call.resolve(result);
    }

    @PluginMethod
    public void getDownloadStatus(PluginCall call) {
        Double idDouble = call.getDouble("downloadId");
        if (idDouble == null) {
            call.reject("缺少 downloadId。");
            return;
        }
        long id = idDouble.longValue();
        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            call.reject("下载服务不可用。");
            return;
        }

        DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
        Cursor cursor = manager.query(query);
        JSObject result = new JSObject();
        if (cursor == null || !cursor.moveToFirst()) {
            result.put("status", "failed");
            result.put("progress", 0);
            result.put("reason", "下载任务不存在(可能已被系统清理),请重新开始下载。");
            if (cursor != null) cursor.close();
            call.resolve(result);
            return;
        }

        int statusIndex = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS);
        int reasonIndex = cursor.getColumnIndex(DownloadManager.COLUMN_REASON);
        int downloadedIndex = cursor.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
        int totalIndex = cursor.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
        int status = cursor.getInt(statusIndex);
        int reason = cursor.getInt(reasonIndex);
        long downloaded = cursor.getLong(downloadedIndex);
        long total = cursor.getLong(totalIndex);
        int progress = total > 0 ? (int) Math.min(100, Math.round(downloaded * 100.0 / total)) : 0;
        cursor.close();

        String state;
        switch (status) {
            case DownloadManager.STATUS_SUCCESSFUL:
                state = "successful";
                break;
            case DownloadManager.STATUS_FAILED:
                state = "failed";
                break;
            case DownloadManager.STATUS_PAUSED:
                state = "paused";
                break;
            default:
                state = "running";
        }
        result.put("status", state);
        result.put("progress", progress);
        if (status == DownloadManager.STATUS_FAILED) {
            result.put("reason", "下载失败(原因代码 " + reason + ")。");
        }
        call.resolve(result);
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        Context context = getContext();
        DownloadManager manager = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            call.reject("下载服务不可用。");
            return;
        }

        // Android 8.0+ 需要用户授予“安装未知应用”权限,引导去设置页。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !context.getPackageManager().canRequestPackageInstalls()) {
            Intent settingsIntent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + context.getPackageName())
            );
            settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(settingsIntent);
            call.reject("需要授予“安装未知应用”权限后重试。");
            return;
        }

        File apkFile = resolveCompletedApkFile(context, manager);
        if (apkFile == null || !apkFile.isFile()) {
            call.reject("未找到已下载的安装包,请重新下载。");
            return;
        }

        if (!verifyApkMatchesInstalledSigner(context, apkFile)) {
            apkFile.delete();
            call.reject("安装包签名校验失败,已取消安装。");
            return;
        }

        Uri downloadUri = FileProvider.getUriForFile(context, FILE_PROVIDER_AUTHORITY, apkFile);
        Intent installIntent = new Intent(Intent.ACTION_INSTALL_PACKAGE, downloadUri);
        installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(installIntent);
            call.resolve();
        } catch (Exception error) {
            call.reject("无法启动安装器: " + error.getMessage());
        }
    }

    static boolean isTrustedApkDownloadUrl(String rawUrl) {
        if (rawUrl == null) return false;
        String trimmed = rawUrl.trim();
        if (trimmed.isEmpty()) return false;
        Uri uri = Uri.parse(trimmed);
        if (!"https".equalsIgnoreCase(uri.getScheme())) {
            return false;
        }
        if (uri.getUserInfo() != null && !uri.getUserInfo().isEmpty()) {
            return false;
        }
        String host = uri.getHost();
        if (host == null) return false;
        String lower = host.toLowerCase(Locale.US);
        if (lower.equals("github.com")) {
            String path = uri.getPath();
            return path != null && path.startsWith("/witw123/soqaro/");
        }
        return lower.equals("objects.githubusercontent.com")
            || lower.equals("release-assets.githubusercontent.com")
            || lower.endsWith(".githubusercontent.com");
    }

    private static String sanitizeVersionName(String raw) {
        if (raw == null || raw.trim().isEmpty()) {
            return "update";
        }
        String sanitized = raw.trim().replaceAll("[^A-Za-z0-9._-]", "_");
        return sanitized.isEmpty() ? "update" : sanitized;
    }

    private static File getUpdatesDirectory(Context context) {
        File base = context.getExternalFilesDir(null);
        if (base == null) return null;
        File dir = new File(base, UPDATES_SUBDIR);
        if (!dir.exists() && !dir.mkdirs()) {
            return null;
        }
        return dir;
    }

    private static void cleanupOldApks(File updatesDir) {
        File[] files = updatesDir.listFiles();
        if (files == null) return;
        for (File file : files) {
            if (file.isFile() && file.getName().endsWith(".apk")) {
                file.delete();
            }
        }
    }

    private File resolveCompletedApkFile(Context context, DownloadManager manager) {
        if (downloadId == -1) return null;
        File updatesDir = getUpdatesDirectory(context);
        if (updatesDir == null) return null;

        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(downloadId))) {
            if (cursor == null || !cursor.moveToFirst()) {
                return null;
            }
            int statusIdx = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS);
            if (statusIdx < 0 || cursor.getInt(statusIdx) != DownloadManager.STATUS_SUCCESSFUL) {
                return null;
            }
            int localUriIdx = cursor.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI);
            String localUri = localUriIdx >= 0 ? cursor.getString(localUriIdx) : null;
            File candidate = pendingApkFile;
            if (localUri != null && !localUri.isEmpty()) {
                Uri parsed = Uri.parse(localUri);
                if ("file".equalsIgnoreCase(parsed.getScheme()) && parsed.getPath() != null) {
                    candidate = new File(parsed.getPath());
                }
            }
            if (candidate == null) return null;
            String rootCanonical = updatesDir.getCanonicalPath() + File.separator;
            String fileCanonical = candidate.getCanonicalPath();
            if (!fileCanonical.startsWith(rootCanonical)) {
                return null;
            }
            return candidate;
        } catch (IOException ignored) {
            return null;
        }
    }

    private static boolean verifyApkMatchesInstalledSigner(Context context, File apkFile) {
        try {
            PackageManager pm = context.getPackageManager();
            int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : getLegacySignatureFlag();

            PackageInfo installedInfo = pm.getPackageInfo(context.getPackageName(), flags);
            PackageInfo archiveInfo = pm.getPackageArchiveInfo(apkFile.getAbsolutePath(), flags);
            if (installedInfo == null || archiveInfo == null) {
                return false;
            }
            if (!context.getPackageName().equals(archiveInfo.packageName)) {
                return false;
            }

            Set<String> installedDigests = extractCertDigests(installedInfo);
            Set<String> archiveDigests = extractCertDigests(archiveInfo);
            if (installedDigests.isEmpty() || archiveDigests.isEmpty()) {
                return false;
            }
            return installedDigests.equals(archiveDigests);
        } catch (Exception ignored) {
            return false;
        }
    }

    @SuppressWarnings("deprecation")
    private static int getLegacySignatureFlag() {
        return PackageManager.GET_SIGNATURES;
    }

    private static Set<String> extractCertDigests(PackageInfo info) throws Exception {
        Set<String> digests = new HashSet<>();
        Signature[] signatures = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
            SigningInfo signingInfo = info.signingInfo;
            signatures = signingInfo.hasMultipleSigners()
                ? signingInfo.getApkContentsSigners()
                : signingInfo.getSigningCertificateHistory();
        } else {
            signatures = getLegacySignatures(info);
        }
        if (signatures == null) return digests;

        MessageDigest sha256 = MessageDigest.getInstance("SHA-256");
        for (Signature sig : signatures) {
            byte[] hash = sha256.digest(sig.toByteArray());
            StringBuilder hex = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                hex.append(String.format(Locale.US, "%02x", b));
            }
            digests.add(hex.toString());
        }
        return digests;
    }

    @SuppressWarnings("deprecation")
    private static Signature[] getLegacySignatures(PackageInfo info) {
        return info.signatures;
    }

    private boolean isDownloadRunning() {
        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null || downloadId == -1) return false;
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(downloadId))) {
            if (cursor == null || !cursor.moveToFirst()) return false;
            int status = cursor.getInt(cursor.getColumnIndex(DownloadManager.COLUMN_STATUS));
            return status == DownloadManager.STATUS_RUNNING || status == DownloadManager.STATUS_PAUSED
                || status == DownloadManager.STATUS_PENDING;
        }
    }

    private void notifyComplete(long id) {
        JSObject payload = new JSObject();
        payload.put("downloadId", id);
        notifyListeners("apkDownloadComplete", payload);
    }

    private void unregisterCompletionReceiver() {
        if (completionReceiver != null) {
            try {
                getContext().unregisterReceiver(completionReceiver);
            } catch (IllegalArgumentException ignored) {
                // receiver 可能尚未注册
            }
            completionReceiver = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        unregisterCompletionReceiver();
        super.handleOnDestroy();
    }
}
