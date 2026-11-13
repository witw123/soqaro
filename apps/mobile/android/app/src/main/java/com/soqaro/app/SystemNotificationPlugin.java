package com.soqaro.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "SystemNotification",
    permissions = {
        @Permission(
            strings = { Manifest.permission.POST_NOTIFICATIONS },
            alias = "notifications"
        )
    }
)
public class SystemNotificationPlugin extends Plugin {
    private static final String CHANNEL_ID = "soqaro_notifications";
    private static final String CHANNEL_NAME = "Soqaro 房间通知";
    private static final String CHANNEL_DESC = "用于接收切歌、点歌、曲库变动和聊天消息通知";
    private final ExecutorService imageExecutor = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        super.load();
        createNotificationChannel();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription(CHANNEL_DESC);
            channel.enableVibration(true);
            channel.setShowBadge(true);
            NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        boolean enabled = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            int status = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS);
            if (status != PackageManager.PERMISSION_GRANTED) {
                enabled = false;
            }
        }
        JSObject ret = new JSObject();
        ret.put("granted", enabled);
        ret.put("permission", enabled ? "granted" : "denied");
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (getPermissionState("notifications") != PermissionState.GRANTED) {
                requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
                return;
            }
        }
        boolean enabled = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        JSObject ret = new JSObject();
        ret.put("granted", enabled);
        ret.put("permission", enabled ? "granted" : "denied");
        call.resolve(ret);
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        boolean enabled = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            int status = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS);
            if (status != PackageManager.PERMISSION_GRANTED) {
                enabled = false;
            }
        }
        JSObject ret = new JSObject();
        ret.put("granted", enabled);
        ret.put("permission", enabled ? "granted" : "denied");
        call.resolve(ret);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Context context = getContext();
            Intent intent = new Intent();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent.setAction(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
            } else {
                intent.setAction(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.parse("package:" + context.getPackageName()));
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            call.resolve(new JSObject().put("success", true));
        } catch (Exception e) {
            call.reject("Failed to open notification settings", e);
        }
    }

    @PluginMethod
    public void show(PluginCall call) {
        String title = call.getString("title", "Soqaro");
        String body = call.getString("body", "");
        String artworkUrl = call.getString("artworkUrl");
        int notificationId = call.getInt("id", (int) (System.currentTimeMillis() % 100000));

        Context context = getContext();
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            call.reject("Notifications disabled");
            return;
        }

        Intent launchIntent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent pendingIntent = null;
        if (launchIntent != null) {
            launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            pendingIntent = PendingIntent.getActivity(context, 0, launchIntent, flags);
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setDefaults(NotificationCompat.DEFAULT_ALL);

        if (pendingIntent != null) {
            builder.setContentIntent(pendingIntent);
        }

        if (artworkUrl != null && !artworkUrl.isEmpty()) {
            imageExecutor.execute(() -> {
                Bitmap bitmap = downloadBitmap(artworkUrl);
                if (bitmap != null) {
                    builder.setLargeIcon(bitmap);
                }
                try {
                    NotificationManagerCompat.from(context).notify(notificationId, builder.build());
                    call.resolve(new JSObject().put("success", true).put("id", notificationId));
                } catch (SecurityException se) {
                    call.reject("Security exception posting notification", se);
                }
            });
        } else {
            try {
                NotificationManagerCompat.from(context).notify(notificationId, builder.build());
                call.resolve(new JSObject().put("success", true).put("id", notificationId));
            } catch (SecurityException se) {
                call.reject("Security exception posting notification", se);
            }
        }
    }

    private Bitmap downloadBitmap(String src) {
        return SafeImageLoader.loadBitmap(src);
    }
}
