package com.nexusagent.android;

import android.content.Context;
import android.util.Log;

import com.google.android.gms.tasks.Tasks;
import com.google.android.gms.wearable.Asset;
import com.google.android.gms.wearable.ChannelClient;
import com.google.android.gms.wearable.MessageEvent;
import com.google.android.gms.wearable.PutDataMapRequest;
import com.google.android.gms.wearable.Wearable;
import com.google.android.gms.wearable.WearableListenerService;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;

/**
 * The phone's side of the Galaxy Watch app (android/wear): the watch can't reach the computer by
 * itself (no Tailscale on a watch), so it asks this phone over Bluetooth (Google's Wear Data Layer)
 * and the phone forwards each request to the desktop with its own pairing, like the phone app does.
 *
 * Messages from the watch (path, JSON body):
 *   /siren/ask   {id, text}           → a turn in the watch's conversation, spoken style; answers
 *                                        /siren/reply {id, text} or {id, error} when it is done
 *   /siren/today {}                   → /siren/today with the desktop's /api/data/today
 *   /siren/habit {name, done}         → checks a habit off; answers /siren/today
 *   /siren/new   {}                   → the next question starts a new conversation
 *   /siren/face  {}                   → the persona's look for the watch: data items /siren/look
 *                                        {name, colors} and /siren/face {pack, etag} (the face recorded
 *                                        as loops on the desktop, main/facecapture.js); answers /siren/face
 *   /siren/speak {id, text}           → the reply in the persona's voice (/api/speak), sent to the watch
 *                                        over a channel /siren/voice/<id>; answers /siren/speak {id}, or
 *                                        status "novoice" when the computer has no voice on (the watch
 *                                        then uses its own)
 * Every answer also carries "status": ok | unpaired | offline, so the watch can say what to do.
 * Only the watch app with this app's package name and signing key can send these (Data Layer rule);
 * still, each message is size-checked and the watch is held to a request rate.
 */
public class WearRelayService extends WearableListenerService {
    private static final long TURN_TIMEOUT_MS = 180_000;
    private static final int MAX_MESSAGE = 16 * 1024;
    private static final int MAX_TEXT = 4000;
    private static final int PER_MINUTE = 30;
    private static final int MAX_PACK = 8 * 1024 * 1024;
    private static final int MAX_AUDIO = 12 * 1024 * 1024;
    private static final ArrayDeque<Long> recent = new ArrayDeque<>();

    /** At most PER_MINUTE requests a minute from the watch (a stuck loop can't flood the computer). */
    private static synchronized boolean underLimit() {
        long now = System.currentTimeMillis();
        while (!recent.isEmpty() && now - recent.peekFirst() > 60_000) recent.pollFirst();
        if (recent.size() >= PER_MINUTE) return false;
        recent.addLast(now);
        return true;
    }

    @Override
    public void onMessageReceived(MessageEvent ev) {
        String path = ev.getPath();
        String node = ev.getSourceNodeId();
        if (ev.getData() == null || ev.getData().length > MAX_MESSAGE || !path.startsWith("/siren/")) return;
        if (!underLimit()) {
            reply(node, replyPath(path), put(new JSONObject(), "error", "Too many requests from the watch; wait a minute"), "offline");
            return;
        }
        JSONObject in;
        try {
            in = new JSONObject(new String(ev.getData(), StandardCharsets.UTF_8));
        } catch (Exception e) {
            in = new JSONObject();
        }
        final JSONObject body = in;
        // The listener runs on the main thread; network work goes to a thread of its own.
        new Thread(() -> handle(path, node, body), "siren-wear").start();
    }

    private void handle(String path, String node, JSONObject in) {
        String server = Prefs.server(this);
        String token = Prefs.token(this);
        if (server == null || token == null) {
            reply(node, replyPath(path), put(new JSONObject(), "id", in.optString("id")), "unpaired");
            return;
        }
        try {
            switch (path) {
                case "/siren/ask":
                    reply(node, "/siren/reply", ask(server, token, in), "ok");
                    break;
                case "/siren/today":
                    reply(node, "/siren/today", get(server + "/api/data/today", token), "ok");
                    break;
                case "/siren/habit":
                    post(server + "/api/data/habits/log", token, new JSONObject().put("name", in.optString("name")).put("done", in.optBoolean("done", true)));
                    reply(node, "/siren/today", get(server + "/api/data/today", token), "ok");
                    break;
                case "/siren/new":
                    Prefs.setWatchConversation(this, null);
                    reply(node, "/siren/new", new JSONObject(), "ok");
                    break;
                case "/siren/face":
                    reply(node, "/siren/face", face(this, server, token), "ok");
                    break;
                case "/siren/speak":
                    speak(server, token, node, in);
                    break;
                default:
                    break;
            }
        } catch (Unpaired e) {
            reply(node, replyPath(path), put(new JSONObject(), "id", in.optString("id")), "unpaired");
        } catch (Exception e) {
            Log.w("SirenRelay", path + " failed", e); // no message contents: just the path and the error
            JSONObject out = put(new JSONObject(), "id", in.optString("id"));
            put(out, "error", e.getMessage() == null ? "No connection to the computer" : e.getMessage());
            reply(node, replyPath(path), out, "offline");
        }
    }

