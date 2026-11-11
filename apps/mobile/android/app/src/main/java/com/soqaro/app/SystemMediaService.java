package com.soqaro.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Foreground service (mediaPlayback type) owning the MediaSessionCompat and
 * the MediaStyle notification behind Android's system media surfaces: the
 * notification drawer, lock screen controls, and Bluetooth/wired headset
 * transport. The webview pushes state through SystemMediaControlsPlugin;
 * transport commands flow back via SystemMediaControlsPlugin.emitCommand.
 *
 * Holds PARTIAL_WAKE_LOCK and WifiLock to prevent CPU suspend and WiFi sleep
 * while active in a room or playing media, avoiding WebSocket/WebRTC disconnections.
 */
public class SystemMediaService extends Service {
    private static final String CHANNEL_ID = "soqaro_media";
    private static final int NOTIFICATION_ID = 42;
    private static final String ACTION_MEDIA_COMMAND = "com.soqaro.app.SYSTEM_MEDIA_COMMAND";

    private MediaSessionCompat session;
    private final ExecutorService imageExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private boolean isKeepAlive;
    private String roomName = "";

    private String currentTitle = "";
    private String currentArtist = "";
    private String currentAlbum = "";
    private String currentArtworkUrl = "";
    private String loadedArtworkUrl;
    private Bitmap artwork;
    private long durationMs;
    private boolean isPlaying;
    private long positionMs;
    private BroadcastReceiver commandReceiver;

    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private boolean hasAudioFocus;
    private final AudioManager.OnAudioFocusChangeListener audioFocusChangeListener = focusChange -> {
        switch (focusChange) {
            case AudioManager.AUDIOFOCUS_LOSS:
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                abandonAudioFocus();
                emit("pause", null, null);
                break;
            default:
                break;
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        acquireLocks();
        session = new MediaSessionCompat(this, "SoqaroMediaSession");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                emit("play", null, null);
            }

            @Override
            public void onPause() {
                emit("pause", null, null);
            }

            @Override
            public void onSkipToNext() {
                emit("next", null, null);
            }

            @Override
            public void onSkipToPrevious() {
                emit("prev", null, null);
            }

            @Override
            public void onStop() {
                emit("pause", null, null);
            }

            @Override
            public void onFastForward() {
                emit("seekBy", null, 10_000L);
            }

            @Override
            public void onRewind() {
                emit("seekBy", null, -10_000L);
            }

            @Override
            public void onSeekTo(long pos) {
                emit("seekTo", pos, null);
            }
        });
        session.setActive(true);
        registerCommandReceiver();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        acquireLocks();
        if (intent != null) {
            if (intent.hasExtra("keepAlive")) {
                isKeepAlive = intent.getBooleanExtra("keepAlive", false);
            }
            if (intent.hasExtra("roomName")) {
                roomName = intent.getStringExtra("roomName");
                if (roomName == null) roomName = "";
            }
            if (intent.getBooleanExtra("clearTrack", false)) {
                currentTitle = "";
                currentArtist = "";
                currentAlbum = "";
                currentArtworkUrl = "";
                loadedArtworkUrl = null;
                artwork = null;
                durationMs = 0L;
                isPlaying = false;
                positionMs = 0L;
            }
            if (intent.hasExtra("title")) {
                currentTitle = intent.getStringExtra("title");
                if (currentTitle == null) currentTitle = "";
                currentArtist = intent.getStringExtra("artist");
                if (currentArtist == null) currentArtist = "";
                currentAlbum = intent.getStringExtra("album");
                if (currentAlbum == null) currentAlbum = "";
                currentArtworkUrl = intent.getStringExtra("artworkUrl");
                if (currentArtworkUrl == null) currentArtworkUrl = "";
                durationMs = intent.getLongExtra("durationMs", 0L);
                loadArtwork();
            }
            if (intent.hasExtra("isPlaying")) {
                isPlaying = intent.getBooleanExtra("isPlaying", false);
                positionMs = intent.getLongExtra("positionMs", 0L);
            }
        }
        if (isPlaying) {
            requestAudioFocus();
        } else {
            abandonAudioFocus();
        }
        try {
            Notification notification = buildNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception error) {
            // Guard against MissingForegroundServiceTypeException / BadNotificationException on Android 14+
        }
        publishSessionState();
        NotificationManagerCompatHolder.notify(this, NOTIFICATION_ID, buildNotification());
        return START_STICKY;
    }

    private void acquireLocks() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Soqaro:MediaPlaybackWakeLock");
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire();
            }
        } catch (Exception ignored) {
        }

        try {
            if (wifiLock == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Soqaro:MediaPlaybackWifiLock");
                    wifiLock.setReferenceCounted(false);
                }
            }
            if (wifiLock != null && !wifiLock.isHeld()) {
                wifiLock.acquire();
            }
        } catch (Exception ignored) {
        }
    }

    private void releaseLocks() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {
        }
        wakeLock = null;

        try {
            if (wifiLock != null && wifiLock.isHeld()) {
                wifiLock.release();
            }
        } catch (Exception ignored) {
        }
        wifiLock = null;
    }

    private void requestAudioFocus() {
        if (hasAudioFocus) return;
        try {
            if (audioManager == null) {
                audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            }
            if (audioManager == null) return;
            int result;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (audioFocusRequest == null) {
                    AudioAttributes attributes = new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                            .build();
                    audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                            .setAudioAttributes(attributes)
                            .setAcceptsDelayedFocusGain(true)
                            .setOnAudioFocusChangeListener(audioFocusChangeListener, mainHandler)
                            .build();
                }
                result = audioManager.requestAudioFocus(audioFocusRequest);
            } else {
                result = audioManager.requestAudioFocus(
                        audioFocusChangeListener,
                        AudioManager.STREAM_MUSIC,
                        AudioManager.AUDIOFOCUS_GAIN
                );
            }
            hasAudioFocus = (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
        } catch (Exception ignored) {
        }
    }

    private void abandonAudioFocus() {
        if (!hasAudioFocus) return;
        try {
            if (audioManager != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
                    audioManager.abandonAudioFocusRequest(audioFocusRequest);
                } else {
                    audioManager.abandonAudioFocus(audioFocusChangeListener);
                }
            }
        } catch (Exception ignored) {
        }
        hasAudioFocus = false;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The webview (and its audio) dies with the task, so a lingering
        // "playing" notification would be a lie; tear everything down.
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        abandonAudioFocus();
        releaseLocks();
        if (commandReceiver != null) {
            unregisterReceiver(commandReceiver);
            commandReceiver = null;
        }
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        NotificationManagerCompatHolder.cancel(this, NOTIFICATION_ID);
        imageExecutor.shutdownNow();
        super.onDestroy();
    }

    private void publishSessionState() {
        if (session == null) return;
        MediaMetadataCompat.Builder metadata = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentArtist)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, currentAlbum)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, Math.max(0L, durationMs));
        if (artwork != null) {
            metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork);
        }
        session.setMetadata(metadata.build());

        // The system advances the timeline from the playback speed itself, so
        // the 1 Hz position pushes only serve to correct drift after seeks.
        PlaybackStateCompat state = new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY
                        | PlaybackStateCompat.ACTION_PAUSE
                        | PlaybackStateCompat.ACTION_PLAY_PAUSE
                        | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                        | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                        | PlaybackStateCompat.ACTION_SEEK_TO
                        | PlaybackStateCompat.ACTION_FAST_FORWARD
                        | PlaybackStateCompat.ACTION_REWIND)
                .setState(isPlaying
                                ? PlaybackStateCompat.STATE_PLAYING
                                : PlaybackStateCompat.STATE_PAUSED,
                        Math.max(0L, positionMs),
                        isPlaying ? 1f : 0f)
                .build();
        session.setPlaybackState(state);
    }

    /** Re-downloads artwork only when the track's cover actually changed. */
    private void loadArtwork() {
        final String url = currentArtworkUrl;
        if (url == null || url.isEmpty() || url.equals(loadedArtworkUrl)) {
            return;
        }
        imageExecutor.execute(() -> {
            Bitmap bitmap = decodeArtwork(url);
            mainHandler.post(() -> {
                // Accept the result either way; a failed cover must not loop.
                loadedArtworkUrl = url;
                artwork = bitmap;
                publishSessionState();
                if (session != null) {
                    NotificationManagerCompatHolder.notify(
                            this, NOTIFICATION_ID, buildNotification());
                }
            });
        });
    }

    private Bitmap decodeArtwork(String url) {
        try {
            if (url.startsWith("data:")) {
                int comma = url.indexOf(',');
                if (comma < 0) return null;
                byte[] bytes = android.util.Base64.decode(
                        url.substring(comma + 1), android.util.Base64.DEFAULT);
                return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            }
            if (url.startsWith("blob:")) {
                // Blob URLs live inside the webview and are unreachable natively.
                return null;
            }
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(3000);
            InputStream input = connection.getInputStream();
            try {
                return BitmapFactory.decodeStream(input);
            } finally {
                input.close();
            }
        } catch (Exception error) {
            return null;
        }
    }

    private Notification buildNotification() {
        boolean hasTrack = !currentTitle.isEmpty();
        String title = hasTrack ? currentTitle : (roomName.isEmpty() ? getString(R.string.app_name) : roomName);
        String text = hasTrack ? subtitle() : "正在后台保持房间连接 点击返回";

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title)
                .setContentText(text)
                .setLargeIcon(hasTrack ? artwork : null)
                .setContentIntent(launchIntent())
                .setShowWhen(false)
                .setOnlyAlertOnce(true)
                .setOngoing(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);

        androidx.media.app.NotificationCompat.MediaStyle mediaStyle =
                new androidx.media.app.NotificationCompat.MediaStyle()
                        .setMediaSession(session != null ? session.getSessionToken() : null);

        if (hasTrack) {
            mediaStyle.setShowActionsInCompactView(0, 1, 2);
            builder.setStyle(mediaStyle);
            builder.addAction(new NotificationCompat.Action(
                    android.R.drawable.ic_media_previous, "Previous", commandPendingIntent("prev")));
            builder.addAction(new NotificationCompat.Action(
                    isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                    "PlayPause",
                    commandPendingIntent("toggle")));
            builder.addAction(new NotificationCompat.Action(
                    android.R.drawable.ic_media_next, "Next", commandPendingIntent("next")));
        } else {
            builder.setStyle(mediaStyle);
        }

        return builder.build();
    }

    private String subtitle() {
        if (!currentArtist.isEmpty() && !currentAlbum.isEmpty()) {
            return currentArtist + " - " + currentAlbum;
        }
        if (!currentArtist.isEmpty()) return currentArtist;
        if (!currentAlbum.isEmpty()) return currentAlbum;
        return "";
    }

    private PendingIntent launchIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) return null;
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(this, 0, launch, flags);
    }

    private PendingIntent commandPendingIntent(String action) {
        Intent intent = new Intent(ACTION_MEDIA_COMMAND).setPackage(getPackageName());
        intent.putExtra("action", action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(this, action.hashCode(), intent, flags);
    }

    private void registerCommandReceiver() {
        commandReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getStringExtra("action");
                if (action == null) return;
                switch (action) {
                    case "prev":
                        emit("prev", null, null);
                        break;
                    case "next":
                        emit("next", null, null);
                        break;
                    case "toggle":
                        emit("toggle", null, null);
                        break;
                    default:
                        break;
                }
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_MEDIA_COMMAND);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(commandReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(commandReceiver, filter);
        }
    }

    private static void emit(String action, Long positionMs, Long deltaMs) {
        SystemMediaControlsPlugin.emitCommand(action, positionMs, deltaMs);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Soqaro 播放控制",
                    NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("系统媒体播放控制通知");
            channel.setShowBadge(false);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    /** Indirection so the notification calls stay terse without importing the whole compat class. */
    private static final class NotificationManagerCompatHolder {
        static void notify(Context context, int id, Notification notification) {
            // Without POST_NOTIFICATIONS (Android 13+) drawer updates throw;
            // the foreground notification itself still exists, so ignore.
            try {
                androidx.core.app.NotificationManagerCompat.from(context).notify(id, notification);
            } catch (SecurityException error) {
                // Ignored on purpose.
            }
        }

        static void cancel(Context context, int id) {
            androidx.core.app.NotificationManagerCompat.from(context).cancel(id);
        }
    }
}
