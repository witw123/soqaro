package com.soqaro.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebSettings;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import java.util.Locale;

public class MainActivity extends BridgeActivity {
    private static final int REQUEST_NOTIFICATION_PERMISSION = 1001;
    private float lastTopDp = 0f;
    private float lastBottomDp = 0f;
    private float lastImeDp = 0f;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DesktopLyricsPlugin.class);
        registerPlugin(SystemNotificationPlugin.class);
        registerPlugin(SystemMediaControlsPlugin.class);
        registerPlugin(LocalStoragePlugin.class);
        registerPlugin(AppUpdaterPlugin.class);
        super.onCreate(savedInstanceState);

        // Edge-to-edge support for modern Android (API 30-35+)
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        // Proactively request notification permission on Android 13+ (API 33+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                    this,
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    REQUEST_NOTIFICATION_PERMISSION
                );
            }
        }

        // Configure WebView for background media, keepalive, and font scaling stability
        if (bridge != null && bridge.getWebView() != null) {
            WebSettings settings = bridge.getWebView().getSettings();
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setTextZoom(100);
        }

        setupWindowInsets();
    }

    private void setupWindowInsets() {
        View decorView = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decorView, (v, windowInsets) -> {
            Insets barInsets = windowInsets.getInsets(
                WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.displayCutout()
            );
            Insets navInsets = windowInsets.getInsets(WindowInsetsCompat.Type.navigationBars());
            Insets imeInsets = windowInsets.getInsets(WindowInsetsCompat.Type.ime());

            float density = getResources().getDisplayMetrics().density;
            if (density > 0) {
                lastTopDp = barInsets.top / density;
                lastBottomDp = navInsets.bottom / density;
                lastImeDp = imeInsets.bottom / density;
                injectNativeInsets(lastTopDp, lastBottomDp, lastImeDp);
            }
            return windowInsets;
        });
    }

    private void injectNativeInsets(float topDp, float bottomDp, float imeDp) {
        if (bridge == null || bridge.getWebView() == null) return;
        String js = String.format(
            Locale.US,
            "document.documentElement.style.setProperty('--native-safe-top', '%.2fpx');" +
            "document.documentElement.style.setProperty('--native-safe-bottom', '%.2fpx');" +
            "document.documentElement.style.setProperty('--native-ime-bottom', '%.2fpx');" +
            "try { window.dispatchEvent(new CustomEvent('nativeinsetschange', { detail: { top: %.2f, bottom: %.2f, ime: %.2f } })); } catch (e) {}",
            topDp, bottomDp, imeDp, topDp, bottomDp, imeDp
        );
        bridge.getWebView().post(() -> {
            if (bridge != null && bridge.getWebView() != null) {
                bridge.getWebView().evaluateJavascript(js, null);
            }
        });
    }

    @Override
    public void onResume() {
        super.onResume();
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().getSettings().setTextZoom(100);
            injectNativeInsets(lastTopDp, lastBottomDp, lastImeDp);
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        // Prevent WebView from freezing JavaScript timers when app is backgrounded
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().resumeTimers();
        }
    }
}