    private static String replyPath(String path) {
        return path.equals("/siren/ask") ? "/siren/reply" : path;
    }

    /**
     * The persona's name and colors, and the face recorded on the desktop, as data items the watch keeps
     * (so they show at once next time, even without the phone). The pack is fetched again only when the
     * desktop's face, theme or name changed (ETag).
     */
    static JSONObject face(Context ctx, String server, String token) throws Exception {
        JSONObject info = get(server + "/api/info", token);
        PutDataMapRequest look = PutDataMapRequest.create("/siren/look");
        look.getDataMap().putString("name", info.optString("name", "Siren"));
        JSONObject colors = info.optJSONObject("colors");
        look.getDataMap().putString("colors", colors == null ? "{}" : colors.toString());
        Tasks.await(Wearable.getDataClient(ctx).putDataItem(look.asPutDataRequest().setUrgent()));

        HttpURLConnection c = ConnectionService.open(server + "/api/face/frames", token);
        c.setRequestProperty("Accept", "application/octet-stream");
        c.setReadTimeout(90_000); // a new face is recorded first (about half a minute)
        String etag = Prefs.faceEtag(ctx);
        if (etag != null) c.setRequestProperty("If-None-Match", etag);
        try {
            int code = c.getResponseCode();
            if (code == 401) throw new Unpaired();
            if (code == 304) return new JSONObject().put("changed", false);
            if (code != 200) throw new Exception("The computer answered " + code);
            byte[] pack = readAll(c.getInputStream(), MAX_PACK);
            PutDataMapRequest face = PutDataMapRequest.create("/siren/face");
            face.getDataMap().putAsset("pack", Asset.createFromBytes(pack));
            String tag = c.getHeaderField("ETag");
            face.getDataMap().putString("etag", tag == null ? "" : tag);
            Tasks.await(Wearable.getDataClient(ctx).putDataItem(face.asPutDataRequest().setUrgent()));
            Prefs.setFaceEtag(ctx, tag);
            Log.i("SirenRelay", "face sent to the watch: " + pack.length + " bytes");
            return new JSONObject().put("changed", true);
        } finally {
            c.disconnect();
        }
    }

    private static volatile long lastLookRefresh;

    /**
     * The persona, its theme or its face changed on the computer (the "info.changed" event): a watch that
     * has shown her face before gets the new look and face now, not only when it next asks. The data
     * items reach the watch whenever it is connected, so this is cheap to call; it is throttled anyway.
     */
    static void refreshLook(Context c) {
        if (Prefs.faceEtag(c) == null) return; // no watch has ever asked for her face
        long now = System.currentTimeMillis();
        if (now - lastLookRefresh < 5_000) return;
        lastLookRefresh = now;
        String server = Prefs.server(c);
        String token = Prefs.token(c);
        if (server == null || token == null) return;
        Context app = c.getApplicationContext();
        new Thread(() -> {
            try {
                face(app, server, token);
            } catch (Exception e) {
                Log.w("SirenRelay", "sending the new look to the watch failed", e);
            }
        }, "siren-look").start();
    }

    /** The reply in the persona's voice: the audio goes to the watch over a channel of its own. */
    private void speak(String server, String token, String node, JSONObject in) throws Exception {
        String id = in.optString("id").replaceAll("[^A-Za-z0-9-]", "");
        String text = in.optString("text").trim();
        if (text.length() > MAX_TEXT) text = text.substring(0, MAX_TEXT);
        if (id.isEmpty() || text.isEmpty() || !get(server + "/api/info", token).optBoolean("voice")) {
            reply(node, "/siren/speak", put(new JSONObject(), "id", id), "novoice");
            return;
        }
        HttpURLConnection c = ConnectionService.open(server + "/api/speak", token);
        c.setRequestMethod("POST");
        c.setRequestProperty("Accept", "audio/*");
        c.setRequestProperty("Content-Type", "application/json");
        c.setReadTimeout(90_000);
        c.setDoOutput(true);
        byte[] audio;
        try {
            try (OutputStream o = c.getOutputStream()) {
                o.write(new JSONObject().put("text", text).toString().getBytes(StandardCharsets.UTF_8));
            }
            int code = c.getResponseCode();
            if (code == 401) throw new Unpaired();
            if (code != 200) {
                reply(node, "/siren/speak", put(new JSONObject(), "id", id), "novoice");
                return;
            }
            audio = readAll(c.getInputStream(), MAX_AUDIO);
        } finally {
            c.disconnect();
        }
        ChannelClient channels = Wearable.getChannelClient(this);
        ChannelClient.Channel ch = Tasks.await(channels.openChannel(node, "/siren/voice/" + id));
        try (OutputStream o = Tasks.await(channels.getOutputStream(ch))) {
            o.write(audio);
        } finally {
            channels.close(ch);
        }
        reply(node, "/siren/speak", put(new JSONObject(), "id", id), "ok");
    }

