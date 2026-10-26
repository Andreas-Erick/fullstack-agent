package com.nexusagent.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * App settings. The device token is encrypted with a key that lives in the Android Keystore and
 * never leaves the phone; backups are off (allowBackup=false), so it is never copied elsewhere.
 */
final class Prefs {
    private static final String FILE = "nexus";
    private static final String KEY_ALIAS = "nexus-device-token";

    private Prefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** The desktop's address as an origin (scheme://host[:port]), or null if not set up yet. */
    static String server(Context c) {
        return sp(c).getString("server", null);
    }

    static void setServer(Context c, String origin) {
        sp(c).edit().putString("server", origin).apply();
    }

    /** Normalizes what the user typed to an http(s) origin, or returns null if it isn't one. */
    static String toOrigin(String typed) {
        String s = typed == null ? "" : typed.trim();
        if (s.isEmpty()) return null;
        if (!s.matches("(?i)^https?://.*")) s = "https://" + s;
        Uri u = Uri.parse(s);
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        String host = u.getHost();
        if (!(scheme.equals("https") || scheme.equals("http")) || host == null || host.isEmpty()) return null;
        return scheme + "://" + host.toLowerCase() + (u.getPort() > 0 ? ":" + u.getPort() : "");
    }

    static String originOf(String url) {
        if (url == null) return "";
        Uri u = Uri.parse(url);
        if (u.getScheme() == null || u.getHost() == null) return "";
        return u.getScheme().toLowerCase() + "://" + u.getHost().toLowerCase() + (u.getPort() > 0 ? ":" + u.getPort() : "");
    }

    static String deviceName(Context c) {
        return sp(c).getString("deviceName", "");
    }

    /** The conversation the watch talks in (its own, so a quick question doesn't land in a long chat). */
    /** The ETag of the face pack last sent to the watch (WearRelayService.face). */
    static String faceEtag(Context c) {
        return sp(c).getString("faceEtag", null);
    }

    static void setFaceEtag(Context c, String etag) {
        if (etag == null) sp(c).edit().remove("faceEtag").apply();
        else sp(c).edit().putString("faceEtag", etag).apply();
    }

    static String watchConversation(Context c) {
        return sp(c).getString("watchConversation", null);
    }

    static void setWatchConversation(Context c, String id) {
        if (id == null) sp(c).edit().remove("watchConversation").apply();
        else sp(c).edit().putString("watchConversation", id).apply();
    }

    static boolean background(Context c) {
        return sp(c).getBoolean("background", false);
    }

    static void setBackground(Context c, boolean on) {
        sp(c).edit().putBoolean("background", on).apply();
    }

    /** The app lock (AppLock): the phone's unlock before the conversations show. */
    static boolean appLock(Context c) {
        return sp(c).getBoolean("appLock", false);
    }

    static void setAppLock(Context c, boolean on) {
        sp(c).edit().putBoolean("appLock", on).apply();
    }

    static String token(Context c) {
        String stored = sp(c).getString("token", null);
        if (stored == null) return null;
        try {
            String[] parts = stored.split(":");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null; // key gone (e.g. app data restored elsewhere): pair again
        }
    }

    static void setToken(Context c, String token, String deviceName) {
        SharedPreferences.Editor e = sp(c).edit();
        if (token == null || token.isEmpty()) {
            e.remove("token").remove("deviceName").apply();
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            String enc = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":"
                    + Base64.encodeToString(cipher.doFinal(token.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            e.putString("token", enc).putString("deviceName", deviceName == null ? "" : deviceName).apply();
        } catch (Exception ex) {
            e.remove("token").apply();
        }
    }

    /** Forgets the address and the token (the user chose "Change address" or was unpaired). */
    static void reset(Context c) {
        sp(c).edit().clear().apply();
        // Unpaired: the watch forgets the persona's look and face too (WearRelayService.face).
        try {
            com.google.android.gms.wearable.DataClient data = com.google.android.gms.wearable.Wearable.getDataClient(c);
            data.deleteDataItems(android.net.Uri.parse("wear://*/siren/look"));
            data.deleteDataItems(android.net.Uri.parse("wear://*/siren/face"));
        } catch (Exception ignored) {
            // no Google Play services: there is no watch either
        }
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build());
        return gen.generateKey();
    }
}
