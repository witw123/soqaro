package com.soqaro.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class WebViewCacheCleanerTest {
    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    @Test
    public void clearsHttpAndCodeCachesWhilePreservingUserData() throws IOException {
        File cacheDir = tempFolder.newFolder("cache");
        File codeCacheDir = tempFolder.newFolder("code_cache");
        File dataDir = tempFolder.newFolder("data");

        assertTrue(new File(cacheDir, "http-entry").createNewFile());
        assertTrue(new File(codeCacheDir, "v8-bytecode").createNewFile());

        File profileDir = new File(dataDir, "app_webview/Default");
        File httpCache = new File(profileDir, "Cache");
        File jsCache = new File(profileDir, "Code Cache");
        File gpuCache = new File(profileDir, "GPUCache");
        File swCache = new File(profileDir, "Service Worker/CacheStorage");
        File cookies = new File(profileDir, "Cookies");
        File localStorage = new File(profileDir, "Local Storage");
        File indexedDb = new File(profileDir, "IndexedDB");
        File savedSongs = new File(dataDir, "files/.soqaro");

        for (File dir : new File[] { httpCache, jsCache, gpuCache, swCache, localStorage, indexedDb, savedSongs }) {
            assertTrue(dir.mkdirs());
            assertTrue(new File(dir, "sample").createNewFile());
        }
        assertTrue(cookies.createNewFile());

        WebViewCacheCleaner.clearCacheDirectories(cacheDir, codeCacheDir, dataDir);

        assertTrue(cacheDir.exists());
        assertFalse(new File(cacheDir, "http-entry").exists());
        assertTrue(codeCacheDir.exists());
        assertFalse(new File(codeCacheDir, "v8-bytecode").exists());
        assertFalse(httpCache.exists());
        assertFalse(jsCache.exists());
        assertFalse(gpuCache.exists());
        assertFalse(swCache.exists());

        // Login cookies, settings, IndexedDB, and saved audio files must remain intact
        assertTrue(cookies.exists());
        assertTrue(new File(localStorage, "sample").exists());
        assertTrue(new File(indexedDb, "sample").exists());
        assertTrue(new File(savedSongs, "sample").exists());
    }
}