    private static byte[] readAll(InputStream in, int max) throws Exception {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = s.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > max) throw new Exception("Too large");
            }
            return out.toByteArray();
        }
    }

    /**
     * One turn: listen to the desktop's event stream first (so the reply can't be missed), send the
     * question, then wait for that turn's "done" (or "error") event.
     */
    private JSONObject ask(String server, String token, JSONObject in) throws Exception {
        String text = in.optString("text").trim();
        if (text.isEmpty()) throw new Exception("Nothing was heard");
        if (text.length() > MAX_TEXT) text = text.substring(0, MAX_TEXT);
        HttpURLConnection events = ConnectionService.open(server + "/api/events", token);
        events.setReadTimeout(60_000);
        try {
            int code = events.getResponseCode();
            if (code == 401) throw new Unpaired();
            if (code != 200) throw new Exception("The computer answered " + code);
            JSONObject req = new JSONObject().put("text", text).put("voice", true).put("via", "watch");
            String conv = Prefs.watchConversation(this);
            if (conv != null) req.put("conversationId", conv);
            JSONObject started;
            try {
                started = post(server + "/api/chat", token, req);
            } catch (NotFound e) {
                // The watch's conversation was deleted on the computer: start a new one.
                req.remove("conversationId");
                started = post(server + "/api/chat", token, req);
            }
            Prefs.setWatchConversation(this, started.optString("conversationId", null));
            String requestId = started.optString("requestId");
            long until = System.currentTimeMillis() + TURN_TIMEOUT_MS;
            try (BufferedReader r = new BufferedReader(new InputStreamReader(events.getInputStream(), StandardCharsets.UTF_8))) {
                String event = "message";
                StringBuilder data = new StringBuilder();
                String line;
                while (System.currentTimeMillis() < until && (line = r.readLine()) != null) {
                    if (line.isEmpty()) {
                        if (event.equals("chat.event") && data.length() > 0) {
                            JSONObject ev = new JSONObject(data.toString());
                            if (requestId.equals(ev.optString("requestId"))) {
                                String type = ev.optString("type");
                                if (type.equals("done")) {
                                    JSONObject m = ev.optJSONObject("message");
                                    return new JSONObject().put("id", in.optString("id")).put("text", m == null ? "" : plain(m.optString("content")));
                                }
                                if (type.equals("error") || type.equals("aborted")) throw new Exception(ev.optString("message", "The reply was stopped"));
                            }
                        }
                        event = "message";
                        data.setLength(0);
                    } else if (line.startsWith("event: ")) event = line.substring(7);
                    else if (line.startsWith("data: ")) data.append(line.substring(6));
                }
            }
            throw new Exception("No reply within three minutes");
        } finally {
            events.disconnect();
        }
    }

    // ------------------------------------------------------------ HTTP
    private static JSONObject get(String url, String token) throws Exception {
        HttpURLConnection c = ConnectionService.open(url, token);
        c.setRequestProperty("Accept", "application/json");
        c.setReadTimeout(20_000);
        return read(c);
    }

    private static JSONObject post(String url, String token, JSONObject body) throws Exception {
        HttpURLConnection c = ConnectionService.open(url, token);
        c.setRequestMethod("POST");
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("Content-Type", "application/json");
        c.setReadTimeout(20_000);
        c.setDoOutput(true);
        try (OutputStream o = c.getOutputStream()) {
            o.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        return read(c);
    }

    private static JSONObject read(HttpURLConnection c) throws Exception {
        try {
            int code = c.getResponseCode();
            if (code == 401) throw new Unpaired();
            if (code == 404) throw new NotFound();
            boolean ok = code >= 200 && code < 300;
            StringBuilder s = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(ok ? c.getInputStream() : c.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) s.append(line);
            }
            JSONObject j = s.length() > 0 ? new JSONObject(s.toString()) : new JSONObject();
            if (!ok) throw new Exception(j.optString("error", "The computer answered " + code));
            return j;
        } finally {
            c.disconnect();
        }
    }

    // ------------------------------------------------------------ to the watch
    private void reply(String node, String path, JSONObject body, String status) {
        put(body, "status", status);
        Wearable.getMessageClient(this).sendMessage(node, path, body.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static JSONObject put(JSONObject o, String k, Object v) {
        try {
            o.put(k, v);
        } catch (Exception ignored) {
            // keys are fixed strings
        }
        return o;
    }

    /** Markdown to plain text for the watch's small screen and its voice. */
    static String plain(String md) {
        return md.replaceAll("```[\\s\\S]*?```", " ")
                .replaceAll("`([^`]+)`", "$1")
                .replaceAll("\\[([^\\]]+)\\]\\([^)]*\\)", "$1")
                .replaceAll("(?m)^>.*$", "")
                .replaceAll("[*_~#|]+", "")
                .replaceAll("[ \\t]+", " ")
                .replaceAll("\\n{3,}", "\n\n")
                .trim();
    }

    private static final class Unpaired extends Exception {}

    private static final class NotFound extends Exception {}
}
