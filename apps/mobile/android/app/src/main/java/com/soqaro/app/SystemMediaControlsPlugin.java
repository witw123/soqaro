package com.soqaro.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor bridge for the Android system media session (notification drawer,
 * lock screen controls, Bluetooth/wired headset transport). The webview pushes
 * playback state through updateMetadata / updatePlaybackState / hide;
 * SystemMediaService owns the actual MediaSessionCompat and the MediaStyle
 * foreground notification, and routes transport commands back here.
 *
 * Implemented in Java (not Kotlin) for the same reason as DesktopLyricsPlugin:
 * the app Gradle module has no Kotlin plugin applied, so .kt sources would
 * silently not compile in CI.
 */
@CapacitorPlugin(name = "SystemMediaControls")
public class SystemMediaControlsPlugin extends Plugin {
    /** Live instance so the service can emit commands without a binder handshake. */
    static volatile SystemMediaControlsPlugin activeInstance;

    private volatile boolean isKeepAliveActive = false;
    private volatile String keepAliveRoomName = "";

    @Override
    public void load() {
        super.load();
        activeInstance = this;
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (!isKeepAliveActive) {
            return;
        }
        Intent intent = serviceIntent();
        if (intent != null) {
            intent.putExtra("restoreAudioFocus", true);
            intent.putExtra("keepAlive", true);
            intent.putExtra("roomName", keepAliveRoomName);
            startService(intent);
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (activeInstance == this) {
            activeInstance = null;
        }
        super.handleOnDestroy();
    }

    /** Forwards a transport command from the MediaSession to the webview listener. */
    static void emitCommand(String action, Long positionMs, Long deltaMs) {
        SystemMediaControlsPlugin plugin = activeInstance;
        if (plugin == null) {
            return;
        }
        JSObject payload = new JSObject();
        payload.put("action", action);
        if (positionMs != null) {
            payload.put("positionMs", positionMs.doubleValue());
        }
        if (deltaMs != null) {
            payload.put("deltaMs", deltaMs.doubleValue());
        }
        plugin.notifyListeners("systemMediaCommand", payload);
    }

    @PluginMethod
    public void enableKeepAlive(PluginCall call) {
        isKeepAliveActive = true;
        keepAliveRoomName = call.getString("roomName", "");
        Intent intent = serviceIntent();
        if (intent != null) {
            intent.putExtra("keepAlive", true);
            intent.putExtra("roomName", keepAliveRoomName);
            startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void disableKeepAlive(PluginCall call) {
        isKeepAliveActive = false;
        keepAliveRoomName = "";
        Context context = bridge != null ? bridge.getContext() : null;
        if (context != null) {
            context.stopService(new Intent(context, SystemMediaService.class));
        }
        call.resolve();
    }

    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        JSObject ret = new JSObject();
        boolean isIgnoring = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Context context = bridge != null ? bridge.getContext() : null;
            if (context != null) {
                PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    isIgnoring = pm.isIgnoringBatteryOptimizations(context.getPackageName());
                }
            }
        }
        ret.put("isIgnoring", isIgnoring);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Context context = bridge != null ? bridge.getContext() : null;
            if (context != null) {
                PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                if (pm != null && !pm.isIgnoringBatteryOptimizations(context.getPackageName())) {
                    try {
                        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                        intent.setData(Uri.parse("package:" + context.getPackageName()));
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        context.startActivity(intent);
                    } catch (Exception error) {
                        try {
                            Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            context.startActivity(fallback);
                        } catch (Exception ignored) {
                        }
                    }
                }
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void updateMetadata(PluginCall call) {
        Intent intent = serviceIntent();
        if (intent == null) {
            call.resolve();
            return;
        }
        intent.putExtra("title", call.getString("title", ""));
        intent.putExtra("artist", call.getString("artist", ""));
        intent.putExtra("album", call.getString("album", ""));
        intent.putExtra("artworkUrl", call.getString("artworkUrl", ""));
        double durationMs = call.getDouble("durationMs", 0.0);
        intent.putExtra("durationMs", (long) durationMs);
        if (isKeepAliveActive) {
            intent.putExtra("keepAlive", true);
            intent.putExtra("roomName", keepAliveRoomName);
        }
        startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void updatePlaybackState(PluginCall call) {
        Intent intent = serviceIntent();
        if (intent == null) {
            call.resolve();
            return;
        }
        intent.putExtra("isPlaying", call.getBoolean("isPlaying", false));
        double positionMs = call.getDouble("positionMs", 0.0);
        intent.putExtra("positionMs", (long) positionMs);
        if (isKeepAliveActive) {
            intent.putExtra("keepAlive", true);
            intent.putExtra("roomName", keepAliveRoomName);
        }
        startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void hide(PluginCall call) {
        boolean force = call.getBoolean("force", false);
        if (isKeepAliveActive && !force) {
            Intent intent = serviceIntent();
            if (intent != null) {
                intent.putExtra("clearTrack", true);
                intent.putExtra("keepAlive", true);
                intent.putExtra("roomName", keepAliveRoomName);
                startService(intent);
            }
            call.resolve();
            return;
        }
        Context context = bridge != null ? bridge.getContext() : null;
        if (context != null) {
            context.stopService(new Intent(context, SystemMediaService.class));
        }
        call.resolve();
    }

    private Intent serviceIntent() {
        if (bridge == null || bridge.getContext() == null) {
            return null;
        }
        return new Intent(bridge.getContext(), SystemMediaService.class);
    }

    private void startService(Intent intent) {
        try {
            Context context = bridge != null ? bridge.getContext() : null;
            if (context == null) return;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(context, intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception error) {
            // Guard against ForegroundServiceStartNotAllowedException on Android 12+ / 14+
        }
    }
}
