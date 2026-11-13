package com.soqaro.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URL;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Shared artwork/notification bitmap loader enforcing HTTPS, public IP checks,
 * bounded redirect hops, byte-size limits, and downsampled decoding.
 */
final class SafeImageLoader {
    private static final int CONNECT_TIMEOUT_MS = 3000;
    private static final int READ_TIMEOUT_MS = 3000;
    private static final int MAX_REDIRECTS = 3;
    private static final int MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    private static final int MAX_DECODE_DIMENSION = 1024;
    private static final Pattern SAFE_DATA_IMAGE_PATTERN = Pattern.compile(
        "^data:image/(?:png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\\r\\n]+)$",
        Pattern.CASE_INSENSITIVE
    );

    private SafeImageLoader() {}

    static Bitmap loadBitmap(String rawUrl) {
        if (rawUrl == null) return null;
        String trimmed = rawUrl.trim();
        if (trimmed.isEmpty()) return null;

        if (trimmed.regionMatches(true, 0, "data:", 0, 5)) {
            return decodeDataImage(trimmed);
        }
        if (trimmed.regionMatches(true, 0, "blob:", 0, 5)) {
            return null;
        }
        return downloadRemoteBitmap(trimmed);
    }

    private static Bitmap decodeDataImage(String dataUrl) {
        Matcher matcher = SAFE_DATA_IMAGE_PATTERN.matcher(dataUrl);
        if (!matcher.matches()) {
            return null;
        }
        String base64Payload = matcher.group(1);
        if (base64Payload == null || base64Payload.length() > (MAX_IMAGE_BYTES * 4) / 3 + 16) {
            return null;
        }
        try {
            byte[] bytes = Base64.decode(base64Payload, Base64.DEFAULT);
            if (bytes.length > MAX_IMAGE_BYTES) {
                return null;
            }
            return decodeSampledBitmap(bytes);
        } catch (IllegalArgumentException ignored) {
            return null;
        }
    }

    private static Bitmap downloadRemoteBitmap(String initialUrl) {
        try {
            URL current = parseAndValidatePublicHttpsUrl(initialUrl);
            if (current == null) return null;

            for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
                HttpURLConnection connection = (HttpURLConnection) current.openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setRequestMethod("GET");

                try {
                    int code = connection.getResponseCode();
                    if (code >= 300 && code < 400) {
                        if (hop == MAX_REDIRECTS) return null;
                        String location = connection.getHeaderField("Location");
                        if (location == null || location.trim().isEmpty()) return null;
                        URL resolved = new URL(current, location);
                        current = parseAndValidatePublicHttpsUrl(resolved.toString());
                        if (current == null) return null;
                        continue;
                    }

                    if (code < 200 || code >= 300) {
                        return null;
                    }

                    int contentLength = connection.getContentLength();
                    if (contentLength > MAX_IMAGE_BYTES) {
                        return null;
                    }

                    try (InputStream input = connection.getInputStream()) {
                        byte[] bytes = readBoundedBytes(input, MAX_IMAGE_BYTES);
                        if (bytes == null) return null;
                        return decodeSampledBitmap(bytes);
                    }
                } finally {
                    connection.disconnect();
                }
            }
        } catch (Exception ignored) {
            return null;
        }
        return null;
    }

    static URL parseAndValidatePublicHttpsUrl(String raw) {
        try {
            URL parsed = new URL(raw);
            if (!"https".equalsIgnoreCase(parsed.getProtocol())) {
                return null;
            }
            if (parsed.getUserInfo() != null && !parsed.getUserInfo().isEmpty()) {
                return null;
            }
            String host = parsed.getHost();
            if (host == null || host.trim().isEmpty()) {
                return null;
            }
            String lowerHost = host.toLowerCase(Locale.US);
            if (lowerHost.equals("localhost")
                || lowerHost.endsWith(".localhost")
                || lowerHost.endsWith(".local")) {
                return null;
            }

            InetAddress[] resolved = InetAddress.getAllByName(host);
            if (resolved.length == 0) {
                return null;
            }
            for (InetAddress addr : resolved) {
                if (isDisallowedAddress(addr)) {
                    return null;
                }
            }
            return parsed;
        } catch (Exception ignored) {
            return null;
        }
    }

    static boolean isDisallowedAddress(InetAddress addr) {
        if (addr.isAnyLocalAddress()
            || addr.isLoopbackAddress()
            || addr.isLinkLocalAddress()
            || addr.isSiteLocalAddress()
            || addr.isMulticastAddress()) {
            return true;
        }
        if (addr instanceof Inet4Address) {
            byte[] octets = addr.getAddress();
            int b0 = octets[0] & 0xff;
            int b1 = octets[1] & 0xff;
            // 0.0.0.0/8, 100.64.0.0/10 (CGNAT), 198.18.0.0/15 (benchmark)
            if (b0 == 0 || (b0 == 100 && (b1 & 0xc0) == 64) || (b0 == 198 && (b1 == 18 || b1 == 19))) {
                return true;
            }
        } else if (addr instanceof Inet6Address) {
            byte[] bytes = addr.getAddress();
            int first = ((bytes[0] & 0xff) << 8) | (bytes[1] & 0xff);
            // Unique local fc00::/7
            if ((first & 0xfe00) == 0xfc00) {
                return true;
            }
        }
        return false;
    }

    private static byte[] readBoundedBytes(InputStream input, int maxBytes) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > maxBytes) {
                return null;
            }
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }

    private static Bitmap decodeSampledBitmap(byte[] data) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            return null;
        }
        int sampleSize = 1;
        while ((bounds.outWidth / sampleSize) > MAX_DECODE_DIMENSION
            || (bounds.outHeight / sampleSize) > MAX_DECODE_DIMENSION) {
            sampleSize *= 2;
        }
        BitmapFactory.Options decodeOpts = new BitmapFactory.Options();
        decodeOpts.inSampleSize = sampleSize;
        return BitmapFactory.decodeByteArray(data, 0, data.length, decodeOpts);
    }
}
