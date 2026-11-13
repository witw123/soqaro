package com.soqaro.app;

import android.content.pm.ApplicationInfo;
import android.util.Base64;
import android.net.Uri;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "LocalStorage")
public class LocalStoragePlugin extends Plugin {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private File resolve(String relative) throws IOException {
        if (relative == null || relative.contains("\\") || relative.contains(":") || relative.indexOf('\0') >= 0) {
            throw new IOException("Invalid repository path");
        }
        String[] parts = relative.split("/", -1);
        if (!parts[0].equals(".soqaro")) throw new IOException("Path must stay inside .soqaro");
        File path = getContext().getFilesDir().getCanonicalFile();
        for (String part : parts) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) throw new IOException("Invalid path segment");
            path = new File(path, part);
            if (!path.getAbsolutePath().equals(path.getCanonicalPath())) throw new IOException("Linked paths are not supported");
        }
        return path;
    }

    private JSObject entry(File file) {
        JSObject result = new JSObject();
        result.put("name", file.getName());
        result.put("kind", file.isDirectory() ? "directory" : "file");
        result.put("size", file.length());
        result.put("modified", file.lastModified());
        return result;
    }

    private void remove(File file, boolean recursive) throws IOException {
        if (!file.exists()) return;
        if (file.isDirectory() && recursive) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("Cannot list directory");
            for (File child : children) {
                if (!child.getCanonicalPath().equals(child.getAbsolutePath())) throw new IOException("Linked path");
                remove(child, true);
            }
        }
        if (!file.delete()) throw new IOException("Cannot remove " + file.getName());
    }

    @PluginMethod
    public void execute(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            String rawUrl = getBridge().getWebView().getUrl();
            Uri uri = rawUrl != null ? Uri.parse(rawUrl) : null;
            String scheme = uri != null ? uri.getScheme() : null;
            String host = uri != null ? uri.getHost() : null;
            boolean isDebuggable = (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            boolean isTrustedProd = "https".equalsIgnoreCase(scheme) && "soqaro.witw.top".equalsIgnoreCase(host);
            boolean isTrustedDebug = isDebuggable
                && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                && host != null
                && (host.equalsIgnoreCase("localhost") || host.equals("127.0.0.1") || host.equals("10.0.2.2"));
            if (!isTrustedProd && !isTrustedDebug) {
                call.reject("Storage is only available to Soqaro");
                return;
            }
            runOperation(call);
        });
    }

    private void runOperation(PluginCall call) {
        executor.execute(() -> {
            try {
                String op = call.getString("op", "");
                JSObject result = new JSObject();
                if (op.equals("root")) {
                    result.put("path", getContext().getFilesDir().getCanonicalPath());
                    call.resolve(result);
                    return;
                }
                String relative = call.getString("path", "");
                File file = resolve(relative);
                switch (op) {
                    case "directory":
                        if (Boolean.TRUE.equals(call.getBoolean("create", false)) && !file.isDirectory() && !file.mkdirs()) {
                            throw new IOException("Cannot create storage directory");
                        }
                        if (!file.isDirectory()) throw new IOException("Directory not found");
                        break;
                    case "file":
                        if (Boolean.TRUE.equals(call.getBoolean("create", false)) && !file.exists()) file.createNewFile();
                        if (!file.isFile()) throw new IOException("File not found");
                        break;
                    case "stat":
                        if (!file.exists()) throw new IOException("File not found");
                        result.put("entry", entry(file));
                        break;
                    case "list":
                        File[] children = file.listFiles();
                        if (children == null) throw new IOException("Cannot list directory");
                        JSArray entries = new JSArray();
                        for (File child : children) {
                            if (child.getCanonicalPath().equals(child.getAbsolutePath())) entries.put(entry(child));
                        }
                        result.put("entries", entries);
                        break;
                    case "read":
                        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
                            input.seek(call.getLong("offset", 0L));
                            byte[] bytes = new byte[Math.max(0, Math.min(call.getInt("length", 262144), 262144))];
                            int count = input.read(bytes);
                            result.put("data", Base64.encodeToString(Arrays.copyOf(bytes, Math.max(count, 0)), Base64.NO_WRAP));
                        }
                        break;
                    case "write":
                        if (!relative.contains(".writing-")) throw new IOException("Write requires a staged file");
                        byte[] data = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
                        if (data.length > 262144) throw new IOException("Write chunk too large");
                        try (RandomAccessFile output = new RandomAccessFile(file, "rw")) {
                            output.seek(call.getLong("offset", 0L));
                            output.write(data);
                        }
                        break;
                    case "commit":
                        String target = call.getString("target", "");
                        if (!relative.startsWith(target + ".writing-")) throw new IOException("Invalid staged file");
                        if (!file.renameTo(resolve(target))) throw new IOException("Cannot commit file");
                        break;
                    case "remove":
                        if (relative.equals(".soqaro")) throw new IOException("Cannot remove repository root");
                        remove(file, Boolean.TRUE.equals(call.getBoolean("recursive", false)));
                        break;
                    default:
                        throw new IOException("Unknown storage operation");
                }
                call.resolve(result);
            } catch (Exception error) {
                call.reject(error.getMessage(), error);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdown();
        super.handleOnDestroy();
    }
}
