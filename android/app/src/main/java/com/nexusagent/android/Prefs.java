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
 * never leaves the phone, and it is sent only to the computer that issued it (tokenFor). Cloud backups
 * and transfers to a new phone carry none of the app's data (allowBackup=false, dataExtractionRules).
 * The page also keeps a copy of the token in the WebView's storage, until a later version moves it.
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

    /** The token, only for the computer it was issued for; a token from before 2.7.25 adopts the current address once. */
    static String tokenFor(Context c) {
        String server = server(c);
        if (server == null) return null;
        String bound = sp(c).getString("tokenOrigin", null);
        if (bound == null && sp(c).contains("token")) sp(c).edit().putString("tokenOrigin", bound = server).apply();
        return server.equals(bound) ? token(c) : null;
    }

    /** Stores the token for the computer at the current address (tokenFor); null forgets it. */
    static void setToken(Context c, String token, String deviceName) {
        SharedPreferences.Editor e = sp(c).edit();
        if (token == null || token.isEmpty()) {
            e.remove("token").remove("tokenOrigin").remove("deviceName").apply();
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            String enc = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":"
                    + Base64.encodeToString(cipher.doFinal(token.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            e.putString("token", enc).putString("tokenOrigin", server(c)).putString("deviceName", deviceName == null ? "" : deviceName).apply();
        } catch (Exception ex) {
            e.remove("token").remove("tokenOrigin").apply();
        }
    }

    /**
     * The per-install secret a push-to-talk intent must carry (MainActivity.handleIntent): MainActivity is
     * exported, so without it any app on the phone could start the microphone. Only this app's own senders
     * (TalkTileService, TalkActivity behind the launcher shortcut) know it. Made on first use.
     */
    static synchronized String talkSecret(Context c) {
        String s = sp(c).getString("talkSecret", null);
        if (s != null && s.length() >= 32) return s;
        byte[] b = new byte[24];
        new java.security.SecureRandom().nextBytes(b);
        s = Base64.encodeToString(b, Base64.NO_WRAP | Base64.URL_SAFE | Base64.NO_PADDING);
        sp(c).edit().putString("talkSecret", s).commit();
        return s;
    }

    /** Whether a push-to-talk intent carries the secret (compared in constant time). */
    static boolean isTalkSecret(Context c, String given) {
        if (given == null) return false;
        return java.security.MessageDigest.isEqual(talkSecret(c).getBytes(StandardCharsets.UTF_8), given.getBytes(StandardCharsets.UTF_8));
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
